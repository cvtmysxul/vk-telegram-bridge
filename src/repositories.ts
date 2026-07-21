import { and, asc, count, desc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "./db.js";
import {
  messageMap,
  peerPins,
  topicInfoMessages,
  topics,
  vkButtonActions,
  vkMessageStates,
  vkMessageVersions,
  vkPeers,
  vkReactionSummaries
} from "./schema.js";
import { MessageMapRow, VkPeerInfo } from "./types.js";

export async function upsertVkPeer(peer: VkPeerInfo): Promise<void> {
  await db
    .insert(vkPeers)
    .values({
      peerId: peer.peerId,
      displayName: peer.displayName,
      firstName: peer.firstName ?? null,
      lastName: peer.lastName ?? null,
      title: peer.title ?? null,
      isChat: peer.isChat,
      raw: peer.raw ?? {},
      updatedAt: sql`now()`
    })
    .onConflictDoUpdate({
      target: vkPeers.peerId,
      set: {
        displayName: peer.displayName,
        firstName: peer.firstName ?? null,
        lastName: peer.lastName ?? null,
        title: peer.title ?? null,
        isChat: peer.isChat,
        raw: peer.raw ?? {},
        updatedAt: sql`now()`
      }
    });
}

export async function getTopicByPeer(peerId: number): Promise<
  | {
      id: string;
      vk_peer_id: string;
      telegram_chat_id: string;
      message_thread_id: number;
      name: string;
    }
  | undefined
> {
  const [row] = await db
    .select({
      id: topics.id,
      vkPeerId: topics.vkPeerId,
      telegramChatId: topics.telegramChatId,
      messageThreadId: topics.messageThreadId,
      name: topics.name
    })
    .from(topics)
    .where(and(eq(topics.vkPeerId, peerId), isNull(topics.deletedAt)))
    .limit(1);

  return row ? topicRow(row) : undefined;
}

export async function getTopicByThread(telegramChatId: number, threadId: number): Promise<
  | {
      vk_peer_id: string;
      telegram_chat_id: string;
      message_thread_id: number;
      name: string;
    }
  | undefined
> {
  const [row] = await db
    .select({
      vkPeerId: topics.vkPeerId,
      telegramChatId: topics.telegramChatId,
      messageThreadId: topics.messageThreadId,
      name: topics.name
    })
    .from(topics)
    .where(
      and(
        eq(topics.telegramChatId, telegramChatId),
        eq(topics.messageThreadId, threadId),
        isNull(topics.deletedAt)
      )
    )
    .limit(1);

  return row
    ? {
        vk_peer_id: String(row.vkPeerId),
        telegram_chat_id: String(row.telegramChatId),
        message_thread_id: row.messageThreadId,
        name: row.name
      }
    : undefined;
}

export async function touchTopic(peerId: number): Promise<void> {
  await db
    .update(topics)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(topics.vkPeerId, peerId), isNull(topics.deletedAt)));
}

export async function countActivePeerTopics(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(topics)
    .where(and(isNotNull(topics.vkPeerId), isNull(topics.deletedAt)));
  return row?.value ?? 0;
}

export async function getOldestActiveTopic(): Promise<
  | {
      vk_peer_id: string;
      message_thread_id: number;
      name: string;
    }
  | undefined
> {
  const [row] = await db
    .select({
      vkPeerId: topics.vkPeerId,
      messageThreadId: topics.messageThreadId,
      name: topics.name
    })
    .from(topics)
    .where(and(isNotNull(topics.vkPeerId), isNull(topics.deletedAt)))
    .orderBy(asc(topics.createdAt))
    .limit(1);

  return row
    ? {
        vk_peer_id: String(row.vkPeerId),
        message_thread_id: row.messageThreadId,
        name: row.name
      }
    : undefined;
}

export async function listActiveTopics(): Promise<
  Array<{
    vk_peer_id: string;
    message_thread_id: number;
    name: string;
  }>
