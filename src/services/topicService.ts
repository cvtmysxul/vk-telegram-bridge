import { config } from "../config.js";
import {
  countActivePeerTopics,
  getOldestActiveTopic,
  getTopicByPeer,
  insertTopic,
  isTopicInfoMessage,
  listTopicInfoMessages,
  markTopicDeleted,
  replaceTopicInfoMessages,
  touchTopic,
  updateTopicName,
  upsertVkPeer,
  type TopicInfoMessageKind,
  type TopicInfoMessageRecord
} from "../repositories.js";
import { TelegramClient } from "../telegram/client.js";
import { TelegramMessage, VkChatParticipant, VkPeerInfo } from "../types.js";
import { normalizeTopicName, truncate } from "../util.js";
import { VkClient } from "../vk/client.js";
import { LogService } from "./logService.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const PARTICIPANT_MESSAGE_BODY_LIMIT = 3_700;
const VK_METADATA_CONFIRMATION_SAMPLES = 5;

export class TopicService {
  private readonly managedInfoMessageKeys = new Set<string>();
  private readonly topicInfoLocks = new Map<number, Promise<void>>();
  private topicIconLookupFailed = false;

  constructor(
    private readonly telegram: TelegramClient,
    private readonly vk: VkClient,
    private readonly logs: LogService
  ) {}

  async getOrCreateTopic(peerId: number, allowAvatarRemoval = false): Promise<{ threadId: number; name: string }> {
    const existing = await getTopicByPeer(peerId);
    let peer: VkPeerInfo;
    try {
      peer = await this.loadStablePeerInfo(peerId, existing, allowAvatarRemoval);
    } catch (error) {
      if (!existing) throw error;
      await touchTopic(peerId);
      await this.logs.error(
        `Cannot verify VK metadata for peer ${peerId}; keeping existing Telegram topic metadata`,
        error
      );
      return { threadId: existing.message_thread_id, name: existing.name };
    }
    await upsertVkPeer(peer);

    const name = normalizeTopicName(peer.displayName);
    if (existing) {
      try {
        await this.syncForumTopic({
          peerId,
          threadId: existing.message_thread_id,
          currentName: existing.name,
          name
        });
      } catch (error) {
        if (!isTelegramTopicInvalid(error)) throw error;
        await this.markInvalidTopicAndLog(existing.message_thread_id, peerId);
        return this.createTopic(peer, name, await this.topicIconCustomEmojiId(peerId));
      }
      await this.syncManagedInfoSafely(peer, existing.message_thread_id, false);
      return { threadId: existing.message_thread_id, name };
    }

    return this.createTopic(peer, name, await this.topicIconCustomEmojiId(peerId));
  }

  async refreshTopicMetadata(
    peerId: number,
    refreshParticipants = false,
    allowAvatarRemoval = false
  ): Promise<void> {
    const existing = await getTopicByPeer(peerId);
    if (!existing) return;

    const peer = await this.loadStablePeerInfo(peerId, existing, allowAvatarRemoval);
    await upsertVkPeer(peer);
    const name = normalizeTopicName(peer.displayName);
    try {
      await this.syncForumTopic({
        peerId,
        threadId: existing.message_thread_id,
        currentName: existing.name,
        name
      });
    } catch (error) {
      if (!isTelegramTopicInvalid(error)) throw error;
      await this.markInvalidTopicAndLog(existing.message_thread_id, peerId);
      await this.createTopic(peer, name, await this.topicIconCustomEmojiId(peerId));
      return;
    }
    await this.syncManagedInfoSafely(peer, existing.message_thread_id, refreshParticipants && peer.isChat);
  }

