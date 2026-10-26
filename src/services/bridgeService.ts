import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { config } from "../config.js";
import { getState, setState } from "../db.js";
import {
  appendVkMessageVersion,
  clearPin,
  deleteVkReactionSummary,
  findByTelegramMessage,
  findVkButtonAction,
  findByVkMessage,
  getPin,
  getVkReactionSummary,
  getVkMessageState,
  getTopicByPeer,
  getTopicByThread,
  listActiveTopics,
  listVkMessageStatesThrough,
  listVkMessageVersions,
  saveInitialVkMessageState,
  saveMessageMap,
  savePin,
  saveVkReactionSummary,
  saveVkButtonActions,
  setVkMessageDeleted,
  setVkMessageHistoryIds,
  setVkMessagePrimaryTelegramMessage,
  setVkMessageSourceSnapshot,
  updateMessageMapVkIds,
  VkMessageStateRecord
} from "../repositories.js";
import { TelegramClient } from "../telegram/client.js";
import {
  TelegramCallbackQuery,
  TelegramAudio,
  TelegramFileRef,
  TelegramForwardOrigin,
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramMessageReactionUpdated,
  TelegramReactionType,
  TelegramUpdate,
  VkAttachment,
  VkKeyboard,
  VkKeyboardButton,
  VkLongPollUpdate,
  VkMessage
} from "../types.js";
import {
  compactText,
  fetchWithTimeout,
  fileNameFromUrl,
  gunzipWithinLimit,
  isTransientHttpStatus,
  readResponseBodyWithinLimit,
  retryDelayMs,
  sleep,
  truncate
} from "../util.js";
import {
  isVkFloodControlError,
  isVkStickerUnavailableError,
  VkAttachmentPresentation,
  VkClient,
  VkReactedPeers
} from "../vk/client.js";
import { LogService } from "./logService.js";
import { StickerMapper } from "./stickerMapper.js";
import { TopicService } from "./topicService.js";

interface VkLongPollState {
  server?: string;
  key?: string;
  ts?: string | number;
  pts?: string | number;
}

interface VkLongPollCheck {
  failed?: 1 | 2 | 3 | 4;
  ts?: string | number;
  pts?: string | number;
  updates?: VkLongPollUpdate[];
}

interface TelegramVkAttachments {
  attachments: string[];
  fallbackTexts: string[];
  stickerIds: number[];
}

interface PreparedVkButtonAction {
  id: string;
  actionType: string;
  label: string;
  payload?: string;
  vkInline: boolean;
  vkAuthorId?: number;
}

interface PreparedVkKeyboard {
  replyMarkup: TelegramInlineKeyboardMarkup;
  actions: PreparedVkButtonAction[];
}

interface VkButtonEventResponse {
  owner_id: number;
  peer_id: number;
  event_id: string;
  action?: {
    type?: string;
    text?: string;
    link?: string;
    app_id?: number;
    owner_id?: number;
    hash?: string;
  };
}

const gzip = promisify(gzipCallback);
const DEFAULT_VK_REACTION_ID = 2;
const TELEGRAM_STICKER_FAILURE_REACTION = "👎";
const MAX_VK_FORWARDED_MESSAGES = 10;
const MAX_VK_FORWARD_DEPTH = 2;
const VK_REACTION_IDS_BY_TELEGRAM_EMOJI = new Map<string, number>([
  ["❤", 1],
  ["🔥", 2],
  ["😂", 3],
  ["👍", 4],
  ["💩", 5],
  ["❓", 6],
  ["😭", 7],
  ["😡", 8],
  ["👎", 9],
  ["👌", 10],
  ["😁", 11],
  ["🤔", 12],
  ["🙏", 13],
  ["😘", 14],
  ["😍", 15],
  ["🎉", 16]
]);
const VK_REACTION_EMOJI_BY_ID = new Map<number, string>([
  [1, "❤️"],
  [2, "🔥"],
  [3, "😂"],
  [4, "👍"],
  [5, "💩"],
  [6, "❓"],
  [7, "😭"],
  [8, "😡"],
  [9, "👎"],
  [10, "👌"],
  [11, "😁"],
  [12, "🤔"],
  [13, "🙏"],
  [14, "😘"],
  [15, "😍"],
  [16, "🎉"]
]);

export class BridgeService {
  private stopping = false;
  private readonly pendingVkButtonResponses = new Map<string, (response: VkButtonEventResponse) => void>();
  private readonly earlyVkButtonResponses = new Map<string, VkButtonEventResponse>();
  private readonly suppressedVkSystemActions = new Map<string, number[]>();
  private readonly suppressedVkEdits = new Map<string, number[]>();
  private readonly suppressedVkDeletions = new Map<string, number[]>();
  private readonly vkReactionRefreshes = new Map<string, Promise<void>>();
  private readonly unresolvedTelegramReplyLogs = new Map<string, number>();
  private readonly unavailableVkStickerIds = new Set<number>();
  constructor(
    private readonly telegram: TelegramClient,
    private readonly vk: VkClient,
    private readonly topics: TopicService,
    private readonly logs: LogService,
    private readonly stickers: StickerMapper
  ) {}

  async start(): Promise<void> {
    await this.logs.info("VK <-> Telegram bridge started");
    if (!config.telegram.reactionUserId) {
      await this.logs.info(
        "Telegram -> VK reaction sync disabled: TELEGRAM_REACTION_USER_ID is not configured"
      );
    }

    await Promise.all([
      this.superviseLoop("Telegram polling", () => this.runTelegramLoop()),
      this.superviseLoop("VK polling", () => this.runVkLoop()),
      this.superviseLoop("metadata refresh", () => this.runMetadataLoop())
    ]);
  }

  stop(): void {
    this.stopping = true;
  }

  async handleTelegramDeletedMessages(messageIds: number[]): Promise<void> {
    for (const telegramMessageId of [...new Set(messageIds)]) {
      const mapped = await findByTelegramMessage(this.telegram.chatId, telegramMessageId);
      if (!mapped || mapped.direction !== "tg_to_vk") continue;

      const peerId = optionalNumber(mapped.vk_peer_id);
      let vkMessageId = optionalNumber(mapped.vk_message_id);
      let conversationMessageId = optionalNumber(mapped.vk_conversation_message_id);
      if (!peerId) continue;

      if (!vkMessageId && conversationMessageId) {
        const recovered = await this.vk
          .getMessageByConversationMessageId(peerId, conversationMessageId)
          .catch(() => undefined);
        if (recovered) {
          vkMessageId = recovered.id;
          conversationMessageId = recovered.conversation_message_id ?? conversationMessageId;
          await updateMessageMapVkIds({
            telegramChatId: this.telegram.chatId,
            telegramMessageId,
            vkMessageId,
            vkConversationMessageId: conversationMessageId
          });
        }
      }

      if (!vkMessageId && !conversationMessageId) {
        await this.logs.error(`Cannot delete Telegram message ${telegramMessageId} in VK: mapping has no VK ids`);
        continue;
      }

      const suppressions = this.suppressVkDeletion(peerId, vkMessageId, conversationMessageId);
      try {
        const deleted = await this.vk.deleteMessage({ peerId, messageId: vkMessageId, conversationMessageId });
        if (!deleted) throw new Error("VK messages.delete returned false");
      } catch (error) {
        this.removeSuppressedVkDeletions(suppressions);
        await this.logs.error(`Cannot delete Telegram message ${telegramMessageId} in VK peer ${peerId}`, error);
        continue;
      }

      const state = await getVkMessageState({
        vkPeerId: peerId,
        vkMessageId,
        vkConversationMessageId: conversationMessageId
      });
      if (state) {
        await setVkMessageDeleted(state.id, true);
        for (const historyMessageId of state.historyMessageIds) {
          await this.telegram.deleteMessage(historyMessageId, state.telegramChatId).catch(() => undefined);
        }
      }
      if (conversationMessageId) {
        await this.removeVkReactionSummary(peerId, conversationMessageId);
      }
      await this.logs.info(`Deleted VK message ${vkMessageId ?? conversationMessageId} from Telegram message ${telegramMessageId}`);
    }
  }

  private async superviseLoop(name: string, run: () => Promise<void>): Promise<void> {
    let restarts = 0;
    while (!this.stopping) {
      try {
        await run();
        if (this.stopping) return;
        throw new Error(`${name} loop exited unexpectedly`);
      } catch (error) {
        restarts += 1;
        await this.logs.error(`${name} supervisor restarting loop (restart ${restarts})`, error);
        await sleep(retryDelayMs(restarts - 1, config.runtime.retryBaseMs));
      }
    }
  }

  private async runTelegramLoop(): Promise<void> {
    let offset = await this.loadTelegramOffset();
    let consecutiveFailures = 0;

    while (!this.stopping) {
      try {
        const updates = await this.telegram.getUpdates(offset, 25);
        consecutiveFailures = 0;
        for (const update of updates) {
          offset = update.update_id + 1;
          await this.handleTelegramUpdate(update).catch((error) =>
            this.logs.error(`Failed to handle Telegram update ${update.update_id}`, error)
          );
          await setState("telegram_update_offset", offset);
        }
      } catch (error) {
        consecutiveFailures += 1;
        await this.logs.error("Telegram polling failed", error);
        await sleep(retryDelayMs(consecutiveFailures - 1, config.runtime.retryBaseMs));
      }
    }
  }

  private async runVkLoop(): Promise<void> {
    let state = (await getState<VkLongPollState>("vk_long_poll")) ?? {};
    let consecutiveFailures = 0;

    while (!this.stopping) {
      try {
        state = await this.ensureVkLongPollState(state);
        const check = await this.checkVkLongPoll(state);

        if (check.failed) {
          state = await this.handleVkLongPollFailure(state, check);
          consecutiveFailures = 0;
          continue;
        }

        for (const update of check.updates ?? []) {
          await this.handleVkUpdate(update).catch((error) =>
            this.logs.error(`Failed to handle VK Long Poll update ${JSON.stringify(update)}`, error)
          );
        }

        state = {
          ...state,
          ts: check.ts ?? state.ts,
          pts: check.pts ?? state.pts
        };
        await setState("vk_long_poll", state);
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        await this.logs.error("VK polling failed", error);
        await sleep(
          isVkFloodControlError(error)
            ? retryDelayMs(
                consecutiveFailures - 1,
                config.runtime.vkFloodRetryBaseMs,
                config.runtime.vkFloodRetryMaxMs
              )
            : retryDelayMs(consecutiveFailures - 1, config.runtime.retryBaseMs)
        );
      }
    }
  }

  private async runMetadataLoop(): Promise<void> {
    while (!this.stopping) {
      await sleep(config.runtime.metadataRefreshMs);
      if (this.vk.floodCooldownRemainingMs() > 0) continue;
      try {
        const topics = await listActiveTopics();
        for (const topic of topics) {
          const peerId = Number(topic.vk_peer_id);
          try {
            await this.topics.refreshTopicMetadata(peerId);
          } catch (error) {
            await this.logs.error(`Metadata refresh failed for VK peer ${peerId}`, error);
            if (isVkFloodControlError(error)) break;
          }
        }
      } catch (error) {
        await this.logs.error("Metadata refresh failed", error);
      }
    }
  }