> {
  const rows = await db
    .select({
      vkPeerId: topics.vkPeerId,
      messageThreadId: topics.messageThreadId,
      name: topics.name
    })
    .from(topics)
    .where(and(isNotNull(topics.vkPeerId), isNull(topics.deletedAt)))
    .orderBy(desc(topics.lastUsedAt));

  return rows.map((row) => ({
    vk_peer_id: String(row.vkPeerId),
    message_thread_id: row.messageThreadId,
    name: row.name
  }));
}

export async function insertTopic(input: {
  peerId: number;
  telegramChatId: number;
  threadId: number;
  name: string;
}): Promise<void> {
  await db
    .insert(topics)
    .values({
      vkPeerId: input.peerId,
      telegramChatId: input.telegramChatId,
      messageThreadId: input.threadId,
      name: input.name
    })
    .onConflictDoUpdate({
      target: topics.vkPeerId,
      set: {
        telegramChatId: input.telegramChatId,
        messageThreadId: input.threadId,
        name: input.name,
        deletedAt: null,
        lastUsedAt: sql`now()`
      }
    });
}

export async function markTopicDeleted(telegramChatId: number, threadId: number): Promise<void> {
  await db
    .update(topics)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(topics.telegramChatId, telegramChatId),
        eq(topics.messageThreadId, threadId),
        isNull(topics.deletedAt)
      )
    );
  await db
    .delete(topicInfoMessages)
    .where(
      and(
        eq(topicInfoMessages.telegramChatId, telegramChatId),
        eq(topicInfoMessages.telegramThreadId, threadId)
      )
    );
}

export async function updateTopicName(peerId: number, name: string): Promise<void> {
  await db.update(topics).set({ name }).where(and(eq(topics.vkPeerId, peerId), isNull(topics.deletedAt)));
}

export async function saveMessageMap(input: {
  vkPeerId: number;
  vkMessageId?: number;
  vkConversationMessageId?: number;
  telegramChatId: number;
  telegramMessageId: number;
  telegramThreadId: number;
  direction: "vk_to_tg" | "tg_to_vk";
}): Promise<void> {
  await db
    .insert(messageMap)
    .values({
      vkPeerId: input.vkPeerId,
      vkMessageId: input.vkMessageId ?? null,
      vkConversationMessageId: input.vkConversationMessageId ?? null,
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId,
      telegramThreadId: input.telegramThreadId,
      direction: input.direction
    })
    .onConflictDoUpdate({
      target: [messageMap.telegramChatId, messageMap.telegramMessageId],
      set: {
        vkPeerId: input.vkPeerId,
        vkMessageId: input.vkMessageId ?? null,
        vkConversationMessageId: input.vkConversationMessageId ?? null,
        telegramThreadId: input.telegramThreadId,
        direction: input.direction
      }
    });
}

export async function findByTelegramMessage(chatId: number, messageId: number): Promise<MessageMapRow | undefined> {
  const [row] = await db
    .select({
      vkPeerId: messageMap.vkPeerId,
      vkMessageId: messageMap.vkMessageId,
      vkConversationMessageId: messageMap.vkConversationMessageId,
      telegramChatId: messageMap.telegramChatId,
      telegramMessageId: messageMap.telegramMessageId,
      telegramThreadId: messageMap.telegramThreadId,
      direction: messageMap.direction
    })
    .from(messageMap)
    .where(and(eq(messageMap.telegramChatId, chatId), eq(messageMap.telegramMessageId, messageId)))
    .limit(1);

  return row ? messageMapRow(row) : undefined;
}

export async function updateMessageMapVkIds(input: {
  telegramChatId: number;
  telegramMessageId: number;
  vkMessageId: number;
  vkConversationMessageId?: number;
}): Promise<void> {
  await db
    .update(messageMap)
    .set({
      vkMessageId: input.vkMessageId,
      vkConversationMessageId: input.vkConversationMessageId ?? null
    })
    .where(
      and(
        eq(messageMap.telegramChatId, input.telegramChatId),
        eq(messageMap.telegramMessageId, input.telegramMessageId)
      )
    );
}