  private async loadStablePeerInfo(
    peerId: number,
    existing:
      | {
          message_thread_id: number;
          name: string;
        }
      | undefined,
    allowAvatarRemoval: boolean
  ): Promise<VkPeerInfo> {
    const candidate = await this.vk.getPeerInfo(peerId);
    if (!existing) return candidate;

    const previous = await listTopicInfoMessages(peerId, "profile");
    const currentThreadMessages = previous.filter(
      (message) => message.telegramThreadId === existing.message_thread_id
    );
    if (
      !allowAvatarRemoval &&
      !candidate.avatarUrl &&
      currentThreadMessages.some((message) => topicInfoSnapshotHasAvatar(message.snapshot))
    ) {
      throw new Error(`VK omitted the existing avatar for peer ${peerId}`);
    }
    if (this.peerMetadataIsCurrent(candidate, existing, currentThreadMessages)) return candidate;

    let confirmation = candidate;
    for (let sample = 1; sample < VK_METADATA_CONFIRMATION_SAMPLES; sample += 1) {
      confirmation = await this.vk.getPeerInfo(peerId);
      if (!peerInfoMetadataEqual(candidate, confirmation)) {
        throw new Error(
          `VK returned inconsistent metadata for peer ${peerId} at sample ${sample + 1}/${VK_METADATA_CONFIRMATION_SAMPLES}`
        );
      }
    }
    return confirmation;
  }

  private peerMetadataIsCurrent(
    peer: VkPeerInfo,
    existing: { message_thread_id: number; name: string },
    currentThreadMessages: ReadonlyArray<TopicInfoMessageRecord>
  ): boolean {
    if (normalizeTopicName(peer.displayName) !== existing.name) return false;
    if (!currentThreadMessages.length) return true;

    const snapshot = peerProfileSnapshot(peer);
    return currentThreadMessages.some((message) => topicInfoSnapshotsEqual(message.snapshot, snapshot));
  }

  async isManagedTopicInfoMessage(telegramChatId: number, telegramMessageId: number): Promise<boolean> {
    const key = topicInfoMessageKey(telegramChatId, telegramMessageId);
    return this.managedInfoMessageKeys.has(key) || isTopicInfoMessage(telegramChatId, telegramMessageId);
  }

  private async createTopic(
    peer: VkPeerInfo,
    name: string,
    iconCustomEmojiId: string | undefined
  ): Promise<{ threadId: number; name: string }> {
    await this.ensureCapacity();
    const topic = await this.telegram.createForumTopic(name, iconCustomEmojiId || undefined);
    await insertTopic({
      peerId: peer.peerId,
      telegramChatId: this.telegram.chatId,
      threadId: topic.message_thread_id,
      name
    });
    await this.logs.info(`Created topic "${name}" for VK peer ${peer.peerId}`);
    await this.syncManagedInfoSafely(peer, topic.message_thread_id, peer.isChat);
    return { threadId: topic.message_thread_id, name };
  }

  private async markInvalidTopicAndLog(threadId: number, peerId: number): Promise<void> {
    await markTopicDeleted(this.telegram.chatId, threadId);
    await this.logs.info(`Recreating missing Telegram topic ${threadId} for VK peer ${peerId}`);
  }

  private async syncForumTopic(input: {
    peerId: number;
    threadId: number;
    currentName: string;
    name: string;
  }): Promise<void> {
    if (input.currentName !== input.name) await this.telegram.editForumTopic(input.threadId, input.name);
    if (input.currentName !== input.name) {
      await updateTopicName(input.peerId, input.name);
      await this.logs.info(`Renamed topic for VK peer ${input.peerId}: "${input.currentName}" -> "${input.name}"`);
    }
  }

  private async syncManagedInfoSafely(
    peer: VkPeerInfo,
    threadId: number,
    refreshParticipants: boolean
  ): Promise<void> {
    await this.withTopicInfoLock(peer.peerId, async () => {
      try {
        await this.syncProfileInfo(peer, threadId);
      } catch (error) {
        await this.logs.error(`Cannot update VK profile info in topic ${threadId}`, error);
      }

      if (!refreshParticipants) return;
      try {
        await this.syncParticipantInfo(peer, threadId);
      } catch (error) {
        await this.logs.error(`Cannot update VK chat participants in topic ${threadId}`, error);
      }
    });
  }

  private async syncProfileInfo(peer: VkPeerInfo, threadId: number): Promise<void> {
    const snapshot = peerProfileSnapshot(peer);
    await this.replaceInfoMessages({
      peer,
      threadId,
      kind: "profile",
      snapshot,
      expectedMessageCount: 1,
      send: () => this.sendProfileInfo(peer, threadId)
    });
  }