  private async handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message_reaction) {
      await this.handleTelegramReaction(update.message_reaction);
      return;
    }

    if (update.callback_query) {
      await this.handleTelegramCallbackQuery(update.callback_query);
      return;
    }

    if (update.message) {
      await this.handleTelegramMessage(update.message);
      return;
    }

    if (update.edited_message) {
      await this.handleTelegramEditedMessage(update.edited_message);
    }
  }

  private async handleTelegramReaction(update: TelegramMessageReactionUpdated): Promise<void> {
    if (update.chat.id !== this.telegram.chatId) return;
    if (!config.telegram.reactionUserId || update.user?.id !== config.telegram.reactionUserId) return;

    const mapped = await findByTelegramMessage(update.chat.id, update.message_id);
    if (!mapped) return;

    const peerId = optionalNumber(mapped.vk_peer_id);
    let conversationMessageId = optionalNumber(mapped.vk_conversation_message_id);
    const vkMessageId = optionalNumber(mapped.vk_message_id);
    if (!peerId) return;

    if (!conversationMessageId && vkMessageId) {
      const recovered = await this.vk.getMessageById(vkMessageId).catch(() => undefined);
      if (recovered?.peer_id === peerId && recovered.conversation_message_id) {
        conversationMessageId = recovered.conversation_message_id;
        await updateMessageMapVkIds({
          telegramChatId: update.chat.id,
          telegramMessageId: update.message_id,
          vkMessageId: recovered.id,
          vkConversationMessageId: conversationMessageId
        });
      }
    }

    if (!conversationMessageId) {
      await this.logs.error(
        `Cannot mirror Telegram reaction on message ${update.message_id}: VK mapping has no conversation_message_id`
      );
      return;
    }

    const reaction = selectedTelegramReaction(update.old_reaction, update.new_reaction);
    if (!reaction) {
      const deleted = await this.vk.deleteReaction(peerId, conversationMessageId);
      if (!deleted) throw new Error("VK messages.deleteReaction returned false");
      await this.logs.info(
        `Removed VK reaction from Telegram message ${update.message_id} in peer ${peerId}`
      );
    } else {
      const reactionId = vkReactionIdForTelegramReaction(reaction);
      const sent = await this.vk.sendReaction(peerId, conversationMessageId, reactionId);
      if (!sent) throw new Error("VK messages.sendReaction returned false");
      await this.logs.info(
        `Set VK reaction ${reactionId} from Telegram message ${update.message_id} in peer ${peerId}`
      );
    }

    await this.refreshVkReactionSummary(peerId, conversationMessageId);
  }

  private async refreshVkReactionSummary(peerId: number, conversationMessageId: number): Promise<void> {
    const key = `${peerId}:${conversationMessageId}`;
    const previous = this.vkReactionRefreshes.get(key) ?? Promise.resolve();
    const refresh = previous
      .catch(() => undefined)
      .then(() => this.performVkReactionSummaryRefresh(peerId, conversationMessageId));
    this.vkReactionRefreshes.set(key, refresh);
    try {
      await refresh;
    } finally {
      if (this.vkReactionRefreshes.get(key) === refresh) {
        this.vkReactionRefreshes.delete(key);
      }
    }
  }

  private async performVkReactionSummaryRefresh(peerId: number, conversationMessageId: number): Promise<void> {
    let target = await this.vkReactionSummaryTarget(peerId, conversationMessageId);
    if (!target) return;

    const reactions = await this.vk.getReactedPeers(peerId, conversationMessageId);
    if (vkReactionTotalCount(reactions) === 0) {
      await this.removeVkReactionSummary(peerId, conversationMessageId);
      return;
    }

    target = await this.vkReactionSummaryTarget(peerId, conversationMessageId);
    if (!target) return;

    const snapshot = vkReactionSnapshot(reactions);
    const existing = await getVkReactionSummary(peerId, conversationMessageId);
    const sameTarget =
      existing?.telegramChatId === target.telegramChatId &&
      existing.telegramMessageId === target.telegramMessageId &&
      existing.telegramThreadId === target.telegramThreadId;
    if (existing?.snapshot === snapshot && sameTarget) return;

    const text = vkReactionSummaryText(reactions);
    let summaryTelegramMessageId: number | undefined;
    if (existing && sameTarget) {
      try {
        await this.telegram.editMessageText(
          existing.summaryTelegramMessageId,
          text,
          existing.telegramChatId
        );
        summaryTelegramMessageId = existing.summaryTelegramMessageId;
      } catch (error) {
        await this.logs.info(
          `Cannot edit VK reaction summary ${existing.summaryTelegramMessageId}, replacing it: ${shortError(error)}`
        );
      }
    }

    if (!summaryTelegramMessageId) {
      if (existing) {
        await this.telegram
          .deleteMessage(existing.summaryTelegramMessageId, existing.telegramChatId)
          .catch(() => undefined);
      }
      const sent = await this.telegram.sendMessage({
        chat_id: target.telegramChatId,
        message_thread_id: target.telegramThreadId,
        text,
        reply_to_message_id: target.telegramMessageId,
        disable_notification: true
      });
      summaryTelegramMessageId = sent.message_id;
    }

    await saveVkReactionSummary({
      vkPeerId: peerId,
      vkConversationMessageId: conversationMessageId,
      telegramChatId: target.telegramChatId,
      telegramMessageId: target.telegramMessageId,
      telegramThreadId: target.telegramThreadId,
      summaryTelegramMessageId,
      snapshot
    });
  }

  private async vkReactionSummaryTarget(
    peerId: number,
    conversationMessageId: number
  ): Promise<
    | {
        telegramChatId: number;
        telegramMessageId: number;
        telegramThreadId: number;
      }
    | undefined
  > {
    const state = await getVkMessageState({
      vkPeerId: peerId,
      vkConversationMessageId: conversationMessageId
    });
    if (state?.deleted) {
      await this.removeVkReactionSummary(peerId, conversationMessageId);
      return undefined;
    }
    if (state) {
      return {
        telegramChatId: state.telegramChatId,
        telegramMessageId: state.telegramMessageId,
        telegramThreadId: state.telegramThreadId
      };
    }

    const mapped = await findByVkMessage(peerId, undefined, conversationMessageId);
    const telegramChatId = optionalNumber(mapped?.telegram_chat_id);
    const telegramMessageId = optionalNumber(mapped?.telegram_message_id);
    if (!mapped || !telegramChatId || !telegramMessageId) return undefined;
    return {
      telegramChatId,
      telegramMessageId,
      telegramThreadId: mapped.telegram_thread_id
    };
  }

  private async removeVkReactionSummary(peerId: number, conversationMessageId: number): Promise<void> {
    const existing = await getVkReactionSummary(peerId, conversationMessageId);
    if (existing) {
      await this.telegram
        .deleteMessage(existing.summaryTelegramMessageId, existing.telegramChatId)
        .catch(() => undefined);
    }
    await deleteVkReactionSummary(peerId, conversationMessageId);
  }

  private async handleTelegramEditedMessage(message: TelegramMessage): Promise<void> {
    if (message.chat.id !== this.telegram.chatId || message.from?.is_bot) return;
    if (this.isGeneralTopicMessage(message) || !message.message_thread_id) return;

    const topic = await getTopicByThread(message.chat.id, message.message_thread_id);
    if (!topic) {
      await this.logs.info(`Telegram edit ${message.message_id} ignored: topic is not mapped`);
      return;
    }

    const mapped = await findByTelegramMessage(message.chat.id, message.message_id);
    if (!mapped) {
      await this.logs.error(`Cannot edit Telegram message ${message.message_id} in VK: no message mapping`);
      return;
    }
    if (mapped.direction !== "tg_to_vk") {
      await this.logs.info(`Telegram edit ${message.message_id} ignored: mapped message originated in VK`);
      return;
    }

    const peerId = Number(topic.vk_peer_id);
    if (optionalNumber(mapped.vk_peer_id) !== peerId) {
      await this.logs.error(
        `Cannot edit Telegram message ${message.message_id}: mapped VK peer ${mapped.vk_peer_id} differs from topic peer ${peerId}`
      );
      return;
    }

    const target = await this.resolveTelegramEditTarget(peerId, message, mapped);
    if (!target) {
      await this.logs.error(`Cannot edit Telegram message ${message.message_id} in VK: VK message was not found`);
      return;
    }

    const text = this.formatTelegramText(message) ?? "";
    const attachments = this.vk.editableAttachmentIds(target);
    if (!text && !attachments.length) {
      await this.logs.error(`Cannot edit Telegram message ${message.message_id} in VK: message would be empty`);
      return;
    }

    if ((target.text ?? "") !== text) {
      const suppression = this.suppressVkEdit(peerId, target.id);
      try {
        const edited = await this.vk.editMessage({
          peerId,
          messageId: target.id,
          conversationMessageId: target.conversation_message_id,
          text,
          attachments
        });
        if (!edited) throw new Error(`VK messages.edit returned false for message ${target.id}`);
      } catch (error) {
        this.removeSuppressedVkEdit(peerId, target.id, suppression);
        throw error;
      }
    }

    await updateMessageMapVkIds({
      telegramChatId: message.chat.id,
      telegramMessageId: message.message_id,
      vkMessageId: target.id,
      vkConversationMessageId: target.conversation_message_id
    });

    const sourceSnapshot = vkMessageSourceSnapshot({ ...target, text });
    const canonicalText = this.formatTelegramTextFull(message) ?? telegramMessagePlaceholder(message);
    const state = await getVkMessageState({
      vkPeerId: peerId,
      vkMessageId: target.id,
      vkConversationMessageId: target.conversation_message_id
    });
    if (state) {
      if (state.currentText === canonicalText) {
        await setVkMessageSourceSnapshot(state.id, sourceSnapshot);
        return;
      }
      const updated = await appendVkMessageVersion(
        state.id,
        canonicalText,
        sourceSnapshot,
        message.edit_date ?? message.date
      );
      await this.syncVkMessageHistory(updated);
    } else {
      await saveInitialVkMessageState({
        vkPeerId: peerId,
        vkMessageId: target.id,
        vkConversationMessageId: target.conversation_message_id,
        telegramChatId: message.chat.id,
        telegramMessageId: message.message_id,
        telegramThreadId: message.message_thread_id,
        text: canonicalText,
        sourceSnapshot,
        vkDate: message.edit_date ?? message.date
      });
    }
    await this.logs.info(`Edited VK message ${target.id} from Telegram message ${message.message_id}`);
  }

  private async resolveTelegramEditTarget(
    peerId: number,
    message: TelegramMessage,
    mapped: NonNullable<Awaited<ReturnType<typeof findByTelegramMessage>>>
  ): Promise<VkMessage | undefined> {
    const vkMessageId = optionalNumber(mapped.vk_message_id);
    let target = vkMessageId ? await this.vk.getMessageById(vkMessageId).catch(() => undefined) : undefined;
    const conversationMessageId = optionalNumber(mapped.vk_conversation_message_id);
    if (!target && conversationMessageId) {
      target = await this.vk.getMessageByConversationMessageId(peerId, conversationMessageId).catch(() => undefined);
    }
    if (!target) {
      target = await this.vk.findRecentOutgoingMessage(peerId, { date: message.date }).catch(() => undefined);
    }
    if (!target || target.peer_id !== peerId || target.out === 0) return undefined;

    if (target.id !== vkMessageId || target.conversation_message_id !== conversationMessageId) {
      await updateMessageMapVkIds({
        telegramChatId: message.chat.id,
        telegramMessageId: message.message_id,
        vkMessageId: target.id,
        vkConversationMessageId: target.conversation_message_id
      });
      await this.logs.info(
        `Recovered VK edit target ${target.id}/${target.conversation_message_id ?? "?"} for Telegram message ${message.message_id}`
      );
    }
    return target;
  }

  private async handleTelegramCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const actionId = vkButtonActionId(query.data);
    const message = query.message;
    if (!actionId || !message || message.chat.id !== this.telegram.chatId) {
      await this.telegram.answerCallbackQuery(query.id, "Кнопка не принадлежит VK bridge", true);
      return;
    }

    const action = await findVkButtonAction(actionId);
    if (
      !action ||
      action.telegramChatId !== message.chat.id ||
      action.telegramMessageId !== message.message_id
    ) {
      await this.telegram.answerCallbackQuery(query.id, "Кнопка устарела или не найдена", true);
      return;
    }

    const topic = message.message_thread_id
      ? await getTopicByThread(message.chat.id, message.message_thread_id)
      : undefined;
    if (!topic || Number(topic.vk_peer_id) !== action.vkPeerId) {
      await this.telegram.answerCallbackQuery(query.id, "VK-диалог этой кнопки больше не привязан", true);
      return;
    }

    try {
      if (action.actionType === "text") {
        await this.vk.sendMessage({
          peerId: action.vkPeerId,
          text: action.label,
          payload: action.payload
        });
      } else if (action.actionType === "callback") {
        const eventId = await this.vk.sendMessageEvent({
          peerId: action.vkPeerId,
          payload: action.payload ?? "{}",
          messageId:
            action.vkInline && action.vkConversationMessageId === undefined ? action.vkMessageId : undefined,
          conversationMessageId: action.vkInline ? action.vkConversationMessageId : undefined,
          authorId: action.vkInline ? undefined : action.vkAuthorId
        });
        const response = await this.waitForVkButtonResponse(eventId);
        await this.answerVkButtonCallback(query, response);
        return;
      } else {
        await this.telegram.answerCallbackQuery(
          query.id,
          `VK-кнопка типа ${action.actionType} не может быть нажата из Telegram`,
          true
        );
        return;
      }

      await this.telegram.answerCallbackQuery(query.id, "Нажато в VK");
    } catch (error) {
      await this.telegram
        .answerCallbackQuery(query.id, `Ошибка VK: ${truncate(shortError(error), 160)}`, true)
        .catch(() => undefined);
      throw error;
    }
  }

  private async answerVkButtonCallback(
    query: TelegramCallbackQuery,
    response: VkButtonEventResponse | undefined
  ): Promise<void> {
    const action = response?.action;
    if (action?.type === "show_snackbar" && action.text) {
      await this.telegram.answerCallbackQuery(query.id, truncate(action.text, 200));
      return;
    }

    const url = vkButtonEventActionUrl(action);
    if (url && query.message?.message_thread_id) {
      await this.telegram.sendMessage({
        message_thread_id: query.message.message_thread_id,
        text: url,
        reply_to_message_id: query.message.message_id,
        link_preview_options: { is_disabled: false }
      });
      await this.telegram.answerCallbackQuery(query.id, "VK вернул ссылку");
      return;
    }

    await this.telegram.answerCallbackQuery(query.id, "Нажато в VK");
  }

  private waitForVkButtonResponse(eventId: string, timeoutMs = 8_000): Promise<VkButtonEventResponse | undefined> {
    const early = this.earlyVkButtonResponses.get(eventId);
    if (early) {
      this.earlyVkButtonResponses.delete(eventId);
      return Promise.resolve(early);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingVkButtonResponses.delete(eventId);
        resolve(undefined);
      }, timeoutMs);
      timeout.unref();

      this.pendingVkButtonResponses.set(eventId, (response) => {
        clearTimeout(timeout);
        this.pendingVkButtonResponses.delete(eventId);
        resolve(response);
      });
    });
  }

  private async handleTelegramMessage(message: TelegramMessage): Promise<void> {
    if (message.chat.id !== this.telegram.chatId) return;
    if (this.isGeneralTopicMessage(message)) return;

    if (message.pinned_message) {
      if (
        await this.topics.isManagedTopicInfoMessage(
          message.chat.id,
          message.pinned_message.message_id
        )
      ) {
        await this.logs.info(`Ignored bridge-managed info pin for Telegram message ${message.pinned_message.message_id}`);
        return;
      }
      if (message.from?.is_bot) return;
      await this.handleTelegramPin(message);
      return;
    }

    if (message.from?.is_bot) return;

    if (!message.message_thread_id) {
      return;
    }

    const topic = await getTopicByThread(message.chat.id, message.message_thread_id);
    if (!topic) {
      await this.logs.info(`Telegram message ${message.message_id} ignored: topic is not mapped`);
      return;
    }

    const peerId = Number(topic.vk_peer_id);
    const media = await this.telegramAttachmentsToVk(peerId, message);
    const text = compactText([this.formatTelegramText(message), ...media.fallbackTexts]) || undefined;
    if (message.sticker && media.stickerIds.length === 0) {
      await this.markTelegramStickerNotSent(message, "no VK mapping");
      return;
    }
    if (!text && media.attachments.length === 0 && media.stickerIds.length === 0) {
      const contentKinds = telegramContentKinds(message);
      await this.logs.info(
        `Telegram message ${message.message_id} ignored: no supported content (${contentKinds.join(", ") || "unknown"})`
      );
      return;
    }

    const replyToMessageId = await this.telegramReplyTarget(peerId, message);
    let sent: Awaited<ReturnType<VkClient["sendMessage"]>> | undefined;
    let sentStickerId: number | undefined;
    let sentText = text;
    let usedFallbackTexts = media.fallbackTexts;

    for (const stickerId of media.stickerIds) {
      if (this.unavailableVkStickerIds.has(stickerId)) continue;
      try {
        sent = await this.vk.sendMessage({
          peerId,
          text,
          attachments: media.attachments,
          stickerId,
          replyToMessageId
        });
        sentStickerId = stickerId;
        break;
      } catch (error) {
        if (!isVkStickerUnavailableError(error)) throw error;
        this.unavailableVkStickerIds.add(stickerId);
        await this.logs.info(`VK sticker ${stickerId} is unavailable to the current VK account; trying another mapping`);
      }
    }

    if (!sent) {
      if (message.sticker) {
        await this.markTelegramStickerNotSent(message, "no VK sticker is available to the current account");
        return;
      }
      sent = await this.vk.sendMessage({
        peerId,
        text: sentText,
        attachments: media.attachments,
        replyToMessageId
      });
    }

    if (sent.replyFallback) {
      await this.logs.info(
        `VK chat ${peerId} rejected reply for Telegram message ${message.message_id}; sent it as an ordinary message`
      );
    }

    await saveMessageMap({
      vkPeerId: peerId,
      vkMessageId: sent.message_id,
      vkConversationMessageId: sent.conversation_message_id,
      telegramChatId: message.chat.id,
      telegramMessageId: message.message_id,
      telegramThreadId: message.message_thread_id,
      direction: "tg_to_vk"
    });

    if (sent.message_id) {
      const savedVkMessage = await this.vk.getMessageById(sent.message_id).catch(() => undefined);
      await saveInitialVkMessageState({
        vkPeerId: peerId,
        vkMessageId: sent.message_id,
        vkConversationMessageId: sent.conversation_message_id,
        telegramChatId: message.chat.id,
        telegramMessageId: message.message_id,
        telegramThreadId: message.message_thread_id,
        text: compactText([this.formatTelegramTextFull(message), ...usedFallbackTexts]) || telegramMessagePlaceholder(message),
        sourceSnapshot: savedVkMessage
          ? vkMessageSourceSnapshot(savedVkMessage)
          : vkOutgoingMessageSourceSnapshot(sentText, media.attachments, sentStickerId),
        vkDate: message.date
      });
    }
  }

  private async markTelegramStickerNotSent(message: TelegramMessage, reason: string): Promise<void> {
    try {
      await this.telegram.setMessageReaction(
        message.message_id,
        { type: "emoji", emoji: TELEGRAM_STICKER_FAILURE_REACTION },
        message.chat.id
      );
      await this.logs.info(
        `Telegram sticker message ${message.message_id} was not sent to VK (${reason}); ` +
          `marked with ${TELEGRAM_STICKER_FAILURE_REACTION}`
      );
    } catch (error) {
      await this.logs.error(
        `Telegram sticker message ${message.message_id} was not sent to VK (${reason}); ` +
          `failed to set ${TELEGRAM_STICKER_FAILURE_REACTION} reaction`,
        error
      );
    }
  }

  private async handleTelegramPin(message: TelegramMessage): Promise<void> {
    if (
      message.pinned_message &&
      (await this.topics.isManagedTopicInfoMessage(message.chat.id, message.pinned_message.message_id))
    ) {
      return;
    }
    const threadId = message.pinned_message?.message_thread_id ?? message.message_thread_id;
    if (!threadId || threadId === 1) return;

    const topic = await getTopicByThread(message.chat.id, threadId);
    if (!topic || !message.pinned_message) return;

    const mapped = await findByTelegramMessage(message.chat.id, message.pinned_message.message_id);
    if (!mapped) {
      await this.logs.error(`Cannot pin Telegram message ${message.pinned_message.message_id}: no VK mapping`);
      return;
    }

    const topicPeerId = optionalNumber(topic.vk_peer_id);
    const mappedPeerId = optionalNumber(mapped.vk_peer_id);
    if (topicPeerId !== undefined && mappedPeerId !== undefined && topicPeerId !== mappedPeerId) {
      await this.logs.error(
        `Cannot pin Telegram message ${message.pinned_message.message_id}: topic peer ${topicPeerId} does not match mapped peer ${mappedPeerId}`
      );
      return;
    }

    const peerId = mappedPeerId ?? topicPeerId;
    if (!isValidVkPinPeerId(peerId)) {
      await this.logs.info(
        `Telegram pin ${message.pinned_message.message_id} skipped: VK messages.pin supports chats and communities only (peer=${peerId}, topic=${topic.vk_peer_id}, mapped=${mapped.vk_peer_id})`
      );
      return;
    }

    let vkMessageId = optionalNumber(mapped.vk_message_id);
    let conversationMessageId = optionalNumber(mapped.vk_conversation_message_id);
    if (!conversationMessageId) {
      const recovered = vkMessageId
        ? await this.vk.getMessageById(vkMessageId).catch(() => undefined)
        : await this.vk
            .findRecentOutgoingMessage(peerId, {
              date: message.pinned_message.date,
              text: this.formatTelegramText(message.pinned_message)
            })
            .catch(() => undefined);

      if (recovered?.peer_id === peerId && recovered.conversation_message_id) {
        vkMessageId = recovered.id;
        conversationMessageId = recovered.conversation_message_id;
        await updateMessageMapVkIds({
          telegramChatId: message.chat.id,
          telegramMessageId: message.pinned_message.message_id,
          vkMessageId,
          vkConversationMessageId: conversationMessageId
        });
        await this.logs.info(
          `Recovered VK mapping for Telegram message ${message.pinned_message.message_id}: message_id=${vkMessageId}, conversation_message_id=${conversationMessageId}`
        );
      }
    }

    if (!conversationMessageId) {
      await this.logs.error(
        `Cannot pin Telegram message ${message.pinned_message.message_id}: VK mapping has no conversation_message_id`
      );
      return;
    }

    this.suppressVkSystemAction(peerId, "chat_unpin_message");
    await this.vk.unpin(peerId).catch(() => undefined);
    try {
      this.suppressVkSystemAction(peerId, "chat_pin_message");
      await this.vk.pin(peerId, conversationMessageId);
    } catch (error) {
      await this.logs.error(
        `Cannot pin Telegram message ${message.pinned_message.message_id} in VK peer ${peerId} with conversation_message_id ${conversationMessageId}`,
        error
      );
      return;
    }
    await savePin({
      vkPeerId: peerId,
      vkMessageId,
      vkConversationMessageId: conversationMessageId,
      telegramChatId: message.chat.id,
      telegramMessageId: message.pinned_message.message_id,
      telegramThreadId: threadId
    });
    await this.logs.info(`Pinned VK message ${conversationMessageId} from Telegram topic ${threadId}`);
  }

  private async handleVkUpdate(update: VkLongPollUpdate): Promise<void> {
    if (!Array.isArray(update)) return;
    const type = Number(update[0]);
    if (type === 119) {
      this.handleVkButtonEventResponse(update);
      return;
    }

    if (type === 601) {
      const peerId = optionalNumber(update[2] as number | string | undefined);
      const conversationMessageId = optionalNumber(update[3] as number | string | undefined);
      if (peerId && conversationMessageId) {
        await this.refreshVkReactionSummary(peerId, conversationMessageId);
      }
      return;
    }

    if (type === 5 || type === 10005) {
      await this.handleVkEditUpdate(update, type === 10005);
      return;
    }

    if ((type === 2 || type === 10002) && hasVkMessageFlag(update[2], 128)) {
      await this.handleVkDeletedUpdate(update, type === 10002);
      return;
    }

    if ((type === 3 || type === 10003) && hasVkMessageFlag(update[2], 128)) {
      await this.handleVkRestoredUpdate(update, type === 10003);
      return;
    }

    if (type === 13 || type === 10013) {
      await this.handleVkBulkDeletedUpdate(update);
      return;
    }

    if (type !== 4 && type !== 10004) return;

    const messageId = Number(type === 10004 ? update[3] : update[1]);
    if (!Number.isFinite(messageId)) return;

    const message = await this.vk.getMessageById(messageId);
    if (!message) {
      await this.logs.error(`VK message ${messageId} was not found after Long Poll event`);
      return;
    }
    if (message.out === 1) {
      if (!message.action?.type) return;
      if (this.consumeSuppressedVkSystemAction(message.peer_id, message.action.type)) return;
    }

    // VK stores bottom keyboards on the conversation, independently of the message.
    // Only consult current state for new incoming messages, never history or edits.
    if (message.keyboard === undefined && !message.action) {
      try {
        const keyboard = await this.vk.getCurrentKeyboard(message.peer_id);
        const parsed = parseVkKeyboard(keyboard);
        if (
          parsed && parsed.inline !== true &&
          (parsed.author_id === undefined || parsed.author_id === message.from_id)
        ) {
          message.keyboard = keyboard;
        }
      } catch (error) {
        await this.logs.error(`Cannot load VK keyboard for peer ${message.peer_id}`, error);
      }
    }

    if (this.isVkPinAction(message)) {
      await this.handleVkPin(message);
      await this.forwardVkMessage(message);
      return;
    }

    if (this.isVkUnpinAction(message)) {
      await this.handleVkUnpin(message);
      await this.forwardVkMessage(message);
      return;
    }

    await this.forwardVkMessage(message);
    if (isTopicInfoRefreshAction(message)) {
      await this.topics.refreshTopicMetadata(
        message.peer_id,
        isVkParticipantChangeAction(message),
        message.action?.type === "chat_photo_remove"
      );
    }
  }

  private async handleVkEditUpdate(update: VkLongPollUpdate, modern: boolean): Promise<void> {
    const messageOrConversationId = optionalNumber(update[1] as number | string | undefined);
    const peerId = optionalNumber(update[3] as number | string | undefined);
    if (!messageOrConversationId || !peerId) return;

    const message = modern
      ? await this.vk.getMessageByConversationMessageId(peerId, messageOrConversationId)
      : await this.vk.getMessageById(messageOrConversationId);
    if (!message) {
      await this.logs.error(`Cannot load edited VK message ${peerId}/${messageOrConversationId}`);
      return;
    }
    if (this.consumeSuppressedVkEdit(message.peer_id, message.id)) return;

    let state = await getVkMessageState({
      vkPeerId: message.peer_id,
      vkMessageId: message.id,
      vkConversationMessageId: message.conversation_message_id
    });
    if (!state) {
      state = await this.bootstrapVkMessageState(
        message.peer_id,
        message.id,
        message.conversation_message_id,
        "[Previous version unavailable: tracking started after edit]",
        message.date
      );
    }
    if (!state) return;

    const senderName = await this.vkMessageSenderName(message);
    const currentText = (await this.formatVkText(message, senderName)) ?? vkMessagePlaceholder(message, senderName);
    const sourceSnapshot = vkMessageSourceSnapshot(message);
    if (state.sourceSnapshot === sourceSnapshot) return;
    const addedAttachments = addedVkAttachments(state.sourceSnapshot, message.attachments ?? []);
    if (addedAttachments.length) {
      await this.forwardEditedVkAttachments(message, state, addedAttachments);
    }
    const addedForwardedMessages = addedVkForwardedMessages(state.sourceSnapshot, message.fwd_messages ?? []);
    if (addedForwardedMessages.length) {
      await this.forwardEditedVkMessages(message, state, addedForwardedMessages);
    }
    if (state.currentText === currentText) {
      await setVkMessageSourceSnapshot(state.id, sourceSnapshot);
      return;
    }
    if (!state.sourceSnapshot && legacyVkStateMatchesCurrent(state.currentText, currentText, message.text, senderName)) {
      await setVkMessageSourceSnapshot(state.id, sourceSnapshot);
      return;
    }
    state = await appendVkMessageVersion(
      state.id,
      currentText,
      sourceSnapshot,
      message.update_time ?? Math.floor(Date.now() / 1000)
    );
    state = await this.syncTelegramMessageState(state);
    await this.syncVkMessageHistory(state);
  }

  private async handleVkDeletedUpdate(update: VkLongPollUpdate, modern: boolean): Promise<void> {
    const messageOrConversationId = optionalNumber(update[1] as number | string | undefined);
    const peerId = optionalNumber(update[3] as number | string | undefined);
    if (!messageOrConversationId || !peerId) return;
    if (this.consumeSuppressedVkDeletion(peerId, modern, messageOrConversationId)) return;
    let conversationMessageId = modern ? messageOrConversationId : undefined;
    if (!conversationMessageId) {
      const knownState = await getVkMessageState({
        vkPeerId: peerId,
        vkMessageId: messageOrConversationId
      });
      conversationMessageId = knownState?.vkConversationMessageId;
    }
    if (!conversationMessageId) {
      const mapped = await findByVkMessage(peerId, messageOrConversationId);
      conversationMessageId = optionalNumber(mapped?.vk_conversation_message_id);
    }
    const state = await this.findOrBootstrapVkMessageState({
      vkPeerId: peerId,
      vkMessageId: modern ? undefined : messageOrConversationId,
      vkConversationMessageId: modern ? messageOrConversationId : undefined,
      fallbackText: "[Original version unavailable: tracking started after deletion]"
    });
    if (state && !state.deleted) {
      await this.syncTelegramMessageState(await setVkMessageDeleted(state.id, true));
    }
    conversationMessageId ??= state?.vkConversationMessageId;
    if (conversationMessageId) {
      await this.removeVkReactionSummary(peerId, conversationMessageId);
    }
  }

  private async handleVkRestoredUpdate(update: VkLongPollUpdate, modern: boolean): Promise<void> {
    const messageOrConversationId = optionalNumber(update[1] as number | string | undefined);
    const peerId = optionalNumber(update[3] as number | string | undefined);
    if (!messageOrConversationId || !peerId) return;
    const state = await getVkMessageState({
      vkPeerId: peerId,
      vkMessageId: modern ? undefined : messageOrConversationId,
      vkConversationMessageId: modern ? messageOrConversationId : undefined
    });
    if (!state || !state.deleted) return;
    await this.syncTelegramMessageState(await setVkMessageDeleted(state.id, false));
  }

  private async handleVkBulkDeletedUpdate(update: VkLongPollUpdate): Promise<void> {
    const peerId = optionalNumber(update[1] as number | string | undefined);
    const lastConversationMessageId = optionalNumber(update[2] as number | string | undefined);
    if (!peerId || !lastConversationMessageId) return;

    const states = await listVkMessageStatesThrough(peerId, lastConversationMessageId);
    for (const state of states) {
      if (state.deleted) continue;
      await this.syncTelegramMessageState(await setVkMessageDeleted(state.id, true));
      if (state.vkConversationMessageId) {
        await this.removeVkReactionSummary(peerId, state.vkConversationMessageId);
      }
    }
  }

  private async findOrBootstrapVkMessageState(input: {
    vkPeerId: number;
    vkMessageId?: number;
    vkConversationMessageId?: number;
    fallbackText: string;
  }): Promise<VkMessageStateRecord | undefined> {
    const existing = await getVkMessageState(input);
    if (existing) return existing;

    const mapped = await findByVkMessage(input.vkPeerId, input.vkMessageId, input.vkConversationMessageId);
    const vkMessageId = input.vkMessageId ?? optionalNumber(mapped?.vk_message_id);
    if (!mapped || !vkMessageId) return undefined;
    return this.bootstrapVkMessageState(
      input.vkPeerId,
      vkMessageId,
      input.vkConversationMessageId ?? optionalNumber(mapped.vk_conversation_message_id),
      input.fallbackText
    );
  }

  private async bootstrapVkMessageState(
    vkPeerId: number,
    vkMessageId: number,
    vkConversationMessageId: number | undefined,
    text: string,
    vkDate?: number
  ): Promise<VkMessageStateRecord | undefined> {
    const mapped = await findByVkMessage(vkPeerId, vkMessageId, vkConversationMessageId);
    const telegramChatId = optionalNumber(mapped?.telegram_chat_id);
    const telegramMessageId = optionalNumber(mapped?.telegram_message_id);
    if (!mapped || !telegramChatId || !telegramMessageId) return undefined;
    return saveInitialVkMessageState({
      vkPeerId,
      vkMessageId,
      vkConversationMessageId,
      telegramChatId,
      telegramMessageId,
      telegramThreadId: mapped.telegram_thread_id,
      text,
      vkDate
    });
  }

  private async syncTelegramMessageState(state: VkMessageStateRecord): Promise<VkMessageStateRecord> {
    const text = telegramStateText(state.currentText, state.edited, state.deleted);
    try {
      await this.telegram.editMessageText(state.telegramMessageId, text, state.telegramChatId);
      return state;
    } catch (error) {
      await this.logs.info(
        `Cannot edit Telegram message ${state.telegramMessageId}, sending mutation marker as reply: ${shortError(error)}`
      );
    }

    const sent = await this.telegram.sendMessage({
      chat_id: state.telegramChatId,
      message_thread_id: state.telegramThreadId,
      text,
      reply_to_message_id: state.telegramMessageId,
      disable_notification: true
    });
    await setVkMessagePrimaryTelegramMessage(state.id, sent.message_id);
    await saveMessageMap({
      vkPeerId: state.vkPeerId,
      vkMessageId: state.vkMessageId,
      vkConversationMessageId: state.vkConversationMessageId,
      telegramChatId: sent.chat.id,
      telegramMessageId: sent.message_id,
      telegramThreadId: sent.message_thread_id ?? state.telegramThreadId,
      direction: "vk_to_tg"
    });
    return { ...state, telegramMessageId: sent.message_id };
  }

  private async syncVkMessageHistory(state: VkMessageStateRecord): Promise<void> {
    const versions = await listVkMessageVersions(state.id);
    if (versions.length < 2) return;
    const pages = vkVersionHistoryPages(versions);
    const ids = [...state.historyMessageIds];

    for (let index = 0; index < pages.length; index += 1) {
      const existingId = ids[index];
      if (existingId) {
        try {
          await this.telegram.editMessageText(existingId, pages[index]!, state.telegramChatId);
          continue;
        } catch (error) {
          await this.logs.info(`Cannot edit VK history page ${existingId}, replacing it: ${shortError(error)}`);
        }
      }

      const sent = await this.telegram.sendMessage({
        chat_id: state.telegramChatId,
        message_thread_id: state.telegramThreadId,
        text: pages[index]!,
        reply_to_message_id: state.telegramMessageId,
        disable_notification: true
      });
      ids[index] = sent.message_id;
    }
    await setVkMessageHistoryIds(state.id, ids);
  }

  private handleVkButtonEventResponse(update: VkLongPollUpdate): void {
    const response = update[1];
    if (!isVkButtonEventResponse(response)) return;

    const pending = this.pendingVkButtonResponses.get(response.event_id);
    if (pending) {
      pending(response);
      return;
    }

    this.earlyVkButtonResponses.set(response.event_id, response);
    const timeout = setTimeout(() => this.earlyVkButtonResponses.delete(response.event_id), 10_000);
    timeout.unref();
  }

  private suppressVkSystemAction(peerId: number, type: string): void {
    const key = `${peerId}:${type}`;
    const expiresAt = Date.now() + 15_000;
    const entries = this.suppressedVkSystemActions.get(key) ?? [];
    entries.push(expiresAt);
    this.suppressedVkSystemActions.set(key, entries);

    const timeout = setTimeout(() => this.pruneSuppressedVkSystemActions(key), 15_000);
    timeout.unref();
  }

  private consumeSuppressedVkSystemAction(peerId: number, type: string): boolean {
    const key = `${peerId}:${type}`;
    this.pruneSuppressedVkSystemActions(key);
    const entries = this.suppressedVkSystemActions.get(key);
    if (!entries?.length) return false;
    entries.shift();
    if (!entries.length) this.suppressedVkSystemActions.delete(key);
    return true;
  }

  private pruneSuppressedVkSystemActions(key: string): void {
    const entries = this.suppressedVkSystemActions.get(key);
    if (!entries) return;
    const active = entries.filter((expiresAt) => expiresAt > Date.now());
    if (active.length) this.suppressedVkSystemActions.set(key, active);
    else this.suppressedVkSystemActions.delete(key);
  }

  private suppressVkEdit(peerId: number, messageId: number): number {
    const key = `${peerId}:${messageId}`;
    const expiresAt = Date.now() + 15_000;
    const entries = this.suppressedVkEdits.get(key) ?? [];
    entries.push(expiresAt);
    this.suppressedVkEdits.set(key, entries);

    const timeout = setTimeout(() => this.pruneSuppressedVkEdits(key), 15_000);
    timeout.unref();
    return expiresAt;
  }

  private consumeSuppressedVkEdit(peerId: number, messageId: number): boolean {
    const key = `${peerId}:${messageId}`;
    this.pruneSuppressedVkEdits(key);
    const entries = this.suppressedVkEdits.get(key);
    if (!entries?.length) return false;
    entries.shift();
    if (!entries.length) this.suppressedVkEdits.delete(key);
    return true;
  }

  private removeSuppressedVkEdit(peerId: number, messageId: number, expiresAt: number): void {
    const key = `${peerId}:${messageId}`;
    const entries = this.suppressedVkEdits.get(key)?.filter((entry) => entry !== expiresAt) ?? [];
    if (entries.length) this.suppressedVkEdits.set(key, entries);
    else this.suppressedVkEdits.delete(key);
  }

  private pruneSuppressedVkEdits(key: string): void {
    const entries = this.suppressedVkEdits.get(key);
    if (!entries) return;
    const active = entries.filter((expiresAt) => expiresAt > Date.now());
    if (active.length) this.suppressedVkEdits.set(key, active);
    else this.suppressedVkEdits.delete(key);
  }

  private suppressVkDeletion(
    peerId: number,
    vkMessageId?: number,
    conversationMessageId?: number
  ): Array<{ key: string; expiresAt: number }> {
    const keys = [
      vkMessageId ? vkDeletionKey(peerId, false, vkMessageId) : undefined,
      conversationMessageId ? vkDeletionKey(peerId, true, conversationMessageId) : undefined
    ].filter((key): key is string => Boolean(key));

    return keys.map((key) => {
      const expiresAt = Date.now() + 15_000;
      const entries = this.suppressedVkDeletions.get(key) ?? [];
      entries.push(expiresAt);
      this.suppressedVkDeletions.set(key, entries);
      const timeout = setTimeout(() => this.pruneSuppressedVkDeletions(key), 15_000);
      timeout.unref();
      return { key, expiresAt };
    });
  }

  private consumeSuppressedVkDeletion(peerId: number, modern: boolean, messageId: number): boolean {
    const key = vkDeletionKey(peerId, modern, messageId);
    this.pruneSuppressedVkDeletions(key);
    const entries = this.suppressedVkDeletions.get(key);
    if (!entries?.length) return false;
    entries.shift();
    if (!entries.length) this.suppressedVkDeletions.delete(key);
    return true;
  }

  private removeSuppressedVkDeletions(suppressions: Array<{ key: string; expiresAt: number }>): void {
    for (const suppression of suppressions) {
      const entries = this.suppressedVkDeletions.get(suppression.key)?.filter(
        (expiresAt) => expiresAt !== suppression.expiresAt
      ) ?? [];
      if (entries.length) this.suppressedVkDeletions.set(suppression.key, entries);
      else this.suppressedVkDeletions.delete(suppression.key);
    }
  }

  private pruneSuppressedVkDeletions(key: string): void {
    const entries = this.suppressedVkDeletions.get(key);
    if (!entries) return;
    const active = entries.filter((expiresAt) => expiresAt > Date.now());
    if (active.length) this.suppressedVkDeletions.set(key, active);
    else this.suppressedVkDeletions.delete(key);
  }

  private async forwardVkMessage(message: VkMessage): Promise<void> {
    const topic = await this.topics.getOrCreateTopic(
      message.peer_id,
      message.action?.type === "chat_photo_remove"
    );
    const senderName = await this.vkMessageSenderName(message);
    const replyToMessageId = await this.vkReplyTarget(message);
    const text = await this.formatVkText(message, senderName);
    const keyboard = prepareVkKeyboard(message);
    const canonicalText = text ?? vkMessagePlaceholder(message, senderName, keyboard !== undefined);
    const hasStickerAttachment = message.attachments?.some((attachment) => attachment.type === "sticker") ?? false;
    const hasForwardedMessages = (message.fwd_messages?.length ?? 0) > 0;

    let sentAny = false;
    let primaryTelegramMessage: TelegramMessage | undefined;

    if (text || keyboard || (!hasStickerAttachment && !hasForwardedMessages)) {
      const sent = await this.telegram.sendMessage({
        message_thread_id: topic.threadId,
        text: truncate(canonicalText, 4096),
        reply_to_message_id: replyToMessageId,
        link_preview_options: { is_disabled: false },
        reply_markup: keyboard?.replyMarkup
      });
      await this.saveVkToTelegramMap(message, sent, topic.threadId);
      if (keyboard) await this.saveVkKeyboardActions(message, sent, keyboard);
      primaryTelegramMessage = sent;
      sentAny = true;
    }

    for (const attachment of message.attachments ?? []) {
      const attachmentMessages = await this.sendVkAttachmentToTelegram(attachment, {
        threadId: topic.threadId,
        replyToMessageId,
        fallbackCaption: sentAny ? undefined : senderName
      });
      for (const telegramMessage of attachmentMessages) {
        await this.saveVkToTelegramMap(message, telegramMessage, topic.threadId);
        primaryTelegramMessage ??= telegramMessage;
        sentAny = true;
      }
    }

    const forwardedMessages = await this.forwardVkMessagesToTelegram(message.fwd_messages ?? [], {
      threadId: topic.threadId,
      replyToMessageId: primaryTelegramMessage?.message_id ?? replyToMessageId,
      depth: 0
    });
    for (const telegramMessage of forwardedMessages) {
      await this.saveVkToTelegramMap(message, telegramMessage, topic.threadId);
      primaryTelegramMessage ??= telegramMessage;
      sentAny = true;
    }

    if (!primaryTelegramMessage) {
      primaryTelegramMessage = await this.telegram.sendMessage({
        message_thread_id: topic.threadId,
        text: truncate(canonicalText, 4096),
        reply_to_message_id: replyToMessageId,
        link_preview_options: { is_disabled: false },
        reply_markup: keyboard?.replyMarkup
      });
      await this.saveVkToTelegramMap(message, primaryTelegramMessage, topic.threadId);
      if (keyboard) await this.saveVkKeyboardActions(message, primaryTelegramMessage, keyboard);
    }

    await saveInitialVkMessageState({
      vkPeerId: message.peer_id,
      vkMessageId: message.id,
      vkConversationMessageId: message.conversation_message_id,
      telegramChatId: primaryTelegramMessage.chat.id,
      telegramMessageId: primaryTelegramMessage.message_id,
      telegramThreadId: primaryTelegramMessage.message_thread_id ?? topic.threadId,
      text: canonicalText,
      sourceSnapshot: vkMessageSourceSnapshot(message),
      vkDate: message.date
    });

    if (
      message.conversation_message_id &&
      ((message.reactions?.some((reaction) => reaction.count > 0) ?? false) || message.reaction_id)
    ) {
      await this.refreshVkReactionSummary(message.peer_id, message.conversation_message_id);
    }

  }

  private async forwardEditedVkAttachments(
    message: VkMessage,
    state: VkMessageStateRecord,
    attachments: VkAttachment[]
  ): Promise<void> {
    for (const attachment of attachments) {
      const sent = await this.sendVkAttachmentToTelegram(attachment, {
        threadId: state.telegramThreadId,
        replyToMessageId: state.telegramMessageId
      });
      for (const telegramMessage of sent) {
        await this.saveVkToTelegramMap(message, telegramMessage, state.telegramThreadId);
      }
    }
    await this.logs.info(
      `Forwarded ${attachments.length} attachment(s) added to VK message ${message.id} in peer ${message.peer_id}`
    );
  }

  private async forwardEditedVkMessages(
    message: VkMessage,
    state: VkMessageStateRecord,
    forwardedMessages: VkMessage[]
  ): Promise<void> {
    const sent = await this.forwardVkMessagesToTelegram(forwardedMessages, {
      threadId: state.telegramThreadId,
      replyToMessageId: state.telegramMessageId,
      depth: 0
    });
    for (const telegramMessage of sent) {
      await this.saveVkToTelegramMap(message, telegramMessage, state.telegramThreadId);
    }
    await this.logs.info(
      `Forwarded ${forwardedMessages.length} forwarded VK message(s) added to message ${message.id} in peer ${message.peer_id}`
    );
  }

  private async forwardVkMessagesToTelegram(
    messages: VkMessage[],
    context: { threadId: number; replyToMessageId?: number; depth: number }
  ): Promise<TelegramMessage[]> {
    const sent: TelegramMessage[] = [];
    const visibleMessages = messages.slice(0, MAX_VK_FORWARDED_MESSAGES);
    for (const forwarded of visibleMessages) {
      sent.push(...(await this.sendVkForwardedMessageToTelegram(forwarded, context)));
    }

    if (messages.length > visibleMessages.length) {
      sent.push(
        await this.telegram.sendMessage({
          message_thread_id: context.threadId,
          text: `↪ Ещё ${messages.length - visibleMessages.length} пересланных сообщений доступны в VK.`,
          reply_to_message_id: context.replyToMessageId,
          disable_notification: true
        })
      );
    }
    return sent;
  }

  private async sendVkForwardedMessageToTelegram(
    message: VkMessage,
    context: { threadId: number; replyToMessageId?: number; depth: number }
  ): Promise<TelegramMessage[]> {
    const senderName = message.from_id ? await this.vk.getSenderName(message.from_id).catch(() => undefined) : undefined;
    const text = await this.formatVkText({ ...message, fwd_messages: [] });
    const card = await this.telegram.sendMessage({
      message_thread_id: context.threadId,
      text: truncate(compactText(["↪ Переслано из VK", senderName ? `От: ${senderName}` : undefined, text]), 4096),
      reply_to_message_id: context.replyToMessageId,
      link_preview_options: { is_disabled: false },
      disable_notification: true
    });
    const sent = [card];

    for (const attachment of message.attachments ?? []) {
      sent.push(
        ...(await this.sendVkAttachmentToTelegram(attachment, {
          threadId: context.threadId,
          replyToMessageId: card.message_id,
          nesting: context.depth + 1
        }))
      );
    }

    const nested = message.fwd_messages ?? [];
    if (nested.length && context.depth >= MAX_VK_FORWARD_DEPTH) {
      sent.push(
        await this.telegram.sendMessage({
          message_thread_id: context.threadId,
          text: "↪ Вложенные пересылки доступны в исходном сообщении VK.",
          reply_to_message_id: card.message_id,
          disable_notification: true
        })
      );
    } else if (nested.length) {
      sent.push(
        ...(await this.forwardVkMessagesToTelegram(nested, {
          threadId: context.threadId,
          replyToMessageId: card.message_id,
          depth: context.depth + 1
        }))
      );
    }

    return sent;
  }

  private async saveVkKeyboardActions(
    message: VkMessage,
    telegramMessage: TelegramMessage,
    keyboard: PreparedVkKeyboard
  ): Promise<void> {
    await saveVkButtonActions(
      keyboard.actions.map((action) => ({
        id: action.id,
        vkPeerId: message.peer_id,
        vkMessageId: message.id,
        vkConversationMessageId: message.conversation_message_id,
        vkAuthorId: action.vkAuthorId,
        vkInline: action.vkInline,
        telegramChatId: telegramMessage.chat.id,
        telegramMessageId: telegramMessage.message_id,
        actionType: action.actionType,
        label: action.label,
        payload: action.payload
      }))
    );
  }

  private async handleVkPin(message: VkMessage): Promise<void> {
    const topic = await this.topics.getOrCreateTopic(message.peer_id);
    const conversationMessageId = message.action?.conversation_message_id;
    if (!conversationMessageId) {
      await this.logs.error(`Cannot mirror VK pin in peer ${message.peer_id}: missing conversation_message_id`);
      return;
    }

    let mapped = await findByVkMessage(message.peer_id, undefined, conversationMessageId);
    if (!mapped) {
      const pinned = await this.vk.getMessageByConversationMessageId(message.peer_id, conversationMessageId);
      if (pinned) {
        await this.forwardVkMessage(pinned);
        mapped = await findByVkMessage(message.peer_id, pinned.id, pinned.conversation_message_id);
      }
    }

    const telegramMessageId = optionalNumber(mapped?.telegram_message_id);
    if (!mapped || !telegramMessageId) {
      await this.logs.error(`Cannot mirror VK pin ${conversationMessageId}: no Telegram mapping`);
      return;
    }

    const oldPin = await getPin(message.peer_id);
    const oldTelegramMessageId = optionalNumber(oldPin?.telegram_message_id);
    if (oldTelegramMessageId && oldTelegramMessageId !== telegramMessageId) {
      await this.telegram.unpinChatMessage(oldTelegramMessageId).catch(() => undefined);
    }
    await this.telegram.pinChatMessage(telegramMessageId);
    await savePin({
      vkPeerId: message.peer_id,
      vkMessageId: optionalNumber(mapped.vk_message_id),
      vkConversationMessageId: conversationMessageId,
      telegramChatId: this.telegram.chatId,
      telegramMessageId,
      telegramThreadId: topic.threadId
    });
    await this.logs.info(`Pinned Telegram message ${telegramMessageId} from VK peer ${message.peer_id}`);
  }

  private async handleVkUnpin(message: VkMessage): Promise<void> {
    const topic = await getTopicByPeer(message.peer_id);
    if (!topic) return;

    const pin = await getPin(message.peer_id);
    const telegramMessageId = optionalNumber(pin?.telegram_message_id);
    if (telegramMessageId) {
      await this.telegram.unpinChatMessage(telegramMessageId).catch(() => undefined);
    }
    await clearPin(message.peer_id);
    await this.logs.info(`Unpinned Telegram topic ${topic.message_thread_id} from VK peer ${message.peer_id}`);
  }

  private async sendVkAttachmentToTelegram(
    attachment: VkAttachment,
    context: { threadId: number; replyToMessageId?: number; fallbackCaption?: string; nesting?: number }
  ): Promise<TelegramMessage[]> {
    const link = this.vk.bestVkAttachmentLink(attachment);
    const caption = context.fallbackCaption ? truncate(context.fallbackCaption, 1024) : undefined;
    const nesting = context.nesting ?? 0;

    if (attachment.type === "sticker") {
      const identity = vkStickerIdentity(attachment);
      if (identity.stickerId) {
        try {
          const mappedSticker = await this.stickers.telegramStickerForVk(identity.stickerId);
          if (mappedSticker) {
            return [
              await this.telegram.sendSticker({
                message_thread_id: context.threadId,
                file: mappedSticker.file_id,
                reply_to_message_id: context.replyToMessageId
              })
            ];
          }
          await this.logs.info(
            `VK sticker ${identity.stickerId}${identity.productId ? ` (pack ${identity.productId})` : ""} is not mapped`
          );
        } catch (error) {
          await this.logs.info(`Mapped VK sticker ${identity.stickerId} could not be sent: ${shortError(error)}`);
        }
      }
    }

    if (link.kind === "photo" && link.url) {
      return [
        await this.telegram.sendPhoto({
          message_thread_id: context.threadId,
          file: link.url,
          caption,
          reply_to_message_id: context.replyToMessageId
        })
      ];
    }

    if (link.kind === "sticker") {
      const text = vkStickerText(attachment, caption);
      return [
        await this.telegram.sendMessage({
          message_thread_id: context.threadId,
          text,
          reply_to_message_id: context.replyToMessageId,
          disable_notification: true
        })
      ];
    }

    if (link.kind === "animated_sticker" && link.url) {
      const text = vkStickerText(attachment, caption);
      try {
        const file = await downloadRemoteMedia(link.url, link.title ?? "vk-sticker.tgs");
        const tgs = await telegramTgsBuffer(file.buffer);
        return [
          await this.telegram.sendSticker({
            message_thread_id: context.threadId,
            file: tgs,
            filename: "vk-sticker.tgs",
            mimeType: "application/x-tgsticker",
            reply_to_message_id: context.replyToMessageId
          })
        ];
      } catch (error) {
        await this.logs.info(`Telegram animated sticker send failed, sending placeholder: ${shortError(error)}`);
      }

      return [
        await this.telegram.sendMessage({
          message_thread_id: context.threadId,
          text,
          reply_to_message_id: context.replyToMessageId,
          disable_notification: true
        })
      ];
    }

    if (link.kind === "voice" && link.url) {
      return [
        await this.telegram.sendVoice({
          message_thread_id: context.threadId,
          file: link.url,
          caption,
          reply_to_message_id: context.replyToMessageId
        })
      ];
    }

    if (link.kind === "audio") {
      return this.sendVkAudioToTelegram(link, attachment.type, context, caption);
    }

    if (link.kind === "video_note" && link.url) {
      const sent: TelegramMessage[] = [];
      if (caption) {
        sent.push(
          await this.telegram.sendMessage({
            message_thread_id: context.threadId,
            text: caption,
            reply_to_message_id: context.replyToMessageId
          })
        );
      }

      const file = await downloadRemoteMedia(link.url, link.title ?? "video-note.mp4");
      sent.push(
        await this.telegram.sendVideoNote({
          message_thread_id: context.threadId,
          file: file.buffer,
          filename: file.filename,
          mimeType: file.mimeType || "video/mp4",
          reply_to_message_id: context.replyToMessageId
        })
      );
      return sent;
    }

    if (link.kind === "video" && link.url) {
      return [
        await this.telegram.sendVideo({
          message_thread_id: context.threadId,
          file: link.url,
          caption,
          reply_to_message_id: context.replyToMessageId
        })
      ];
    }

    if (link.kind === "document") {
      if (link.url) {
        try {
          const file = await downloadRemoteMedia(link.url, link.title ?? "vk-document");
          return [
            await this.telegram.sendDocument({
              message_thread_id: context.threadId,
              file: file.buffer,
              filename: link.title ?? file.filename,
              mimeType: file.mimeType,
              caption,
              reply_to_message_id: context.replyToMessageId
            })
          ];
        } catch (error) {
          await this.logs.info(`VK document download failed, asking Telegram to fetch it: ${shortError(error)}`);
        }

        try {
          return [
            await this.telegram.sendDocument({
              message_thread_id: context.threadId,
              file: link.url,
              filename: link.title,
              caption,
              reply_to_message_id: context.replyToMessageId
            })
          ];
        } catch (error) {
          await this.logs.info(`Telegram document fetch failed, sending VK file link: ${shortError(error)}`);
        }
      }

      const fallbackUrl = link.fallbackUrl ?? link.url;
      if (fallbackUrl) {
        return [
          await this.telegram.sendMessage({
            message_thread_id: context.threadId,
            text: vkAttachmentCardText(attachment.type, link, caption),
            reply_to_message_id: context.replyToMessageId,
            link_preview_options: { is_disabled: true }
          })
        ];
      }
    }

    if (link.kind === "wall") {
      const card = await this.telegram.sendMessage({
        message_thread_id: context.threadId,
        text: vkAttachmentCardText(attachment.type, link, caption),
        reply_to_message_id: context.replyToMessageId,
        link_preview_options: { is_disabled: false }
      });
      const sent = [card];
      const embedded = [...vkWallEmbeddedAttachments(attachment), ...vkWallCopyHistoryAttachments(attachment)];
      if (embedded.length && nesting < MAX_VK_FORWARD_DEPTH) {
        for (const nestedAttachment of embedded.slice(0, MAX_VK_FORWARDED_MESSAGES)) {
          sent.push(
            ...(await this.sendVkAttachmentToTelegram(nestedAttachment, {
              threadId: context.threadId,
              replyToMessageId: card.message_id,
              nesting: nesting + 1
            }))
          );
        }
        if (embedded.length > MAX_VK_FORWARDED_MESSAGES) {
          sent.push(
            await this.telegram.sendMessage({
              message_thread_id: context.threadId,
              text: `↪ Ещё ${embedded.length - MAX_VK_FORWARDED_MESSAGES} вложений доступны в исходном посте VK.`,
              reply_to_message_id: card.message_id,
              disable_notification: true
            })
          );
        }
      } else if (embedded.length) {
        sent.push(
          await this.telegram.sendMessage({
            message_thread_id: context.threadId,
            text: "↪ Вложенные материалы доступны в исходном посте VK.",
            reply_to_message_id: card.message_id,
            disable_notification: true
          })
        );
      }
      return sent;
    }

    if (link.kind === "link" && link.url) {
      return [
        await this.telegram.sendMessage({
          message_thread_id: context.threadId,
          text: vkAttachmentCardText(attachment.type, link, caption),
          reply_to_message_id: context.replyToMessageId,
          link_preview_options: { is_disabled: false }
        })
      ];
    }

    return [
      await this.telegram.sendMessage({
        message_thread_id: context.threadId,
        text: vkAttachmentCardText(attachment.type, link, caption),
        reply_to_message_id: context.replyToMessageId,
        disable_notification: true
      })
    ];
  }

  private async sendVkAudioToTelegram(
    link: VkAttachmentPresentation,
    attachmentType: string,
    context: { threadId: number; replyToMessageId?: number },
    caption?: string
  ): Promise<TelegramMessage[]> {
    if (link.url) {
      try {
        return [
          await this.telegram.sendAudio({
            message_thread_id: context.threadId,
            file: link.url,
            caption,
            performer: link.performer,
            title: link.title,
            duration: link.duration,
            reply_to_message_id: context.replyToMessageId
          })
        ];
      } catch (error) {
        await this.logs.info(`Telegram could not fetch VK audio directly, downloading it first: ${shortError(error)}`);
      }

      try {
        const file = await downloadRemoteMedia(link.url, "vk-audio.mp3");
        return [
          await this.telegram.sendAudio({
            message_thread_id: context.threadId,
            file: file.buffer,
            filename: vkAudioFilename(link.title, file.filename, file.mimeType),
            mimeType: file.mimeType || "audio/mpeg",
            caption,
            performer: link.performer,
            title: link.title,
            duration: link.duration,
            reply_to_message_id: context.replyToMessageId
          })
        ];
      } catch (error) {
        await this.logs.info(`VK audio could not be sent as Telegram music: ${shortError(error)}`);
      }
    }

    return [
      await this.telegram.sendMessage({
        message_thread_id: context.threadId,
        text: vkAttachmentCardText(attachmentType, link, caption),
        reply_to_message_id: context.replyToMessageId,
        link_preview_options: { is_disabled: false },
        disable_notification: true
      })
    ];
  }

  private async telegramAttachmentsToVk(peerId: number, message: TelegramMessage): Promise<TelegramVkAttachments> {
    const attachments: string[] = [];
    const fallbackTexts: string[] = [];
    let stickerIds: number[] = [];

    const photo = largestPhoto(message.photo);
    if (photo) {
      const file = await this.telegram.downloadFile(photo);
      attachments.push(await this.vk.uploadMessagePhoto(peerId, file.buffer, file.filename, file.mimeType));
    }

    if (message.voice) {
      const file = await this.telegram.downloadFile(message.voice);
      const filename = telegramVoiceFilename(file.filename);
      try {
        attachments.push(
          await this.vk.uploadMessageDocument(peerId, file.buffer, filename, file.mimeType || "audio/ogg", "audio_message")
        );
      } catch (error) {
        await this.logs.info(`VK audio_message upload failed, sending voice as document: ${shortError(error)}`);
        attachments.push(await this.vk.uploadMessageDocument(peerId, file.buffer, filename, file.mimeType || "audio/ogg"));
      }
    }

    if (message.video) {
      attachments.push(await this.uploadTelegramVideoToVk(peerId, message.video, "telegram-video.mp4"));
    }

    if (message.video_note) {
      attachments.push(await this.uploadTelegramVideoNoteToVk(peerId, message.video_note));
    }

    if (message.animation) {
      const file = await this.telegram.downloadFile(message.animation);
      attachments.push(await this.vk.uploadMessageDocument(peerId, file.buffer, file.filename, file.mimeType));
    }

    if (message.sticker) {
      stickerIds = this.stickers.vkStickerCandidatesForTelegram(message.sticker);
      if (!stickerIds.length) {
        await this.logs.info(
          `Telegram sticker ${message.sticker.set_name ?? "without set"}/${message.sticker.file_unique_id ?? "without unique id"} is not mapped`
        );
      }
    }

    if (message.document) {
      const file = await this.telegram.downloadFile(message.document);
      attachments.push(await this.vk.uploadMessageDocument(peerId, file.buffer, file.filename, file.mimeType));
    }

    if (message.audio) {
      const file = await this.telegram.downloadFile(message.audio);
      attachments.push(await this.vk.uploadMessageDocument(peerId, file.buffer, file.filename, file.mimeType));
    }

    return { attachments, fallbackTexts, stickerIds };
  }

  private async uploadTelegramVideoToVk(peerId: number, fileRef: TelegramFileRef, fallbackFilename: string): Promise<string> {
    const file = await this.telegram.downloadFile({ ...fileRef, file_name: fileRef.file_name ?? fallbackFilename });
    try {
      return await this.vk.uploadVideo(file.buffer, file.filename, file.mimeType);
    } catch (error) {
      await this.logs.error("VK native video upload failed, sending video as document", error);
      return this.vk.uploadMessageDocument(peerId, file.buffer, file.filename, file.mimeType);
    }
  }

  private async uploadTelegramVideoNoteToVk(peerId: number, fileRef: TelegramFileRef): Promise<string> {
    const file = await this.telegram.downloadFile({
      ...fileRef,
      file_name: fileRef.file_name ?? "telegram-video-note.mp4"
    });
    try {
      return await this.vk.uploadMessageDocument(
        peerId,
        file.buffer,
        file.filename,
        file.mimeType || "video/mp4",
        "audio_message"
      );
    } catch (error) {
      throw new Error(
        `VK audio_message upload with Telegram circle video failed; circle was not sent as document: ${shortError(error)}`
      );
    }
  }

  private async saveVkToTelegramMap(message: VkMessage, telegramMessage: TelegramMessage, threadId: number): Promise<void> {
    await saveMessageMap({
      vkPeerId: message.peer_id,
      vkMessageId: message.id,
      vkConversationMessageId: message.conversation_message_id,
      telegramChatId: telegramMessage.chat.id,
      telegramMessageId: telegramMessage.message_id,
      telegramThreadId: telegramMessage.message_thread_id ?? threadId,
      direction: "vk_to_tg"
    });
  }

  private async telegramReplyTarget(peerId: number, message: TelegramMessage): Promise<number | undefined> {
    const reply = explicitTelegramReply(message);
    if (!reply) return undefined;

    const replyTopic = await getTopicByThread(message.chat.id, reply.message_id);
    if (replyTopic && Number(replyTopic.vk_peer_id) === peerId) return undefined;

    const mapped = await findByTelegramMessage(message.chat.id, reply.message_id);
    const mappedPeerId = optionalNumber(mapped?.vk_peer_id);
    if (mappedPeerId !== undefined && mappedPeerId !== peerId) {
      await this.logs.error(
        `Cannot reply to Telegram message ${reply.message_id}: mapped VK peer ${mappedPeerId} differs from topic peer ${peerId}`
      );
      return undefined;
    }

    const vkMessageId = optionalNumber(mapped?.vk_message_id);
    if (vkMessageId) return vkMessageId;

    const conversationMessageId = optionalNumber(mapped?.vk_conversation_message_id);
    if (conversationMessageId) {
      const vkMessage = await this.vk
        .getMessageByConversationMessageId(peerId, conversationMessageId)
        .catch(() => undefined);
      if (vkMessage?.id) {
        await updateMessageMapVkIds({
          telegramChatId: message.chat.id,
          telegramMessageId: reply.message_id,
          vkMessageId: vkMessage.id,
          vkConversationMessageId: vkMessage.conversation_message_id
        });
        return vkMessage.id;
      }
    }

    const recovered = await this.vk
      .findRecentOutgoingMessage(peerId, {
        date: reply.date,
        text: this.formatTelegramTextFull(reply)
      })
      .catch(() => undefined);
    if (!recovered?.id) {
      await this.logUnresolvedTelegramReply(peerId, reply.message_id);
      return undefined;
    }

    if (mapped) {
      await updateMessageMapVkIds({
        telegramChatId: message.chat.id,
        telegramMessageId: reply.message_id,
        vkMessageId: recovered.id,
        vkConversationMessageId: recovered.conversation_message_id
      });
    } else {
      await saveMessageMap({
        vkPeerId: peerId,
        vkMessageId: recovered.id,
        vkConversationMessageId: recovered.conversation_message_id,
        telegramChatId: message.chat.id,
        telegramMessageId: reply.message_id,
        telegramThreadId: reply.message_thread_id ?? message.message_thread_id ?? 1,
        direction: "tg_to_vk"
      });
    }
    await this.logs.info(
      `Recovered VK reply target ${recovered.id}/${recovered.conversation_message_id ?? "?"} for Telegram message ${reply.message_id}`
    );
    return recovered.id;
  }

  private async logUnresolvedTelegramReply(peerId: number, telegramMessageId: number): Promise<void> {
    const key = `${peerId}:${telegramMessageId}`;
    const now = Date.now();
    const lastLoggedAt = this.unresolvedTelegramReplyLogs.get(key);
    if (lastLoggedAt !== undefined && now - lastLoggedAt < 10 * 60 * 1000) return;

    if (this.unresolvedTelegramReplyLogs.size >= 500) {
      const oldestKey = this.unresolvedTelegramReplyLogs.keys().next().value;
      if (oldestKey !== undefined) this.unresolvedTelegramReplyLogs.delete(oldestKey);
    }
    this.unresolvedTelegramReplyLogs.set(key, now);
    await this.logs.error(
      `Cannot resolve VK reply target for Telegram message ${telegramMessageId} in peer ${peerId}`
    );
  }

  private async vkReplyTarget(message: VkMessage): Promise<number | undefined> {
    if (!message.reply_message) return undefined;
    const mapped = await findByVkMessage(
      message.peer_id,
      message.reply_message.id,
      message.reply_message.conversation_message_id
    );
    return optionalNumber(mapped?.telegram_message_id);
  }

  private async vkMessageSenderName(message: VkMessage): Promise<string | undefined> {
    if (message.peer_id <= 2_000_000_000) return undefined;
    if (!message.from_id || message.from_id === message.peer_id) return undefined;
    return this.vk.getSenderName(message.from_id).catch(() => undefined);
  }

  private async formatVkText(message: VkMessage, senderName?: string): Promise<string | undefined> {
    const systemText = await this.formatVkSystemAction(message, senderName);
    return (
      compactText([
        systemText,
        systemText ? undefined : senderName ? `${senderName}:` : undefined,
        systemText ? undefined : message.text
      ]) || undefined
    );
  }

  private async formatVkSystemAction(message: VkMessage, senderName?: string): Promise<string | undefined> {
    const action = message.action;
    const type = action?.type;
    if (!action || !type) return undefined;

    const actor = senderName ?? (await this.vk.getSenderName(message.from_id).catch(() => undefined)) ?? "Участник VK";
    const memberId = optionalNumber(action.member_id);
    const member = memberId
      ? memberId === message.from_id
        ? actor
        : await this.vk.getSenderName(memberId).catch(() => undefined)
      : undefined;
    const target = member ?? action.email ?? (memberId ? `VK id${memberId}` : undefined);
    const title = action.text?.trim();
    const pinnedText = action.message?.trim();

    switch (type) {
      case "chat_create":
        return title ? `${actor} создал(а) чат «${title}»` : `${actor} создал(а) чат`;
      case "chat_title_update":
        return title ? `${actor} изменил(а) название чата на «${title}»` : `${actor} изменил(а) название чата`;
      case "chat_photo_update":
        return `${actor} обновил(а) фотографию чата`;
      case "chat_photo_remove":
        return `${actor} удалил(а) фотографию чата`;
      case "chat_invite_user":
        return memberId === message.from_id
          ? `${actor} вступил(а) в чат`
          : target
            ? `${actor} пригласил(а) ${target} в чат`
            : `${actor} пригласил(а) участника в чат`;
      case "chat_invite_user_by_link":
        return `${target ?? actor} присоединился(-ась) к чату по ссылке`;
      case "chat_kick_user":
        return memberId === message.from_id
          ? `${actor} вышел(-ла) из чата`
          : target
            ? `${actor} исключил(а) ${target} из чата`
            : `${actor} исключил(а) участника из чата`;
      case "chat_kick_don":
        return target ? `${actor} исключил(а) ${target} из чата` : `${actor} исключил(а) участника из чата`;
      case "chat_pin_message":
        return pinnedText ? `${actor} закрепил(а) сообщение «${pinnedText}»` : `${actor} закрепил(а) сообщение`;
      case "chat_unpin_message":
        return `${actor} открепил(а) сообщение`;
      case "chat_screenshot":
        return `${target ?? actor} сделал(а) скриншот чата`;
      case "chat_group_call_started":
        return `${actor} начал(а) групповой звонок`;
      case "chat_invite_user_by_call":
        return target ? `${actor} пригласил(а) ${target} в звонок` : `${actor} пригласил(а) участника в звонок`;
      case "chat_invite_user_by_call_join_link":
        return `${target ?? actor} присоединился(-ась) к звонку по ссылке`;
      case "chat_invite_user_by_message_request":
        return `${target ?? actor} отправил(а) запрос на вступление в чат`;
      case "conversation_style_update":
        return action.style
          ? `${actor} изменил(а) оформление чата на «${action.style}»`
          : `${actor} сбросил(а) оформление чата`;
      case "chat_owner_changed":
        return target ? `${target} стал(а) владельцем чата` : `${actor} изменил(а) владельца чата`;
      case "chat_admin_added":
        return target ? `${actor} назначил(а) ${target} администратором` : `${actor} назначил(а) администратора`;
      case "chat_admin_removed":
        return target ? `${actor} снял(а) права администратора с ${target}` : `${actor} снял(а) права администратора`;
      case "chat_settings_update":
        return `${actor} изменил(а) настройки чата`;
      default: {
        const details = compactText([title, pinnedText, target]);
        return `${actor}: системное событие VK «${type}»${details ? ` — ${details}` : ""}`;
      }
    }
  }

  private formatTelegramText(message: TelegramMessage): string | undefined {
    const text = this.formatTelegramTextFull(message);
    if (!text) return undefined;

    return truncate(text, 4096);
  }

  private formatTelegramTextFull(message: TelegramMessage): string | undefined {
    return (
      compactText([
        telegramForwardOriginText(message.forward_origin) ?? telegramLegacyForwardText(message),
        message.text ?? message.caption,
        this.formatTelegramStructuredText(message)
      ]) || undefined
    );
  }

  private formatTelegramStructuredText(message: TelegramMessage): string | undefined {
    if (message.venue) {
      return compactText([
        message.venue.title,
        message.venue.address,
        googleMapsUrl(message.venue.location.latitude, message.venue.location.longitude)
      ]);
    }

    if (message.location) {
      return googleMapsUrl(message.location.latitude, message.location.longitude);
    }

    if (message.contact) {
      return compactText([
        [message.contact.first_name, message.contact.last_name].filter(Boolean).join(" "),
        message.contact.phone_number
      ]);
    }

    if (message.poll) {
      return compactText([
        `Poll: ${message.poll.question}`,
        ...message.poll.options.map((option) =>
          option.voter_count === undefined ? `- ${option.text}` : `- ${option.text}: ${option.voter_count}`
        ),
        message.poll.total_voter_count === undefined ? undefined : `Total votes: ${message.poll.total_voter_count}`,
        message.poll.is_closed ? "Closed" : undefined
      ]);
    }

    if (message.dice) {
      return `${message.dice.emoji} ${message.dice.value}`;
    }

    if (message.audio) {
      return telegramAudioText(message.audio);
    }

    return telegramUnsupportedContentText(message);
  }

  private isVkPinAction(message: VkMessage): boolean {
    const type = message.action?.type ?? "";
    return type.includes("pin") && !type.includes("unpin");
  }

  private isVkUnpinAction(message: VkMessage): boolean {
    return (message.action?.type ?? "").includes("unpin");
  }

  private isGeneralTopicMessage(message: TelegramMessage): boolean {
    return !message.message_thread_id || message.message_thread_id === 1;
  }

  private async loadTelegramOffset(): Promise<number | undefined> {
    const saved = await getState<number | { offset?: number }>("telegram_update_offset");
    if (typeof saved === "number") return saved;
    return saved?.offset;
  }

  private async ensureVkLongPollState(state: VkLongPollState): Promise<VkLongPollState> {
    if (state.server && state.key && state.ts !== undefined) return state;
    return this.refreshVkLongPollState();
  }

  private async refreshVkLongPollState(): Promise<VkLongPollState> {
    const server = await this.vk.getLongPollServer();
    const state: VkLongPollState = {
      server: server.server,
      key: server.key,
      ts: server.ts,
      pts: server.pts
    };
    await setState("vk_long_poll", state);
    return state;
  }

  private async checkVkLongPoll(state: VkLongPollState): Promise<VkLongPollCheck> {
    if (!state.server || !state.key || state.ts === undefined) {
      throw new Error("VK Long Poll state is incomplete");
    }

    const baseUrl = state.server.startsWith("http") ? state.server : `https://${state.server}`;
    const url = new URL(baseUrl);
    url.searchParams.set("act", "a_check");
    url.searchParams.set("key", state.key);
    url.searchParams.set("ts", String(state.ts));
    url.searchParams.set("wait", String(config.vk.longPollWaitSeconds));
    url.searchParams.set("mode", "10");
    url.searchParams.set("version", String(config.vk.longPollVersion));

    const response = await fetchWithTimeout(
      url,
      {},
      Math.max(config.runtime.requestTimeoutMs, (config.vk.longPollWaitSeconds + 10) * 1000)
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`VK Long Poll HTTP ${response.status}: ${text}`);
    }
    return JSON.parse(text) as VkLongPollCheck;
  }

  private async handleVkLongPollFailure(
    state: VkLongPollState,
    check: VkLongPollCheck
  ): Promise<VkLongPollState> {
    if (check.failed === 1 && check.ts !== undefined) {
      const updated = { ...state, ts: check.ts };
      await setState("vk_long_poll", updated);
      return updated;
    }

    await this.logs.info(`Refreshing VK Long Poll server after failed=${check.failed}`);
    return this.refreshVkLongPollState();
  }
}