export async function findByVkMessage(
  peerId: number,
  vkMessageId?: number,
  vkConversationMessageId?: number
): Promise<MessageMapRow | undefined> {
  if (vkMessageId === undefined && vkConversationMessageId === undefined) return undefined;

  const [row] = await db
    .select({
      vkPeerId: messageMap.vkPeerId,
      vkMessageId: messageMap.vkMessageId,
      vkConversationMessageId: messageMap.vkConversationMessageId,
      telegramChatId: messageMap.telegramChatId,
      telegramMessageId: messageMap.telegramMessageId,
      telegramThreadId: messageMap.telegramThreadId,
      direction: messageMap.direction
    })
    .from(messageMap)
    .where(
      and(
        eq(messageMap.vkPeerId, peerId),
        or(
          vkMessageId === undefined ? sql`false` : eq(messageMap.vkMessageId, vkMessageId),
          vkConversationMessageId === undefined
            ? sql`false`
            : eq(messageMap.vkConversationMessageId, vkConversationMessageId)
        )
      )
    )
    .orderBy(asc(messageMap.createdAt))
    .limit(1);

  return row ? messageMapRow(row) : undefined;
}

export interface VkReactionSummaryRecord {
  vkPeerId: number;
  vkConversationMessageId: number;
  telegramChatId: number;
  telegramMessageId: number;
  telegramThreadId: number;
  summaryTelegramMessageId: number;
  snapshot: string;
}

export async function getVkReactionSummary(
  vkPeerId: number,
  vkConversationMessageId: number
): Promise<VkReactionSummaryRecord | undefined> {
  const [row] = await db
    .select()
    .from(vkReactionSummaries)
    .where(
      and(
        eq(vkReactionSummaries.vkPeerId, vkPeerId),
        eq(vkReactionSummaries.vkConversationMessageId, vkConversationMessageId)
      )
    )
    .limit(1);

  return row ? vkReactionSummaryRow(row) : undefined;
}

export async function saveVkReactionSummary(input: VkReactionSummaryRecord): Promise<void> {
  await db
    .insert(vkReactionSummaries)
    .values({
      vkPeerId: input.vkPeerId,
      vkConversationMessageId: input.vkConversationMessageId,
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId,
      telegramThreadId: input.telegramThreadId,
      summaryTelegramMessageId: input.summaryTelegramMessageId,
      snapshot: input.snapshot,
      updatedAt: sql`now()`
    })
    .onConflictDoUpdate({
      target: [vkReactionSummaries.vkPeerId, vkReactionSummaries.vkConversationMessageId],
      set: {
        telegramChatId: input.telegramChatId,
        telegramMessageId: input.telegramMessageId,
        telegramThreadId: input.telegramThreadId,
        summaryTelegramMessageId: input.summaryTelegramMessageId,
        snapshot: input.snapshot,
        updatedAt: sql`now()`
      }
    });
}

export async function deleteVkReactionSummary(vkPeerId: number, vkConversationMessageId: number): Promise<void> {
  await db
    .delete(vkReactionSummaries)
    .where(
      and(
        eq(vkReactionSummaries.vkPeerId, vkPeerId),
        eq(vkReactionSummaries.vkConversationMessageId, vkConversationMessageId)
      )
    );
}

export async function savePin(input: {
  vkPeerId: number;
  vkMessageId?: number;
  vkConversationMessageId?: number;
  telegramChatId: number;
  telegramMessageId?: number;
  telegramThreadId: number;
}): Promise<void> {
  await db
    .insert(peerPins)
    .values({
      vkPeerId: input.vkPeerId,
      vkMessageId: input.vkMessageId ?? null,
      vkConversationMessageId: input.vkConversationMessageId ?? null,
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId ?? null,
      telegramThreadId: input.telegramThreadId,
      updatedAt: sql`now()`
    })
    .onConflictDoUpdate({
      target: peerPins.vkPeerId,
      set: {
        vkMessageId: input.vkMessageId ?? null,
        vkConversationMessageId: input.vkConversationMessageId ?? null,
        telegramChatId: input.telegramChatId,
        telegramMessageId: input.telegramMessageId ?? null,
        telegramThreadId: input.telegramThreadId,
        updatedAt: sql`now()`
      }
    });
}

