import "dotenv/config";
import { databaseSchemaName } from "./databaseSchema.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Invalid integer env var ${name}: ${raw}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid integer env var ${name}: ${raw}`);
  }
  return parsed;
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = intEnv(name, fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid positive integer env var ${name}: ${value}`);
  }
  return value;
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const value = intEnv(name, fallback);
  if (value < 0) {
    throw new Error(`Invalid non-negative integer env var ${name}: ${value}`);
  }
  return value;
}

function optionalPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  return positiveIntEnv(name, 1);
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean env var ${name}: ${raw}`);
}

function bigintEnv(name: string): bigint {
  const raw = required(name);
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`Invalid bigint env var ${name}: ${raw}`);
  }
}

type DatabaseSslMode = "disable" | "require" | "verify-ca" | "verify-full";

const databaseUrl = required("DATABASE_URL");
const databaseUrlSsl = parseDatabaseUrlSsl(databaseUrl);
const databaseSslMode = parseDatabaseSslMode(databaseUrlSsl.sslMode ?? process.env.DATABASE_SSL_MODE ?? "verify-full");
const mediaMaxDownloadBytes = positiveIntEnv("MEDIA_MAX_DOWNLOAD_BYTES", 50 * 1024 * 1024);
const mediaMaxTgsDecompressedBytes = positiveIntEnv(
  "MEDIA_MAX_TGS_DECOMPRESSED_BYTES",
  mediaMaxDownloadBytes
);
const vkFloodRetryBaseMs = positiveIntEnv("VK_FLOOD_RETRY_BASE_MS", 15 * 60 * 1000);
const vkFloodRetryMaxMs = positiveIntEnv("VK_FLOOD_RETRY_MAX_MS", 2 * 60 * 60 * 1000);
if (vkFloodRetryMaxMs < vkFloodRetryBaseMs) {
  throw new Error("VK_FLOOD_RETRY_MAX_MS must be greater than or equal to VK_FLOOD_RETRY_BASE_MS");
}

export const config = {
  databaseUrl,
  database: {
    url: databaseUrl,
    schema: databaseSchemaName,
    sslMode: databaseSslMode,
    sslRejectUnauthorized: boolEnv(
      "DATABASE_SSL_REJECT_UNAUTHORIZED",
      databaseSslMode === "verify-ca" || databaseSslMode === "verify-full"
    ),
    sslCaPath: process.env.DATABASE_SSL_CA_PATH ?? databaseUrlSsl.sslCaPath,
    sslCertPath: process.env.DATABASE_SSL_CERT_PATH ?? databaseUrlSsl.sslCertPath,
    sslKeyPath: process.env.DATABASE_SSL_KEY_PATH ?? databaseUrlSsl.sslKeyPath
  },
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    chatId: bigintEnv("TELEGRAM_CHAT_ID"),
    maxActiveTopics: positiveIntEnv("TELEGRAM_MAX_ACTIVE_TOPICS", 100),
    reactionUserId: optionalPositiveIntEnv("TELEGRAM_REACTION_USER_ID"),
    apiId: optionalPositiveIntEnv("TELEGRAM_API_ID"),
    apiHash: process.env.TELEGRAM_API_HASH?.trim() || undefined,
    userSession: process.env.TELEGRAM_USER_SESSION?.trim() || undefined
  },
  vk: {
    accessToken: required("VK_ACCESS_TOKEN"),
    photoAccessToken: process.env.VK_PHOTO_ACCESS_TOKEN?.trim() || undefined,
    apiVersion: process.env.VK_API_VERSION || "5.199",
    longPollVersion: positiveIntEnv("VK_LONG_POLL_VERSION", 21),
    longPollWaitSeconds: positiveIntEnv("VK_LONG_POLL_WAIT_SECONDS", 25)
  },
  media: {
    maxDownloadBytes: mediaMaxDownloadBytes,
    maxTgsDecompressedBytes: mediaMaxTgsDecompressedBytes
  },
  stickers: {
    mappingPath: process.env.STICKER_MAPPING_PATH?.trim() || "sticker-mapping.json"
  },
  runtime: {
    retryBaseMs: positiveIntEnv("POLL_RETRY_BASE_MS", 1000),
    vkApiMinIntervalMs: nonNegativeIntEnv("VK_API_MIN_INTERVAL_MS", 350),
    vkFloodRetryBaseMs,
    vkFloodRetryMaxMs,
    metadataRefreshMs: positiveIntEnv("METADATA_REFRESH_MS", 10 * 60 * 1000),
    logRepeatWindowMs: positiveIntEnv("LOG_REPEAT_WINDOW_MS", 5 * 60 * 1000),
    requestTimeoutMs: positiveIntEnv("NETWORK_REQUEST_TIMEOUT_MS", 30_000),
    mediaTimeoutMs: positiveIntEnv("NETWORK_MEDIA_TIMEOUT_MS", 120_000),
    maxNetworkRetries: nonNegativeIntEnv("NETWORK_MAX_RETRIES", 3)
  }
} as const;

function parseDatabaseSslMode(input: string): DatabaseSslMode {
  const normalized = input.trim().toLowerCase();
  if (
    normalized === "disable" ||
    normalized === "require" ||
    normalized === "verify-ca" ||
    normalized === "verify-full"
  ) {
    return normalized;
  }
  throw new Error(`Invalid DATABASE_SSL_MODE: ${input}`);
}

function parseDatabaseUrlSsl(input: string): {
  sslMode?: DatabaseSslMode;
  sslCaPath?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
} {
  try {
    const url = new URL(input);
    const sslMode = url.searchParams.get("sslmode");
    return {
      sslMode: sslMode ? parseDatabaseSslMode(sslMode) : undefined,
      sslCaPath: url.searchParams.get("sslrootcert") ?? url.searchParams.get("sslca") ?? undefined,
      sslCertPath: url.searchParams.get("sslcert") ?? undefined,
      sslKeyPath: url.searchParams.get("sslkey") ?? undefined
    };
  } catch {
    return {};
  }
}