function isTopicInfoRefreshAction(message: VkMessage): boolean {
  const type = message.action?.type;
  return (
    type === "chat_title_update" ||
    type === "chat_photo_update" ||
    type === "chat_photo_remove" ||
    isVkParticipantChangeAction(message)
  );
}

function isVkParticipantChangeAction(message: VkMessage): boolean {
  return new Set([
    "chat_create",
    "chat_invite_user",
    "chat_invite_user_by_link",
    "chat_kick_user",
    "chat_kick_don"
  ]).has(message.action?.type ?? "");
}

function optionalNumber(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function selectedTelegramReaction(
  oldReactions: TelegramReactionType[],
  newReactions: TelegramReactionType[]
): TelegramReactionType | undefined {
  if (!newReactions.length) return undefined;
  const previous = new Set(oldReactions.map(telegramReactionKey));
  const added = newReactions.filter((reaction) => !previous.has(telegramReactionKey(reaction)));
  return added[added.length - 1] ?? newReactions[newReactions.length - 1];
}

function telegramReactionKey(reaction: TelegramReactionType): string {
  if (reaction.type === "emoji") return `emoji:${reaction.emoji.replaceAll("\uFE0F", "")}`;
  if (reaction.type === "custom_emoji") return `custom:${reaction.custom_emoji_id}`;
  return reaction.type;
}

function vkReactionIdForTelegramReaction(reaction: TelegramReactionType): number {
  if (reaction.type !== "emoji") return DEFAULT_VK_REACTION_ID;
  return (
    VK_REACTION_IDS_BY_TELEGRAM_EMOJI.get(reaction.emoji.replaceAll("\uFE0F", "")) ??
    DEFAULT_VK_REACTION_ID
  );
}

function normalizedVkReactionCounters(reactions: VkReactedPeers): Array<{ reactionId: number; count: number }> {
  const counters = new Map<number, number>();
  for (const counter of reactions.counters) {
    counters.set(counter.reactionId, Math.max(counter.count, counters.get(counter.reactionId) ?? 0));
  }
  for (const reaction of reactions.reactions) {
    const actorCount = new Set(
      reactions.reactions
        .filter((candidate) => candidate.reactionId === reaction.reactionId)
        .map((candidate) => candidate.userId)
    ).size;
    counters.set(reaction.reactionId, Math.max(actorCount, counters.get(reaction.reactionId) ?? 0));
  }
  return [...counters.entries()]
    .map(([reactionId, count]) => ({ reactionId, count }))
    .filter((counter) => counter.count > 0)
    .sort((left, right) => left.reactionId - right.reactionId);
}

function vkReactionTotalCount(reactions: VkReactedPeers): number {
  const counterTotal = normalizedVkReactionCounters(reactions).reduce((total, counter) => total + counter.count, 0);
  return Math.max(reactions.count, counterTotal, reactions.reactions.length);
}

function vkReactionSnapshot(reactions: VkReactedPeers): string {
  return JSON.stringify({
    counters: normalizedVkReactionCounters(reactions),
    reactions: [...reactions.reactions]
      .sort(
        (left, right) =>
          left.reactionId - right.reactionId ||
          left.userId - right.userId ||
          left.displayName.localeCompare(right.displayName, "ru")
      )
      .map((reaction) => ({
        reactionId: reaction.reactionId,
        userId: reaction.userId,
        displayName: reaction.displayName
      }))
  });
}

function vkReactionSummaryText(reactions: VkReactedPeers): string {
  const lines = ["Реакции VK:"];
  const counters = normalizedVkReactionCounters(reactions);
  if (!counters.length) return `Реакции VK: ${reactions.count}`;
  for (const counter of counters) {
    const names = [...new Map(
      reactions.reactions
        .filter((reaction) => reaction.reactionId === counter.reactionId)
        .map((reaction) => [reaction.userId, reaction.displayName] as const)
    ).values()].sort((left, right) => left.localeCompare(right, "ru"));
    const hiddenCount = Math.max(0, counter.count - names.length);
    const parts = [...names];
    if (hiddenCount) parts.push(`ещё ${hiddenCount}`);
    const emoji = VK_REACTION_EMOJI_BY_ID.get(counter.reactionId) ?? `#${counter.reactionId}`;
    lines.push(`${emoji} ${parts.join(", ") || counter.count}`);
  }
  return truncate(lines.join("\n"), 4096);
}

function vkDeletionKey(peerId: number, conversationScoped: boolean, messageId: number): string {
  return `${peerId}:${conversationScoped ? "cmid" : "id"}:${messageId}`;
}

function hasVkMessageFlag(value: unknown, flag: number): boolean {
  const flags = Number(value);
  return Number.isFinite(flags) && (flags & flag) === flag;
}

function telegramStateText(currentText: string, edited: boolean, deleted: boolean): string {
  const markers = [edited ? "(edited)" : undefined, deleted ? "(deleted)" : undefined].filter(Boolean).join(" ");
  if (!markers) return truncateCodePoints(currentText, 4096);
  const suffix = `\n\n${markers}`;
  return `${truncateCodePoints(currentText, 4096 - Array.from(suffix).length)}${suffix}`;
}

function vkVersionHistoryPages(
  versions: Array<{ versionNo: number; text: string; vkDate?: number; createdAt: Date }>
): string[] {
  const body = versions
    .map((version) => {
      const date = version.vkDate ? new Date(version.vkDate * 1000) : version.createdAt;
      return `Version ${version.versionNo} — ${date.toISOString()}\n${version.text || "[empty message]"}`;
    })
    .join("\n\n---\n\n");
  const chunks = splitTextByCodePoints(body, 3800);
  return chunks.map((chunk, index) => `VK message history ${index + 1}/${chunks.length}\n\n${chunk}`);
}

function splitTextByCodePoints(text: string, maxLength: number): string[] {
  const points = Array.from(text);
  if (!points.length) return [""];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    let end = Math.min(offset + maxLength, points.length);
    if (end < points.length) {
      const candidate = points.slice(offset, end).join("");
      const newline = candidate.lastIndexOf("\n");
      if (newline >= Math.floor(maxLength / 2)) end = offset + Array.from(candidate.slice(0, newline + 1)).length;
    }
    chunks.push(points.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}

function truncateCodePoints(text: string, maxLength: number): string {
  const points = Array.from(text);
  if (points.length <= maxLength) return text;
  if (maxLength <= 1) return points.slice(0, Math.max(0, maxLength)).join("");
  return `${points.slice(0, maxLength - 1).join("")}…`;
}

function isValidVkPinPeerId(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && (value < 0 || value > 2_000_000_000);
}

export function prepareVkKeyboard(message: VkMessage): PreparedVkKeyboard | undefined {
  const sources = vkButtonRowSources(message);
  if (!sources.length) return undefined;

  const actions: PreparedVkButtonAction[] = [];
  const inlineKeyboard = sources
    .map((source) =>
      source.buttons.flatMap<TelegramInlineKeyboardButton>((button) => {
        const action = button.action;
        if (!action?.type) return [];
        const label = truncate(action.label?.trim() || vkButtonFallbackLabel(action.type), 64);
        const url = vkButtonUrl(action);
        if (url) return [{ text: label, url }];

        const id = randomBytes(12).toString("base64url");
        actions.push({
          id,
          actionType: action.type,
          label,
          payload: vkPayloadString(action.payload),
          vkInline: source.inline,
          vkAuthorId: source.authorId
        });
        return [{ text: label, callback_data: `vkb:${id}` }];
      })
    )
    .filter((row) => row.length > 0);

  return inlineKeyboard.length
    ? {
        replyMarkup: { inline_keyboard: inlineKeyboard },
        actions
      }
    : undefined;
}

function vkButtonRowSources(
  message: VkMessage
): Array<{ buttons: VkKeyboardButton[]; inline: boolean; authorId?: number }> {
  const sources: Array<{ buttons: VkKeyboardButton[]; inline: boolean; authorId?: number }> = [];
  const keyboard = parseVkKeyboard(message.keyboard);
  for (const buttons of keyboard?.buttons ?? []) {
    if (Array.isArray(buttons)) {
      sources.push({
        buttons,
        inline: keyboard?.inline === true,
        authorId: keyboard?.author_id ?? message.from_id
      });
    }
  }

  const template = parseJsonRecord(message.template);
  const elements = Array.isArray(template?.elements) ? template.elements : [];
  for (const element of elements) {
    if (!isRecord(element) || !Array.isArray(element.buttons)) continue;
    sources.push({
      buttons: element.buttons.filter(isVkKeyboardButton),
      inline: true,
      authorId: message.from_id
    });
  }
  return sources;
}

function parseVkKeyboard(value: VkMessage["keyboard"]): VkKeyboard | undefined {
  const parsed = parseJsonRecord(value);
  return parsed as VkKeyboard | undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isVkKeyboardButton(value: unknown): value is VkKeyboardButton {
  return isRecord(value);
}

function vkButtonUrl(action: NonNullable<VkKeyboardButton["action"]>): string | undefined {
  if (action.type === "open_link") return validTelegramUrl(action.link);

  if (action.type === "open_app" && Number.isFinite(action.app_id)) {
    const owner = Number.isFinite(action.owner_id) ? `_${action.owner_id}` : "";
    const hash = action.hash ? `#${action.hash.replace(/^#/, "")}` : "";
    return `https://vk.com/app${action.app_id}${owner}${hash}`;
  }

  if (action.type === "vkpay" && action.hash) {
    return `https://vk.com/vkpay#${action.hash.replace(/^#/, "")}`;
  }

  return undefined;
}

function isVkButtonEventResponse(value: unknown): value is VkButtonEventResponse {
  return (
    isRecord(value) &&
    typeof value.owner_id === "number" &&
    typeof value.peer_id === "number" &&
    typeof value.event_id === "string"
  );
}

function vkButtonEventActionUrl(action: VkButtonEventResponse["action"]): string | undefined {
  if (action?.type === "open_link") return validTelegramUrl(action.link);
  if (action?.type !== "open_app" || !Number.isFinite(action.app_id)) return undefined;

  const owner = Number.isFinite(action.owner_id) ? `_${action.owner_id}` : "";
  const hash = action.hash ? `#${action.hash.replace(/^#/, "")}` : "";
  return `https://vk.com/app${action.app_id}${owner}${hash}`;
}

function validTelegramUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function vkPayloadString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function vkButtonFallbackLabel(type: string): string {
  if (type === "location") return "Отправить местоположение";
  if (type === "vkpay") return "VK Pay";
  if (type === "open_app") return "Открыть VK Mini App";
  if (type === "open_link") return "Открыть ссылку";
  return "Кнопка VK";
}

function vkButtonActionId(data: string | undefined): string | undefined {
  if (!data?.startsWith("vkb:")) return undefined;
  const id = data.slice(4);
  return /^[A-Za-z0-9_-]{16}$/.test(id) ? id : undefined;
}

function largestPhoto(photos: TelegramFileRef[] | undefined): TelegramFileRef | undefined {
  if (!photos?.length) return undefined;
  return [...photos].sort((a, b) => photoScore(b) - photoScore(a))[0];
}

function photoScore(photo: TelegramFileRef): number {
  return photo.file_size ?? (photo.width ?? 0) * (photo.height ?? 0);
}

function googleMapsUrl(latitude: number, longitude: number): string {
  return `https://maps.google.com/?q=${latitude},${longitude}`;
}

function telegramContentKinds(message: TelegramMessage): string[] {
  const ignoredKeys = new Set([
    "message_id",
    "message_thread_id",
    "is_topic_message",
    "from",
    "chat",
    "date",
    "edit_date",
    "text",
    "caption",
    "reply_to_message",
    "pinned_message",
    "forward_origin",
    "forward_date",
    "forward_from",
    "forward_from_chat",
    "forward_from_message_id",
    "forward_sender_name",
    "forward_signature",
    "entities",
    "caption_entities",
    "media_group_id",
    "author_signature",
    "via_bot",
    "sender_chat",
    "is_automatic_forward",
    "has_protected_content",
    "link_preview_options",
    "forum_topic_created",
    "forum_topic_edited",
    "forum_topic_closed",
    "forum_topic_reopened",
    "general_forum_topic_hidden",
    "general_forum_topic_unhidden",
    "message_auto_delete_timer_changed",
    "migrate_to_chat_id",
    "migrate_from_chat_id"
  ]);
  return Object.entries(message)
    .filter(([key, value]) => !ignoredKeys.has(key) && value !== undefined && value !== null)
    .map(([key]) => key);
}

function telegramForwardOriginText(origin: TelegramForwardOrigin | undefined): string | undefined {
  if (!origin) return undefined;
  const userName = origin.sender_user
    ? [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(" ")
    : undefined;
  const source =
    userName || origin.sender_user_name || origin.sender_chat?.title || origin.chat?.title || origin.author_signature;
  return source ? `↪ Переслано из Telegram: ${source}` : "↪ Переслано из Telegram";
}

function telegramLegacyForwardText(message: TelegramMessage): string | undefined {
  const userName = message.forward_from
    ? [message.forward_from.first_name, message.forward_from.last_name].filter(Boolean).join(" ")
    : undefined;
  const source = userName || message.forward_sender_name || message.forward_from_chat?.title;
  return source ? `↪ Переслано из Telegram: ${source}` : undefined;
}

function telegramAudioText(audio: TelegramAudio): string {
  const track = [audio.performer, audio.title].filter((value): value is string => Boolean(value?.trim())).join(" — ");
  return compactText([`🎵 ${track || "Аудио из Telegram"}`, formatDuration(audio.duration)]);
}

export function telegramUnsupportedContentText(message: TelegramMessage): string | undefined {
  const handledKinds = new Set([
    "photo",
    "voice",
    "document",
    "video",
    "audio",
    "video_note",
    "animation",
    "sticker",
    "location",
    "venue",
    "contact",
    "poll",
    "dice"
  ]);
  const kinds = telegramContentKinds(message).filter((kind) => !handledKinds.has(kind));
  if (!kinds.length) return undefined;
  return `📎 Вложение Telegram: ${kinds.map(telegramContentKindLabel).join(", ")}`;
}

function telegramContentKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    story: "история",
    paid_media: "платный контент",
    game: "игра",
    invoice: "счёт",
    giveaway: "розыгрыш",
    giveaway_completed: "итоги розыгрыша",
    boost_added: "буст",
    write_access_allowed: "разрешение на сообщения"
  };
  return labels[kind] ?? kind.replace(/_/g, " ");
}

function telegramMessagePlaceholder(message: TelegramMessage): string {
  const kinds = telegramContentKinds(message).filter((kind) => kind !== "caption");
  return kinds.length ? `[Telegram message: ${kinds.join(", ")}]` : "[Telegram message]";
}

function explicitTelegramReply(message: TelegramMessage): TelegramMessage | undefined {
  const reply = message.reply_to_message;
  if (!reply) return undefined;

  const isTopicRoot = message.message_thread_id !== undefined && reply.message_id === message.message_thread_id;
  if (isTopicRoot || reply.forum_topic_created !== undefined) return undefined;

  return reply;
}

function vkMessagePlaceholder(message: VkMessage, senderName?: string, hasKeyboard = false): string {
  const kinds = (message.attachments ?? []).map((attachment) => attachment.type);
  if (hasKeyboard) kinds.push("keyboard");
  const content = kinds.length ? `[VK message: ${[...new Set(kinds)].join(", ")}]` : "[VK message]";
  return compactText([senderName ? `${senderName}:` : undefined, content]);
}

function vkMessageSourceSnapshot(message: VkMessage): string {
  return stableJson({
    text: message.text ?? "",
    action: message.action ?? null,
    replyMessageId: message.reply_message?.id ?? null,
    forwardedMessageIds: (message.fwd_messages ?? []).map((forwarded) => forwarded.id),
    attachments: (message.attachments ?? []).map(vkAttachmentSourceSnapshot)
  });
}

function vkOutgoingMessageSourceSnapshot(
  text: string | undefined,
  attachments: string[],
  stickerId?: number
): string {
  return stableJson({
    text: text ?? "",
    action: null,
    replyMessageId: null,
    forwardedMessageIds: [],
    attachments: attachments.map((attachment) => ({ token: attachment.replace(/_[^_,]+$/, "") })),
    stickerId: stickerId ?? null
  });
}

function vkAttachmentSourceSnapshot(attachment: VkAttachment): Record<string, unknown> {
  const rawValue = attachment[attachment.type];
  const value = isRecord(rawValue) ? rawValue : {};
  return vkAttachmentIdentitySnapshot({ type: attachment.type, ...value });
}

function addedVkAttachments(previousSourceSnapshot: string | undefined, attachments: VkAttachment[]): VkAttachment[] {
  if (!previousSourceSnapshot || !attachments.length) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(previousSourceSnapshot) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.attachments)) return [];

  const previousCounts = new Map<string, number>();
  for (const attachment of parsed.attachments) {
    if (!isRecord(attachment)) continue;
    const key = stableJson(vkAttachmentIdentitySnapshot(attachment));
    previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
  }

  return attachments.filter((attachment) => {
    const key = stableJson(vkAttachmentSourceSnapshot(attachment));
    const previousCount = previousCounts.get(key) ?? 0;
    if (!previousCount) return true;
    if (previousCount === 1) previousCounts.delete(key);
    else previousCounts.set(key, previousCount - 1);
    return false;
  });
}