export async function getPin(peerId: number): Promise<
  | {
      vk_peer_id: string;
      vk_message_id: string | null;
      vk_conversation_message_id: string | null;
      telegram_chat_id: string;
      telegram_message_id: string | null;
      telegram_thread_id: number;
    }
  | undefined
> {
  const [row] = await db
    .select({
      vkPeerId: peerPins.vkPeerId,
      vkMessageId: peerPins.vkMessageId,
      vkConversationMessageId: peerPins.vkConversationMessageId,
      telegramChatId: peerPins.telegramChatId,
      telegramMessageId: peerPins.telegramMessageId,
      telegramThreadId: peerPins.telegramThreadId
    })
    .from(peerPins)
    .where(eq(peerPins.vkPeerId, peerId))
    .limit(1);

  return row
    ? {
        vk_peer_id: String(row.vkPeerId),
        vk_message_id: nullableString(row.vkMessageId),
        vk_conversation_message_id: nullableString(row.vkConversationMessageId),
        telegram_chat_id: String(row.telegramChatId),
        telegram_message_id: nullableString(row.telegramMessageId),
        telegram_thread_id: row.telegramThreadId
      }
    : undefined;
}

export async function clearPin(peerId: number): Promise<void> {
  await db.delete(peerPins).where(eq(peerPins.vkPeerId, peerId));
}

export type TopicInfoMessageKind = "profile" | "participants";

export interface TopicInfoMessageRecord {
  vkPeerId: number;
  kind: TopicInfoMessageKind;
  telegramChatId: number;
  telegramMessageId: number;
  telegramThreadId: number;
  snapshot: string;
}

export async function listTopicInfoMessages(
  vkPeerId: number,
  kind: TopicInfoMessageKind
): Promise<TopicInfoMessageRecord[]> {
  const rows = await db
    .select({
      vkPeerId: topicInfoMessages.vkPeerId,
      kind: topicInfoMessages.kind,
      telegramChatId: topicInfoMessages.telegramChatId,
      telegramMessageId: topicInfoMessages.telegramMessageId,
      telegramThreadId: topicInfoMessages.telegramThreadId,
      snapshot: topicInfoMessages.snapshot
    })
    .from(topicInfoMessages)
    .where(and(eq(topicInfoMessages.vkPeerId, vkPeerId), eq(topicInfoMessages.kind, kind)))
    .orderBy(asc(topicInfoMessages.createdAt));

  return rows.map((row) => ({
    vkPeerId: row.vkPeerId,
    kind: row.kind as TopicInfoMessageKind,
    telegramChatId: row.telegramChatId,
    telegramMessageId: row.telegramMessageId,
    telegramThreadId: row.telegramThreadId,
    snapshot: row.snapshot
  }));
}

export async function saveTopicInfoMessage(input: TopicInfoMessageRecord): Promise<void> {
  await db
    .insert(topicInfoMessages)
    .values({
      vkPeerId: input.vkPeerId,
      kind: input.kind,
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId,
      telegramThreadId: input.telegramThreadId,
      snapshot: input.snapshot,
      updatedAt: sql`now()`
    })
    .onConflictDoUpdate({
      target: [topicInfoMessages.telegramChatId, topicInfoMessages.telegramMessageId],
      set: {
        vkPeerId: input.vkPeerId,
        kind: input.kind,
        telegramThreadId: input.telegramThreadId,
        snapshot: input.snapshot,
        updatedAt: sql`now()`
      }
    });
}

export async function deleteTopicInfoMessages(vkPeerId: number, kind: TopicInfoMessageKind): Promise<void> {
  await db
    .delete(topicInfoMessages)
    .where(and(eq(topicInfoMessages.vkPeerId, vkPeerId), eq(topicInfoMessages.kind, kind)));
}

export async function isTopicInfoMessage(telegramChatId: number, telegramMessageId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: topicInfoMessages.id })
    .from(topicInfoMessages)
    .where(
      and(
        eq(topicInfoMessages.telegramChatId, telegramChatId),
        eq(topicInfoMessages.telegramMessageId, telegramMessageId)
      )
    )
    .limit(1);
  return row !== undefined;
}