  private async syncParticipantInfo(peer: VkPeerInfo, threadId: number): Promise<void> {
    const participants = await this.vk.getChatParticipants(peer.peerId);
    const messages = participantInfoMessages(peer.displayName, participants);
    const snapshot = JSON.stringify(participants.map((participant) => [participant.id, participant.displayName]));
    await this.replaceInfoMessages({
      peer,
      threadId,
      kind: "participants",
      snapshot,
      expectedMessageCount: messages.length,
      send: () => this.sendParticipantInfo(messages, threadId)
    });
  }

  private async sendParticipantInfo(messages: string[], threadId: number): Promise<TelegramMessage[]> {
    const sent: TelegramMessage[] = [];
    for (const text of messages) {
      sent.push(
        await this.telegram.sendMessage({
          message_thread_id: threadId,
          text,
          disable_notification: true,
          link_preview_options: { is_disabled: true }
        })
      );
    }
    return sent;
  }

  private async replaceInfoMessages(input: {
    peer: VkPeerInfo;
    threadId: number;
    kind: TopicInfoMessageKind;
    snapshot: string;
    expectedMessageCount: number;
    send: () => Promise<TelegramMessage[]>;
  }): Promise<void> {
    const previous = await listTopicInfoMessages(input.peer.peerId, input.kind);
    const matchingMessageCount = countCurrentTopicInfoMessages(previous, {
      snapshot: input.snapshot,
      threadId: input.threadId
    });
    const isCurrent = hasCurrentTopicInfoMessages(matchingMessageCount, input.expectedMessageCount);
    if (isCurrent) return;

    await this.logs.info(
      `Refreshing ${input.kind} info pin for peer ${input.peer.peerId}: ${matchingMessageCount}/${input.expectedMessageCount} current records (${previous.length} stored)`
    );

    const sent = await input.send();
    const records = sent.map((message) => ({
      vkPeerId: input.peer.peerId,
      kind: input.kind,
      telegramChatId: message.chat.id,
      telegramMessageId: message.message_id,
      telegramThreadId: input.threadId,
      snapshot: input.snapshot
    }));
    try {
      for (const message of sent) {
        const key = topicInfoMessageKey(message.chat.id, message.message_id);
        this.managedInfoMessageKeys.add(key);
        await this.telegram.pinChatMessage(message.message_id);
      }
      await replaceTopicInfoMessages(input.peer.peerId, input.kind, records);
    } catch (error) {
      for (const message of sent) {
        await this.telegram.unpinChatMessage(message.message_id).catch(() => undefined);
        await this.telegram.deleteMessage(message.message_id, message.chat.id).catch(() => undefined);
      }
      throw error;
    }

    for (const message of previous) {
      this.managedInfoMessageKeys.add(
        topicInfoMessageKey(message.telegramChatId, message.telegramMessageId)
      );
      await this.telegram.unpinChatMessage(message.telegramMessageId).catch(() => undefined);
    }
    await this.logs.info(
      `Updated ${input.kind === "profile" ? "VK profile info" : "VK participant list"} pins for peer ${input.peer.peerId}`
    );
  }

  private async sendProfileInfo(peer: VkPeerInfo, threadId: number): Promise<TelegramMessage[]> {
    const text = truncate(
      `${peerTypeLabel(peer)}\nНазвание: ${peer.displayName}\nVK ID: ${peer.peerId}`,
      1_024
    );
    if (peer.avatarUrl) {
      return [
        await this.telegram.sendPhoto({
          message_thread_id: threadId,
          file: peer.avatarUrl,
          filename: "vk-avatar.jpg",
          caption: text,
          disable_notification: true
        })
      ];
    }

    return [
      await this.telegram.sendMessage({
        message_thread_id: threadId,
        text,
        disable_notification: true,
        link_preview_options: { is_disabled: true }
      })
    ];
  }

  private async withTopicInfoLock<T>(peerId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.topicInfoLocks.get(peerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => gate);
    this.topicInfoLocks.set(peerId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.topicInfoLocks.get(peerId) === current) this.topicInfoLocks.delete(peerId);
    }
  }

  private async topicIconCustomEmojiId(peerId: number): Promise<string | undefined> {
    const emoji = topicIconEmojiForPeer(peerId);
    if (!emoji) return "";

    try {
      return await this.telegram.getForumTopicIconCustomEmojiId(emoji);
    } catch (error) {
      if (!this.topicIconLookupFailed) {
        this.topicIconLookupFailed = true;
        await this.logs.info(`Telegram topic icon lookup failed, creating topics without custom icons: ${shortError(error)}`);
      }
      return undefined;
    }
  }

  private async ensureCapacity(): Promise<void> {
    const active = await countActivePeerTopics();
    if (active < config.telegram.maxActiveTopics) return;

    const oldest = await getOldestActiveTopic();
    if (!oldest) return;

    await this.telegram.deleteForumTopic(oldest.message_thread_id);
    await markTopicDeleted(this.telegram.chatId, oldest.message_thread_id);
    await this.logs.info(`Deleted oldest topic "${oldest.name}" for VK peer ${oldest.vk_peer_id}`);
  }
}