function addedVkForwardedMessages(previousSourceSnapshot: string | undefined, messages: VkMessage[]): VkMessage[] {
  if (!previousSourceSnapshot || !messages.length) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(previousSourceSnapshot) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.forwardedMessageIds)) return [];

  const previousCounts = new Map<string, number>();
  for (const id of parsed.forwardedMessageIds) {
    if (typeof id !== "number" && typeof id !== "string") continue;
    const key = String(id);
    previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
  }

  return messages.filter((message) => {
    const key = String(message.id);
    const previousCount = previousCounts.get(key) ?? 0;
    if (!previousCount) return true;
    if (previousCount === 1) previousCounts.delete(key);
    else previousCounts.set(key, previousCount - 1);
    return false;
  });
}

function vkAttachmentIdentitySnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const type = typeof value.type === "string" ? value.type : "unknown";
  const identityKeys = ["owner_id", "from_id", "id", "sticker_id", "product_id"];
  const identity = Object.fromEntries(
    identityKeys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]]))
  );
  if (Object.keys(identity).length) return { type, ...identity };

  const fallbackKeys = ["url", "animation_url", "link_ogg", "link_mp3", "title", "duration"];
  return {
    type,
    ...Object.fromEntries(fallbackKeys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])))
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])])
  );
}

