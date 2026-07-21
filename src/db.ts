import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConnectionOptions } from "node:tls";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { config } from "./config.js";
import * as schema from "./schema.js";
import { appState, schemaMigrations } from "./schema.js";

const BRIDGE_TELEGRAM_CHAT_ID_STATE_KEY = "bridge_telegram_chat_id";

export const pool = new Pool(createPoolConfig());
export const db = drizzle(pool, { schema });

export async function migrate(): Promise<void> {
  const databaseSchema = sql.identifier(config.database.schema);

  if (config.database.schema !== "public") {
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${databaseSchema}`);
  }

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ${databaseSchema}.${sql.identifier("schema_migrations")} (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrations = [
    "001_init.sql",
    "002_vk_button_actions.sql",
    "003_vk_message_versions.sql",
    "004_vk_message_source_snapshot.sql",
    "005_vk_reaction_summaries.sql",
    "006_topic_info_messages.sql"
  ];
  for (const name of migrations) {
    const applied = await db
      .select({ name: schemaMigrations.name })
      .from(schemaMigrations)
      .where(eq(schemaMigrations.name, name))
      .limit(1);
    if (applied.length) continue;

    const migrationSql = await readFile(join(process.cwd(), "migrations", name), "utf8");
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL search_path TO ${databaseSchema}`);
      await tx.execute(sql.raw(migrationSql));
      await tx.insert(schemaMigrations).values({ name });
    });
  }

  await bindSchemaToTelegramChat();
}

export async function getState<T>(key: string): Promise<T | undefined> {
  const rows = await db.select({ value: appState.value }).from(appState).where(eq(appState.key, key)).limit(1);
  return rows[0]?.value as T | undefined;
}

export async function setState(key: string, value: unknown): Promise<void> {
  await db
    .insert(appState)
    .values({ key, value })
    .onConflictDoUpdate({
      target: appState.key,
      set: {
        value,
        updatedAt: sql`now()`
      }
    });
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

async function bindSchemaToTelegramChat(): Promise<void> {
  const expectedChatId = config.telegram.chatId.toString();

  await db.transaction(async (tx) => {
    await tx
      .insert(appState)
      .values({ key: BRIDGE_TELEGRAM_CHAT_ID_STATE_KEY, value: { chatId: expectedChatId } })
      .onConflictDoNothing();

    const [binding] = await tx
      .select({ value: appState.value })
      .from(appState)
      .where(eq(appState.key, BRIDGE_TELEGRAM_CHAT_ID_STATE_KEY))
      .limit(1);
    const boundChatId = readBoundTelegramChatId(binding?.value);
    if (boundChatId !== expectedChatId) {
      throw new Error(
        `DATABASE_SCHEMA ${config.database.schema} is already bound to a different Telegram chat; use a separate DATABASE_SCHEMA`
      );
    }
  });
}

function readBoundTelegramChatId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("chatId" in value)) return undefined;
  const chatId = value.chatId;
  return typeof chatId === "string" ? chatId : undefined;
}

function createPoolConfig(): PoolConfig {
  const poolConfig: PoolConfig = {
    connectionString: config.database.url,
    connectionTimeoutMillis: config.runtime.requestTimeoutMs,
    query_timeout: config.runtime.requestTimeoutMs,
    statement_timeout: config.runtime.requestTimeoutMs
  };
  if (config.database.sslMode !== "disable") {
    poolConfig.ssl = createSslConfig();
  }
  return poolConfig;
}

function createSslConfig(): ConnectionOptions {
  const ssl: ConnectionOptions = {
    rejectUnauthorized: config.database.sslRejectUnauthorized
  };

  if (config.database.sslMode === "verify-ca") {
    ssl.checkServerIdentity = () => undefined;
  }

  if (config.database.sslCaPath) {
    ssl.ca = readFileSync(config.database.sslCaPath, "utf8");
  }
  if (config.database.sslCertPath) {
    ssl.cert = readFileSync(config.database.sslCertPath, "utf8");
  }
  if (config.database.sslKeyPath) {
    ssl.key = readFileSync(config.database.sslKeyPath, "utf8");
  }

  return ssl;
}
