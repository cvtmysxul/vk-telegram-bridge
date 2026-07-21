import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  type PgTableFn,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { databaseSchemaName } from "./databaseSchema.js";

const databaseTable: PgTableFn<string | undefined> =
  databaseSchemaName === "public" ? pgTable : pgSchema(databaseSchemaName).table;

export const schemaMigrations = databaseTable("schema_migrations", {
  name: text("name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow()
});

export const appState = databaseTable("app_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const vkPeers = databaseTable("vk_peers", {
  peerId: bigint("peer_id", { mode: "number" }).primaryKey(),
  displayName: text("display_name").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  title: text("title"),
  isChat: boolean("is_chat").notNull().default(false),
  raw: jsonb("raw").$type<unknown>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const topics = databaseTable(
  "topics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    vkPeerId: bigint("vk_peer_id", { mode: "number" })
      .unique()
      .references(() => vkPeers.peerId, { onDelete: "cascade" }),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    messageThreadId: integer("message_thread_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("topics_active_thread_idx")
      .on(table.telegramChatId, table.messageThreadId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("topics_lru_idx").on(table.createdAt).where(sql`${table.deletedAt} IS NULL AND ${table.vkPeerId} IS NOT NULL`)
  ]
);

export const messageMap = databaseTable(
  "message_map",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    vkPeerId: bigint("vk_peer_id", { mode: "number" }).notNull(),
    vkMessageId: bigint("vk_message_id", { mode: "number" }),
    vkConversationMessageId: bigint("vk_conversation_message_id", { mode: "number" }),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    telegramThreadId: integer("telegram_thread_id").notNull(),
    direction: text("direction").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("message_map_telegram_idx").on(table.telegramChatId, table.telegramMessageId),
    index("message_map_vk_idx").on(table.vkPeerId, table.vkMessageId),
    index("message_map_vk_cmid_idx").on(table.vkPeerId, table.vkConversationMessageId),
    check("message_map_direction_check", sql`${table.direction} IN ('vk_to_tg', 'tg_to_vk')`)
  ]
);

export const peerPins = databaseTable("peer_pins", {
  vkPeerId: bigint("vk_peer_id", { mode: "number" }).primaryKey(),
  vkMessageId: bigint("vk_message_id", { mode: "number" }),
  vkConversationMessageId: bigint("vk_conversation_message_id", { mode: "number" }),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
  telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
  telegramThreadId: integer("telegram_thread_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const topicInfoMessages = databaseTable(
  "topic_info_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    vkPeerId: bigint("vk_peer_id", { mode: "number" })
      .notNull()
      .references(() => vkPeers.peerId, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    telegramThreadId: integer("telegram_thread_id").notNull(),
    snapshot: text("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("topic_info_messages_telegram_idx").on(table.telegramChatId, table.telegramMessageId),
    index("topic_info_messages_peer_kind_idx").on(table.vkPeerId, table.kind)
  ]
);

export const vkButtonActions = databaseTable(
  "vk_button_actions",
  {
    id: text("id").primaryKey(),
    vkPeerId: bigint("vk_peer_id", { mode: "number" }).notNull(),
    vkMessageId: bigint("vk_message_id", { mode: "number" }),
    vkConversationMessageId: bigint("vk_conversation_message_id", { mode: "number" }),
    vkAuthorId: bigint("vk_author_id", { mode: "number" }),
    vkInline: boolean("vk_inline").notNull().default(false),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    actionType: text("action_type").notNull(),
    label: text("label").notNull(),
    payload: text("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("vk_button_actions_telegram_idx").on(table.telegramChatId, table.telegramMessageId),
    index("vk_button_actions_vk_idx").on(table.vkPeerId, table.vkMessageId)
  ]
);

export const vkMessageStates = databaseTable(
  "vk_message_states",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    vkPeerId: bigint("vk_peer_id", { mode: "number" }).notNull(),
    vkMessageId: bigint("vk_message_id", { mode: "number" }).notNull(),
    vkConversationMessageId: bigint("vk_conversation_message_id", { mode: "number" }),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    telegramThreadId: integer("telegram_thread_id").notNull(),
    currentText: text("current_text").notNull(),
    sourceSnapshot: text("source_snapshot"),
    edited: boolean("edited").notNull().default(false),
    deleted: boolean("deleted").notNull().default(false),
    historyMessageIds: jsonb("history_message_ids").$type<number[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("vk_message_states_vk_message_idx").on(table.vkPeerId, table.vkMessageId),
    index("vk_message_states_vk_cmid_idx").on(table.vkPeerId, table.vkConversationMessageId)
  ]
);

export const vkReactionSummaries = databaseTable(
  "vk_reaction_summaries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    vkPeerId: bigint("vk_peer_id", { mode: "number" }).notNull(),
    vkConversationMessageId: bigint("vk_conversation_message_id", { mode: "number" }).notNull(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    telegramThreadId: integer("telegram_thread_id").notNull(),
    summaryTelegramMessageId: bigint("summary_telegram_message_id", { mode: "number" }).notNull(),
    snapshot: text("snapshot").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("vk_reaction_summaries_vk_message_idx").on(
      table.vkPeerId,
      table.vkConversationMessageId
    ),
    index("vk_reaction_summaries_telegram_idx").on(
      table.telegramChatId,
      table.summaryTelegramMessageId
    )
  ]
);

export const vkMessageVersions = databaseTable(
  "vk_message_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    stateId: bigint("state_id", { mode: "number" })
      .notNull()
      .references(() => vkMessageStates.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    text: text("text").notNull(),
    vkDate: integer("vk_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("vk_message_versions_state_version_idx").on(table.stateId, table.versionNo)]
);