function legacyVkStateMatchesCurrent(
  stateText: string,
  currentText: string,
  rawVkText: string | undefined,
  senderName: string | undefined
): boolean {
  if (stateText === currentText || stateText === (rawVkText ?? "")) return true;
  if (!senderName) return false;
  return stateText === compactText([`${senderName}:`, rawVkText]);
}

function vkStickerText(attachment: VkAttachment, caption: string | undefined): string {
  const { stickerId, productId } = vkStickerIdentity(attachment);
  const details = [
    stickerId ? `id ${stickerId}` : undefined,
    productId ? `pack ${productId}` : undefined
  ].filter(Boolean);
  return compactText([caption, details.length ? `VK sticker (${details.join(", ")})` : "VK sticker"]);
}

function vkAttachmentCardText(type: string, attachment: VkAttachmentPresentation, caption?: string): string {
  const sourceUrl = validTelegramUrl(attachment.sourceUrl ?? attachment.fallbackUrl);
  if (attachment.kind === "audio") {
    const track = [attachment.performer, attachment.title]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" — ");
    return truncate(
      compactText([
        caption,
        `🎵 ${track || "Аудио VK"}`,
        formatDuration(attachment.duration),
        sourceUrl ? `Открыть в VK: ${sourceUrl}` : undefined
      ]),
      4096
    );
  }

  const label = vkAttachmentLabel(type, attachment);
  const emoji = vkAttachmentEmoji(type, attachment.kind);
  return truncate(
    compactText([
      caption,
      `${emoji} ${label}`,
      attachment.title && attachment.title !== label ? attachment.title : undefined,
      attachment.description,
      sourceUrl ? `Открыть в VK: ${sourceUrl}` : undefined
    ]),
    4096
  );
}