export async function saveVkButtonActions(
  actions: Array<{
    id: string;
    vkPeerId: number;
    vkMessageId?: number;
    vkConversationMessageId?: number;
    vkAuthorId?: number;
    vkInline: boolean;
    telegramChatId: number;
    telegramMessageId: number;
    actionType: string;
    label: string;
    payload?: string;
  }>
): Promise<void> {
  if (!actions.length) return;
  await db.insert(vkButtonActions).values(
    actions.map((action) => ({
      id: action.id,
      vkPeerId: action.vkPeerId,
      vkMessageId: action.vkMessageId ?? null,
      vkConversationMessageId: action.vkConversationMessageId ?? null,
      vkAuthorId: action.vkAuthorId ?? null,
      vkInline: action.vkInline,
      telegramChatId: action.telegramChatId,
      telegramMessageId: action.telegramMessageId,
      actionType: action.actionType,
      label: action.label,
      payload: action.payload ?? null
    }))
  );
}

export async function findVkButtonAction(id: string): Promise<
  | {
      id: string;
      vkPeerId: number;
      vkMessageId?: number;
      vkConversationMessageId?: number;
      vkAuthorId?: number;
      vkInline: boolean;
      telegramChatId: number;
      telegramMessageId: number;
      actionType: string;
      label: string;
      payload?: string;
    }
  | undefined
> {
  const [row] = await db.select().from(vkButtonActions).where(eq(vkButtonActions.id, id)).limit(1);
  if (!row) return undefined;
  return {
    id: row.id,
    vkPeerId: row.vkPeerId,
    vkMessageId: row.vkMessageId ?? undefined,
    vkConversationMessageId: row.vkConversationMessageId ?? undefined,
    vkAuthorId: row.vkAuthorId ?? undefined,
    vkInline: row.vkInline,
    telegramChatId: row.telegramChatId,
    telegramMessageId: row.telegramMessageId,
    actionType: row.actionType,
    label: row.label,
    payload: row.payload ?? undefined
  };
}

export interface VkMessageStateRecord {
  id: number;
  vkPeerId: number;
  vkMessageId: number;
  vkConversationMessageId?: number;
  telegramChatId: number;
  telegramMessageId: number;
  telegramThreadId: number;
  currentText: string;
  sourceSnapshot?: string;
  edited: boolean;
  deleted: boolean;
  historyMessageIds: number[];
}

export interface VkMessageVersionRecord {
  versionNo: number;
  text: string;
  vkDate?: number;
  createdAt: Date;
}

export async function saveInitialVkMessageState(input: {
  vkPeerId: number;
  vkMessageId: number;
  vkConversationMessageId?: number;
  telegramChatId: number;
  telegramMessageId: number;
  telegramThreadId: number;
  text: string;
  sourceSnapshot?: string;
  vkDate?: number;
}): Promise<VkMessageStateRecord> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(vkMessageStates)
      .values({
        vkPeerId: input.vkPeerId,
        vkMessageId: input.vkMessageId,
        vkConversationMessageId: input.vkConversationMessageId ?? null,
        telegramChatId: input.telegramChatId,
        telegramMessageId: input.telegramMessageId,
        telegramThreadId: input.telegramThreadId,
        currentText: input.text,
        sourceSnapshot: input.sourceSnapshot ?? null
      })
      .onConflictDoNothing({ target: [vkMessageStates.vkPeerId, vkMessageStates.vkMessageId] })
      .returning();

    const row = inserted[0] ?? (await tx
      .select()
      .from(vkMessageStates)
      .where(and(eq(vkMessageStates.vkPeerId, input.vkPeerId), eq(vkMessageStates.vkMessageId, input.vkMessageId)))
      .limit(1))[0];
    if (!row) throw new Error(`Cannot create VK message state for ${input.vkPeerId}/${input.vkMessageId}`);

    await tx
      .insert(vkMessageVersions)
      .values({ stateId: row.id, versionNo: 1, text: input.text, vkDate: input.vkDate ?? null })
      .onConflictDoNothing({ target: [vkMessageVersions.stateId, vkMessageVersions.versionNo] });
    return vkMessageStateRow(row);
  });
}

