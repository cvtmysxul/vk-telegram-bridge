import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("topic repository always scopes thread lookups and deletion by chat", async () => {
  const [repositories, bridgeService, topicService, dbSource] = await Promise.all([
    readFile(resolve(root, "src/repositories.ts"), "utf8"),
    readFile(resolve(root, "src/services/bridgeService.ts"), "utf8"),
    readFile(resolve(root, "src/services/topicService.ts"), "utf8"),
    readFile(resolve(root, "src/db.ts"), "utf8")
  ]);

  assert.match(repositories, /getTopicByThread\(telegramChatId: number, threadId: number\)/);
  assert.match(repositories, /eq\(topics\.telegramChatId, telegramChatId\)/);
  assert.match(repositories, /markTopicDeleted\(telegramChatId: number, threadId: number\)/);
  assert.match(repositories, /eq\(topicInfoMessages\.telegramChatId, telegramChatId\)/);
  assert.equal((bridgeService.match(/getTopicByThread\(message\.chat\.id,/g) ?? []).length, 5);
  assert.equal((topicService.match(/markTopicDeleted\(this\.telegram\.chatId,/g) ?? []).length, 2);
  assert.match(dbSource, /BRIDGE_TELEGRAM_CHAT_ID_STATE_KEY/);
  assert.match(dbSource, /value: \{ chatId: expectedChatId \}/);
  assert.match(dbSource, /function readBoundTelegramChatId/);
  assert.match(dbSource, /onConflictDoNothing\(\)/);
  assert.match(dbSource, /already bound to a different Telegram chat/);
});

test("database connections default to verified TLS unless explicitly disabled", () => {
  assert.equal(configSslMode({}), "verify-full");
  assert.equal(configSslMode({ DATABASE_SSL_MODE: "disable" }), "disable");
  assert.equal(
    configSslMode({ DATABASE_URL: "postgres://bridge:bridge@db.example.invalid:5432/bridge?sslmode=disable" }),
    "disable"
  );
  assert.equal(poolUsesSsl({}), true);
  assert.equal(poolUsesSsl({ DATABASE_SSL_MODE: "disable" }), false);
});

test("configuration rejects malformed or unsafe numeric values", () => {
  assertConfigFailure({ TELEGRAM_MAX_ACTIVE_TOPICS: "12topics" }, /Invalid integer env var TELEGRAM_MAX_ACTIVE_TOPICS/);
  assertConfigFailure({ TELEGRAM_MAX_ACTIVE_TOPICS: "0" }, /Invalid positive integer env var TELEGRAM_MAX_ACTIVE_TOPICS/);
  assertConfigFailure({ NETWORK_MAX_RETRIES: "-1" }, /Invalid non-negative integer env var NETWORK_MAX_RETRIES/);
  assertConfigFailure({ NETWORK_REQUEST_TIMEOUT_MS: "0" }, /Invalid positive integer env var NETWORK_REQUEST_TIMEOUT_MS/);
});

test("remote reads stop before accumulating past the configured byte limit", async () => {
  const { readResponseBodyWithinLimit } = await import("../dist/util.js");
  let pulls = 0;
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(40));
      },
      cancel() {
        canceled = true;
      }
    })
  );

  await assert.rejects(readResponseBodyWithinLimit(response, 64), /Remote media exceeds configured limit/);
  assert.equal(pulls, 2);
  assert.equal(canceled, true);

  const valid = await readResponseBodyWithinLimit(new Response(new Uint8Array(64)), 64);
  assert.equal(valid.length, 64);

  const [bridgeSource, telegramClientSource] = await Promise.all([
    readFile(resolve(root, "src/services/bridgeService.ts"), "utf8"),
    readFile(resolve(root, "src/telegram/client.ts"), "utf8")
  ]);
  assert.doesNotMatch(bridgeSource, /await response\.arrayBuffer\(\)/);
  assert.doesNotMatch(telegramClientSource, /await response\.arrayBuffer\(\)/);
});

test("TGS decompression cannot expand past its configured output budget", async () => {
  const { gunzipWithinLimit } = await import("../dist/util.js");
  const compressed = gzipSync(Buffer.alloc(256 * 1024, 65));

  await assert.rejects(gunzipWithinLimit(compressed, 64 * 1024), /decompressed limit/);
  assert.deepEqual(await gunzipWithinLimit(gzipSync(Buffer.from("{}")), 64), Buffer.from("{}"));
});

test("operator scripts redact credentials and avoid printing the MTProto session", async () => {
  const [safeLog, sessionSource, syncSource] = await Promise.all([
    import("../scripts/lib/safe-log.mjs"),
    readFile(resolve(root, "src/telegram/createUserSession.ts"), "utf8"),
    readFile(resolve(root, "scripts/sync-sticker-map.mjs"), "utf8")
  ]);
  const secret = "123456:super-secret-token";

  assert.doesNotMatch(safeLog.shortError(new Error(`Download failed: https://api.telegram.org/file/bot${secret}/photo`), [secret]), /super-secret-token/);
  assert.equal(safeLog.safeRemoteLabel(`https://api.telegram.org/file/bot${secret}/photo`), "https://api.telegram.org");
  assert.match(sessionSource, /hiddenQuestion\("Telegram 2FA password: "\)/);
  assert.match(sessionSource, /writeFile\(sessionOutputPath/);
  assert.doesNotMatch(sessionSource, /TELEGRAM_USER_SESSION=\$\{session\.save\(\)\}/);
  assert.doesNotMatch(syncSource, /Download failed \$\{response\.status\}: \$\{url\}/);
});

test("Telegram topic metadata is not relayed as an unsupported attachment", () => {
  const output = runWithConfig(
    {},
    [
      "const { telegramUnsupportedContentText } = await import('./dist/services/bridgeService.js');",
      "const message = { message_id: 1, message_thread_id: 42, is_topic_message: true, chat: { id: -1000000000000, type: 'supergroup', is_forum: true }, date: 0 };",
      "console.log(telegramUnsupportedContentText(message) ?? 'none');",
      "const { pool } = await import('./dist/db.js');",
      "await pool.end();"
    ].join(" ")
  );

  assert.equal(output, "none");
});

function configSslMode(overrides) {
  return runWithConfig(overrides, "const { config } = await import('./dist/config.js'); console.log(config.database.sslMode);");
}

function poolUsesSsl(overrides) {
  return (
    runWithConfig(
      overrides,
      "const { pool } = await import('./dist/db.js'); console.log(pool.options.ssl ? 'enabled' : 'disabled'); await pool.end();"
    ) === "enabled"
  );
}

function runWithConfig(overrides, code) {
  const result = runConfig(overrides, code);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function assertConfigFailure(overrides, pattern) {
  const result = runConfig(overrides, "await import('./dist/config.js');");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
}

function runConfig(overrides, code) {
  const env = {
    ...process.env,
    DATABASE_URL: "postgres://bridge:bridge@db.example.invalid:5432/bridge",
    DATABASE_SCHEMA: "security_test",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_CHAT_ID: "-1000000000000",
    VK_ACCESS_TOKEN: "test-vk-token",
    DOTENV_CONFIG_PATH: resolve(root, "test/.env.dmitrii.not-used"),
    ...overrides
  };
  delete env.DATABASE_SSL_MODE;
  if (Object.hasOwn(overrides, "DATABASE_SSL_MODE")) env.DATABASE_SSL_MODE = overrides.DATABASE_SSL_MODE;

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", code],
    { cwd: root, env, encoding: "utf8" }
  );
  return result;
}