function vkAttachmentLabel(type: string, attachment: VkAttachmentPresentation): string {
  if (attachment.kind === "wall") return attachment.title || "Пост VK";
  const labels: Record<string, string> = {
    photo: "Фото VK",
    video: "Видео VK",
    video_note: "Видеосообщение VK",
    voice: "Голосовое сообщение VK",
    document: "Файл VK",
    sticker: "Стикер VK",
    animated_sticker: "Анимированный стикер VK",
    link: "Ссылка VK",
    market: "Товар VK",
    market_album: "Подборка товаров VK",
    poll: "Опрос VK",
    graffiti: "Граффити VK",
    story: "История VK",
    clip: "Клип VK"
  };
  return labels[type] ?? `Вложение VK: ${type}`;
}

function vkAttachmentEmoji(type: string, kind: string): string {
  if (kind === "wall") return "↗";
  const emoji: Record<string, string> = {
    photo: "🖼️",
    video: "🎬",
    video_note: "📹",
    voice: "🎙️",
    document: "📄",
    sticker: "✨",
    animated_sticker: "✨",
    link: "🔗",
    market: "🛍️",
    market_album: "🛍️",
    poll: "📊",
    graffiti: "🎨",
    story: "📚",
    clip: "🎞️"
  };
  return emoji[type] ?? "📎";
}