export async function getVkMessageState(input: {
  vkPeerId: number;
  vkMessageId?: number;
  vkConversationMessageId?: number;
}): Promise<VkMessageStateRecord | undefined> {
  if (input.vkMessageId === undefined && input.vkConversationMessageId === undefined) return undefined;
  const [row] = await db
    .select()
    .from(vkMessageStates)
    .where(
      and(
        eq(vkMessageStates.vkPeerId, input.vkPeerId),
        or(
          input.vkMessageId === undefined ? sql`false` : eq(vkMessageStates.vkMessageId, input.vkMessageId),
          input.vkConversationMessageId === undefined
            ? sql`false`
            : eq(vkMessageStates.vkConversationMessageId, input.vkConversationMessageId)
        )
      )
    )
    .limit(1);
  return row ? vkMessageStateRow(row) : undefined;
}

export async function appendVkMessageVersion(
  stateId: number,
  text: string,
  sourceSnapshot: string,
  vkDate?: number
): Promise<VkMessageStateRecord> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${stateId})`);
    const [state] = await tx.select().from(vkMessageStates).where(eq(vkMessageStates.id, stateId)).limit(1);
    if (!state) throw new Error(`VK message state ${stateId} was not found`);

    if (state.sourceSnapshot === sourceSnapshot) return vkMessageStateRow(state);
    if (state.currentText === text) {
      const [updatedSnapshot] = await tx
        .update(vkMessageStates)
        .set({ sourceSnapshot, updatedAt: sql`now()` })
        .where(eq(vkMessageStates.id, stateId))
        .returning();
      if (!updatedSnapshot) throw new Error(`VK message state ${stateId} could not be updated`);
      return vkMessageStateRow(updatedSnapshot);
    }

    const [version] = await tx
      .select({ next: sql<number>`coalesce(max(${vkMessageVersions.versionNo}), 0) + 1` })
      .from(vkMessageVersions)
      .where(eq(vkMessageVersions.stateId, stateId));
    await tx.insert(vkMessageVersions).values({
      stateId,
      versionNo: Number(version?.next ?? 1),
      text,
      vkDate: vkDate ?? null
    });

    const [updated] = await tx
      .update(vkMessageStates)
      .set({ currentText: text, sourceSnapshot, edited: true, deleted: false, updatedAt: sql`now()` })
      .where(eq(vkMessageStates.id, stateId))
      .returning();
    if (!updated) throw new Error(`VK message state ${stateId} could not be updated`);
    return vkMessageStateRow(updated);
  });
}

export async function setVkMessageSourceSnapshot(
  stateId: number,
  sourceSnapshot: string
): Promise<VkMessageStateRecord> {
  const [row] = await db
    .update(vkMessageStates)
    .set({ sourceSnapshot, updatedAt: sql`now()` })
    .where(eq(vkMessageStates.id, stateId))
    .returning();
  if (!row) throw new Error(`VK message state ${stateId} could not be updated`);
  return vkMessageStateRow(row);
}

export async function setVkMessageDeleted(stateId: number, deleted: boolean): Promise<VkMessageStateRecord> {
  const [row] = await db
    .update(vkMessageStates)
    .set({ deleted, updatedAt: sql`now()` })
    .where(eq(vkMessageStates.id, stateId))
    .returning();
  if (!row) throw new Error(`VK message state ${stateId} could not be updated`);
  return vkMessageStateRow(row);
}

export async function setVkMessageHistoryIds(stateId: number, historyMessageIds: number[]): Promise<void> {
  await db
    .update(vkMessageStates)
    .set({ historyMessageIds, updatedAt: sql`now()` })
    .where(eq(vkMessageStates.id, stateId));
}

export async function setVkMessagePrimaryTelegramMessage(stateId: number, telegramMessageId: number): Promise<void> {
  await db
    .update(vkMessageStates)
    .set({ telegramMessageId, updatedAt: sql`now()` })
    .where(eq(vkMessageStates.id, stateId));
}

export async function listVkMessageVersions(stateId: number): Promise<VkMessageVersionRecord[]> {
  const rows = await db
    .select({
      versionNo: vkMessageVersions.versionNo,
      text: vkMessageVersions.text,
      vkDate: vkMessageVersions.vkDate,
      createdAt: vkMessageVersions.createdAt
    })
    .from(vkMessageVersions)
    .where(eq(vkMessageVersions.stateId, stateId))
    .orderBy(asc(vkMessageVersions.versionNo));
  return rows.map((row) => ({
    versionNo: row.versionNo,
    text: row.text,
    vkDate: row.vkDate ?? undefined,
    createdAt: row.createdAt
  }));
}

export async function listVkMessageStatesThrough(
  vkPeerId: number,
  lastConversationMessageId: number
): Promise<VkMessageStateRecord[]> {
  const rows = await db
    .select()
    .from(vkMessageStates)
    .where(
      and(
        eq(vkMessageStates.vkPeerId, vkPeerId),
        isNotNull(vkMessageStates.vkConversationMessageId),
        lte(vkMessageStates.vkConversationMessageId, lastConversationMessageId)
      )
    );
  return rows.map(vkMessageStateRow);
}

type TransactionCallback = Parameters<typeof db.transaction>[0];
type TransactionDb = Parameters<TransactionCallback>[0];

export async function withAdvisoryLock<T>(key: number, fn: (tx: TransactionDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
    return fn(tx);
  });
}

function topicRow(row: {
  id: number;
  vkPeerId: number | null;
  telegramChatId: number;
  messageThreadId: number;
  name: string;
}) {
  return {
    id: String(row.id),
    vk_peer_id: String(row.vkPeerId),
    telegram_chat_id: String(row.telegramChatId),
    message_thread_id: row.messageThreadId,
    name: row.name
  };
}

function messageMapRow(row: {
  vkPeerId: number;
  vkMessageId: number | null;
  vkConversationMessageId: number | null;
  telegramChatId: number;
  telegramMessageId: number;
  telegramThreadId: number;
  direction: string;
}): MessageMapRow {
  return {
    vk_peer_id: String(row.vkPeerId),
    vk_message_id: nullableString(row.vkMessageId),
    vk_conversation_message_id: nullableString(row.vkConversationMessageId),
    telegram_chat_id: String(row.telegramChatId),
    telegram_message_id: String(row.telegramMessageId),
    telegram_thread_id: row.telegramThreadId,
    direction: row.direction === "vk_to_tg" ? "vk_to_tg" : "tg_to_vk"
  };
}

function vkMessageStateRow(row: typeof vkMessageStates.$inferSelect): VkMessageStateRecord {
  return {
    id: row.id,
    vkPeerId: row.vkPeerId,
    vkMessageId: row.vkMessageId,
    vkConversationMessageId: row.vkConversationMessageId ?? undefined,
    telegramChatId: row.telegramChatId,
    telegramMessageId: row.telegramMessageId,
    telegramThreadId: row.telegramThreadId,
    currentText: row.currentText,
    sourceSnapshot: row.sourceSnapshot ?? undefined,
    edited: row.edited,
    deleted: row.deleted,
    historyMessageIds: Array.isArray(row.historyMessageIds) ? row.historyMessageIds : []
  };
}

function vkReactionSummaryRow(row: typeof vkReactionSummaries.$inferSelect): VkReactionSummaryRecord {
  return {
    vkPeerId: row.vkPeerId,
    vkConversationMessageId: row.vkConversationMessageId,
    telegramChatId: row.telegramChatId,
    telegramMessageId: row.telegramMessageId,
    telegramThreadId: row.telegramThreadId,
    summaryTelegramMessageId: row.summaryTelegramMessageId,
    snapshot: row.snapshot
  };
}

function nullableString(value: number | null): string | null {
  return value === null ? null : String(value);
}