export function topicIconEmojiForPeer(peerId: number): string | undefined {
  if (peerId < 0) return "🤖";
  if (peerId > 2_000_000_000) return "💬";
  return undefined;
}

function peerTypeLabel(peer: VkPeerInfo): string {
  if (peer.isChat) return "VK-чат";
  return peer.peerId < 0 ? "Сообщество VK" : "Профиль VK";
}

function participantInfoMessages(title: string, participants: VkChatParticipant[]): string[] {
  if (!participants.length) return [`Участники VK-чата «${truncate(title, 200)}»: 0`];

  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const participant of participants) {
    const line = `• ${truncate(participant.displayName, 500)} — id${participant.id}`;
    if (current.length && currentLength + line.length + 1 > PARTICIPANT_MESSAGE_BODY_LIMIT) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += line.length + 1;
  }
  if (current.length) chunks.push(current);

  return chunks.map((lines, index) => {
    const part = chunks.length > 1 ? `, часть ${index + 1}/${chunks.length}` : "";
    const header = `Участники VK-чата «${truncate(title, 200)}» (${participants.length})${part}:`;
    return truncate(`${header}\n${lines.join("\n")}`, TELEGRAM_MESSAGE_LIMIT);
  });
}

function topicInfoMessageKey(telegramChatId: number, telegramMessageId: number): string {
  return `${telegramChatId}:${telegramMessageId}`;
}

function stableAvatarIdentity(avatarUrl: string | undefined): string | null {
  if (!avatarUrl) return null;
  try {
    return new URL(avatarUrl).pathname;
  } catch {
    return avatarUrl.split("?", 1)[0] || null;
  }
}

function peerProfileSnapshot(peer: VkPeerInfo): string {
  return JSON.stringify({
    type: peerTypeLabel(peer),
    displayName: peer.displayName,
    avatarUrl: stableAvatarIdentity(peer.avatarUrl)
  });
}

export function peerInfoMetadataEqual(left: VkPeerInfo, right: VkPeerInfo): boolean {
  return topicInfoSnapshotsEqual(peerProfileSnapshot(left), peerProfileSnapshot(right));
}

function topicInfoSnapshotHasAvatar(snapshot: string): boolean {
  try {
    const value = JSON.parse(snapshot) as Record<string, unknown>;
    return typeof value.avatarUrl === "string" && value.avatarUrl.length > 0;
  } catch {
    return false;
  }
}

function topicInfoSnapshotsEqual(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    const saved = JSON.parse(left) as Record<string, unknown>;
    const current = JSON.parse(right) as Record<string, unknown>;
    if (saved.type !== current.type || saved.displayName !== current.displayName) return false;
    if ("avatarUrl" in saved || "avatarUrl" in current) {
      return stableAvatarIdentity(stringOrUndefined(saved.avatarUrl)) === stableAvatarIdentity(stringOrUndefined(current.avatarUrl));
    }
  } catch {}
  return false;
}

export function countCurrentTopicInfoMessages(
  messages: ReadonlyArray<Pick<TopicInfoMessageRecord, "snapshot" | "telegramThreadId">>,
  expected: { snapshot: string; threadId: number }
): number {
  return messages.filter(
    (message) =>
      message.telegramThreadId === expected.threadId &&
      topicInfoSnapshotsEqual(message.snapshot, expected.snapshot)
  ).length;
}

export function hasCurrentTopicInfoMessages(currentMessageCount: number, expectedMessageCount: number): boolean {
  return currentMessageCount >= expectedMessageCount;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}

function isTelegramTopicInvalid(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TOPIC_ID_INVALID|message thread not found/i.test(message);
}