function vkWallEmbeddedAttachments(attachment: VkAttachment): VkAttachment[] {
  if (attachment.type !== "wall" || !isRecord(attachment.wall) || !Array.isArray(attachment.wall.attachments)) return [];
  return attachment.wall.attachments.filter(isVkAttachment);
}

function vkWallCopyHistoryAttachments(attachment: VkAttachment): VkAttachment[] {
  if (attachment.type !== "wall" || !isRecord(attachment.wall) || !Array.isArray(attachment.wall.copy_history)) return [];
  return attachment.wall.copy_history.filter(isRecord).map((wall) => ({ type: "wall", wall }));
}

function isVkAttachment(value: unknown): value is VkAttachment {
  return isRecord(value) && typeof value.type === "string";
}

function formatDuration(duration: number | undefined): string | undefined {
  if (duration === undefined || !Number.isFinite(duration) || duration < 0) return undefined;
  const totalSeconds = Math.floor(duration);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}:${seconds}`;
  return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, "0")}:${seconds}`;
}

function vkAudioFilename(title: string | undefined, fallbackFilename: string, mimeType: string | undefined): string {
  const extension = /\.(mp3|m4a|aac)$/i.exec(fallbackFilename)?.[0] ?? (mimeType?.includes("mp4") ? ".m4a" : ".mp3");
  const fallbackBase = fallbackFilename.replace(/\.[^.]+$/, "") || "vk-audio";
  const base = (title || fallbackBase).replace(/[\\/:*?"<>|]/g, "_").trim() || "vk-audio";
  return `${truncate(base, 120)}${extension}`;
}

function vkStickerIdentity(attachment: VkAttachment): { stickerId?: number; productId?: number } {
  const sticker = isRecord(attachment.sticker) ? attachment.sticker : {};
  return {
    stickerId: optionalUnknownNumber(sticker.sticker_id ?? sticker.id),
    productId: optionalUnknownNumber(sticker.product_id)
  };
}

function optionalUnknownNumber(value: unknown): number | undefined {
  return typeof value === "number" || typeof value === "string" ? optionalNumber(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message.replace(/\s+/g, " "), 300);
}

function telegramVoiceFilename(filename: string): string {
  if (/\.(ogg|oga)$/i.test(filename)) {
    return filename.replace(/\.oga$/i, ".ogg");
  }
  return `${filename.replace(/\.[^.]+$/, "") || "telegram-voice"}.ogg`;
}

async function downloadRemoteMedia(
  url: string,
  fallbackFilename: string
): Promise<{ buffer: Buffer; filename: string; mimeType?: string }> {
  const response = await fetchRemoteMedia(url);
  if (!response.ok) {
    const preview = await readResponseBodyWithinLimit(response, Math.min(config.media.maxDownloadBytes, 4_096));
    throw new Error(`Remote media download failed ${response.status}: ${truncate(preview.toString("utf8"), 300)}`);
  }

  const contentLength = response.headers.get("content-length");
  const declaredBytes = contentLength === null ? undefined : Number(contentLength);
  if (
    declaredBytes !== undefined &&
    Number.isFinite(declaredBytes) &&
    declaredBytes > config.media.maxDownloadBytes
  ) {
    throw new Error(`Remote media is too large: ${declaredBytes} bytes`);
  }

  const buffer = await readResponseBodyWithinLimit(response, config.media.maxDownloadBytes);

  return {
    buffer,
    filename: fileNameFromUrl(url, fallbackFilename),
    mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() || undefined
  };
}

async function fetchRemoteMedia(url: string, attempt = 0): Promise<Response> {
  try {
    const response = await fetchWithTimeout(url, {}, config.runtime.mediaTimeoutMs);
    if (isTransientHttpStatus(response.status) && attempt < config.runtime.maxNetworkRetries) {
      await response.body?.cancel().catch(() => undefined);
      await sleep(retryDelayMs(attempt, config.runtime.retryBaseMs));
      return fetchRemoteMedia(url, attempt + 1);
    }
    return response;
  } catch (error) {
    if (attempt < config.runtime.maxNetworkRetries) {
      await sleep(retryDelayMs(attempt, config.runtime.retryBaseMs));
      return fetchRemoteMedia(url, attempt + 1);
    }
    throw new Error(`Remote media request failed after ${attempt + 1} attempts`, { cause: error });
  }
}

async function telegramTgsBuffer(buffer: Buffer): Promise<Buffer> {
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (!isGzip && buffer.length > config.media.maxTgsDecompressedBytes) {
    throw new Error(
      `VK animated sticker exceeds configured decompressed limit: ${config.media.maxTgsDecompressedBytes} bytes`
    );
  }
  const jsonBuffer = isGzip
    ? await gunzipWithinLimit(buffer, config.media.maxTgsDecompressedBytes)
    : buffer;
  let lottie: unknown;
  try {
    lottie = JSON.parse(jsonBuffer.toString("utf8")) as unknown;
  } catch {
    throw new Error("VK animated sticker is not valid Lottie JSON");
  }
  if (!isRecord(lottie) || !Array.isArray(lottie.layers) || typeof lottie.fr !== "number") {
    throw new Error("VK animated sticker does not contain a valid Lottie animation");
  }
  return isGzip ? buffer : gzip(buffer, { level: 9 });
}
