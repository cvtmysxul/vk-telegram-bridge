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
  assertConfigFailure({ VK_API_MIN_INTERVAL_MS: "-1" }, /Invalid non-negative integer env var VK_API_MIN_INTERVAL_MS/);
  assertConfigFailure(
    { VK_FLOOD_RETRY_BASE_MS: "200", VK_FLOOD_RETRY_MAX_MS: "100" },
    /VK_FLOOD_RETRY_MAX_MS must be greater than or equal to VK_FLOOD_RETRY_BASE_MS/
  );
});

test("VK Flood Control is not retried in a tight loop and pauses the shared API queue", () => {
  const output = runWithConfig(
    {
      NETWORK_MAX_RETRIES: "3",
      VK_API_MIN_INTERVAL_MS: "50",
      VK_FLOOD_RETRY_BASE_MS: "30",
      VK_FLOOD_RETRY_MAX_MS: "30"
    },
    [
      "const { VkClient } = await import('./dist/vk/client.js');",
      "let calls = 0;",
      "globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify(calls === 1 ? { error: { error_code: 9, error_msg: 'Flood control' } } : { response: { ok: true } })); };",
      "const client = new VkClient();",
      "await client.api('messages.getLongPollServer').catch(() => undefined);",
      "const started = Date.now();",
      "await client.api('groups.getById');",
      "console.log(JSON.stringify({ calls, waitedAtLeast45Ms: Date.now() - started >= 45, floodCooldownCleared: client.floodCooldownRemainingMs() === 0 }));"
    ].join(" ")
  );

  assert.equal(output, '{"calls":2,"waitedAtLeast45Ms":true,"floodCooldownCleared":true}');
});

test("VK API requests are serialized across concurrent bridge work", () => {
  const output = runWithConfig(
    { NETWORK_MAX_RETRIES: "0", VK_API_MIN_INTERVAL_MS: "0" },
    [
      "const { VkClient } = await import('./dist/vk/client.js');",
      "let active = 0; let maxActive = 0;",
      "globalThis.fetch = async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1; return new Response(JSON.stringify({ response: { ok: true } })); };",
      "const client = new VkClient();",
      "await Promise.all([client.api('users.get'), client.api('groups.getById'), client.api('messages.getLongPollServer')]);",
      "console.log(JSON.stringify({ maxActive }));"
    ].join(" ")
  );

  assert.equal(output, '{"maxActive":1}');
});

test("VK polling preserves its failure streak until Long Poll recovery succeeds", async () => {
  const bridgeService = await readFile(resolve(root, "src/services/bridgeService.ts"), "utf8");
  const check = bridgeService.indexOf("const check = await this.checkVkLongPoll(state);");
  const recovery = bridgeService.indexOf("state = await this.handleVkLongPollFailure(state, check);", check);
  const reset = bridgeService.indexOf("consecutiveFailures = 0;", check);

  assert.ok(check >= 0 && recovery > check && reset > recovery);
  assert.match(bridgeService, /if \(this\.vk\.floodCooldownRemainingMs\(\) > 0\) continue;/);
  assert.match(bridgeService, /if \(isVkFloodControlError\(error\)\) break;/);
});

test("alternating identical Telegram logs are coalesced", () => {
  const output = runWithConfig(
    { LOG_REPEAT_WINDOW_MS: "1000" },
    [
      "const { LogService } = await import('./dist/services/logService.js');",
      "const sent = []; const telegram = { sendMessage: async (message) => { sent.push(message.text); } };",
      "const logs = new LogService(telegram);",
      "await logs.error('VK polling failed', new Error('Flood control'));",
      "await logs.error('Metadata refresh failed', new Error('Flood control'));",
      "await logs.error('VK polling failed', new Error('Flood control'));",
      "await new Promise((resolve) => setTimeout(resolve, 10));",
      "console.log(JSON.stringify({ sent: sent.length }));"
    ].join(" ")
  );

  assert.equal(output, '{"sent":2}');
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

test("renaming a topic leaves its manually selected icon untouched", async () => {
  const topicService = await readFile(resolve(root, "src/services/topicService.ts"), "utf8");

  assert.match(
    topicService,
    /if \(input\.currentName !== input\.name\) await this\.telegram\.editForumTopic\(input\.threadId, input\.name\);/
  );
  assert.doesNotMatch(topicService, /iconSyncedThreads/);
});

test("an extra stale topic-info record does not recreate a current profile pin", () => {
  const output = runWithConfig(
    {},
    [
      "const { countCurrentTopicInfoMessages, hasCurrentTopicInfoMessages } = await import('./dist/services/topicService.js');",
      "const current = JSON.stringify({ type: 'VK-чат', displayName: 'Чат', avatarUrl: '/avatar.jpg' });",
      "const stale = JSON.stringify({ type: 'VK-чат', displayName: 'Старое имя', avatarUrl: '/avatar.jpg' });",
      "const messages = [{ snapshot: current, telegramThreadId: 42 }, { snapshot: stale, telegramThreadId: 42 }];",
      "console.log(hasCurrentTopicInfoMessages(countCurrentTopicInfoMessages(messages, { snapshot: current, threadId: 42 }), 1));",
      "const { pool } = await import('./dist/db.js');",
      "await pool.end();"
    ].join(" ")
  );

  assert.equal(output, "true");
});

test("incomplete VK names and low-resolution avatar fallbacks are rejected", () => {
  const output = runWithConfig(
    {},
    [
      "const { VkClient } = await import('./dist/vk/client.js');",
      "const errors = [];",
      "const missingName = new VkClient();",
      "missingName.api = async () => [{ id: 7, photo_200: 'https://cdn.example/avatar-200.jpg' }];",
      "try { await missingName.getPeerInfo(7); } catch (error) { errors.push(error.message); }",
      "const lowResolution = new VkClient();",
      "lowResolution.api = async () => [{ id: 8, first_name: 'Иван', last_name: 'Иванов', photo_50: 'https://cdn.example/avatar-50.jpg' }];",
      "try { await lowResolution.getPeerInfo(8); } catch (error) { errors.push(error.message); }",
      "console.log(JSON.stringify(errors));"
    ].join(" ")
  );

  assert.equal(
    output,
    '["VK returned incomplete metadata for peer 7: missing user name","VK returned only a low-resolution avatar for peer 8"]'
  );
});

test("a metadata change must be identical in five VK responses", async () => {
  const output = runWithConfig(
    {},
    [
      "const { peerInfoMetadataEqual } = await import('./dist/services/topicService.js');",
      "const base = { peerId: 7, displayName: 'Иван Иванов', avatarUrl: 'https://cdn.example/avatar.jpg?token=one', isChat: false, raw: {} };",
      "const same = { ...base, avatarUrl: 'https://cdn.example/avatar.jpg?token=two' };",
      "const badName = { ...base, displayName: 'VK user 7' };",
      "const missingAvatar = { ...base, avatarUrl: undefined };",
      "console.log(JSON.stringify([peerInfoMetadataEqual(base, same), peerInfoMetadataEqual(base, badName), peerInfoMetadataEqual(base, missingAvatar)]));",
      "const { pool } = await import('./dist/db.js');",
      "await pool.end();"
    ].join(" ")
  );

  assert.equal(output, "[true,false,false]");

  const topicService = await readFile(resolve(root, "src/services/topicService.ts"), "utf8");
  assert.match(topicService, /const VK_METADATA_CONFIRMATION_SAMPLES = 5;/);
  assert.match(topicService, /sample < VK_METADATA_CONFIRMATION_SAMPLES/);
  assert.match(topicService, /confirmation = await this\.vk\.getPeerInfo\(peerId\);/);
  assert.match(topicService, /if \(!peerInfoMetadataEqual\(candidate, confirmation\)\)/);
  assert.match(topicService, /!allowAvatarRemoval[\s\S]*!candidate\.avatarUrl/);
});

test("a failed replacement keeps the previous profile pin", async () => {
  const [topicService, repositories] = await Promise.all([
    readFile(resolve(root, "src/services/topicService.ts"), "utf8"),
    readFile(resolve(root, "src/repositories.ts"), "utf8")
  ]);
  const sendNew = topicService.indexOf("const sent = await input.send();");
  const unpinPrevious = topicService.indexOf("for (const message of previous)", sendNew);

  assert.ok(sendNew >= 0 && unpinPrevious > sendNew);
  assert.match(topicService, /await replaceTopicInfoMessages\(input\.peer\.peerId, input\.kind, records\);/);
  assert.doesNotMatch(topicService, /sending profile text instead/);
  assert.match(repositories, /await db\.transaction\(async \(transaction\) =>/);
});

test("a VK chat that forbids forwarded replies receives the Telegram text without its reply link", () => {
  const output = runWithConfig(
    {},
    [
      "const { VkApiError, VkClient } = await import('./dist/vk/client.js');",
      "const client = new VkClient();",
      "const calls = [];",
      "client.api = async (_method, params) => { calls.push(params); if (calls.length === 1) throw new VkApiError('messages.send', 994, 'Chat forward disabled'); return { message_id: 10, conversation_message_id: 20, peer_id: params.peer_id }; };",
      "const sent = await client.sendMessage({ peerId: 2000000001, text: 'Тест', replyToMessageId: 9 });",
      "console.log(JSON.stringify({ replies: calls.map((call) => call.reply_to ?? null), replyFallback: sent.replyFallback }));"
    ].join(" ")
  );

  assert.equal(output, '{"replies":[9,null],"replyFallback":true}');
});

test("Telegram URL fetch rejection retries a profile photo as multipart with its caption and topic", () => {
  runWithConfig({}, `
    import assert from 'node:assert/strict';
    const { TelegramClient } = await import('./dist/telegram/client.js');
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' }, { status: 400 });
      if (calls.length === 2) return new Response(Buffer.from('image-bytes'), { headers: { 'content-type': 'image/jpeg' } });
      return Response.json({ ok: true, result: { message_id: 12 } });
    };
    const sent = await new TelegramClient().sendPhoto({ file: 'https://cdn.example/avatar.jpg', filename: 'vk-avatar.jpg', caption: 'Профиль', message_thread_id: 42, reply_to_message_id: 8, disable_notification: true });
    assert.equal(sent.message_id, 12);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].url, 'https://cdn.example/avatar.jpg');
    const form = calls[2].init.body;
    assert.ok(form instanceof FormData);
    assert.equal(await form.get('photo').text(), 'image-bytes');
    assert.equal(form.get('photo').name, 'vk-avatar.jpg');
    assert.equal(form.get('photo').type, 'image/jpeg');
    assert.equal(form.get('caption'), 'Профиль');
    assert.equal(form.get('message_thread_id'), '42');
    assert.equal(form.get('disable_notification'), 'true');
    assert.deepEqual(JSON.parse(form.get('reply_parameters')), { message_id: 8, allow_sending_without_reply: true });
  `);
});

test("Telegram does not resend photos after ambiguous failures or unrelated rejections", () => {
  runWithConfig({}, `
    import assert from 'node:assert/strict';
    const { TelegramClient } = await import('./dist/telegram/client.js');
    for (const failure of ['network', 'Bad Request: message thread not found']) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (failure === 'network') throw new Error('connection reset');
        return Response.json({ ok: false, error_code: 400, description: failure }, { status: 400 });
      };
      await assert.rejects(new TelegramClient().sendPhoto({ file: 'https://cdn.example/avatar.jpg' }));
      assert.equal(calls, 1);
    }
  `);
});

test("Telegram photo fallback respects download failures and byte limits", () => {
  runWithConfig({ MEDIA_MAX_DOWNLOAD_BYTES: "4" }, `
    import assert from 'node:assert/strict';
    const { config } = await import('./dist/config.js');
    config.media.maxDownloadBytes = 4;
    const { TelegramClient } = await import('./dist/telegram/client.js');
    for (const status of [403, 200]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (calls === 1) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' });
        return new Response('too-large', { status });
      };
      await assert.rejects(new TelegramClient().sendPhoto({ file: 'https://cdn.example/avatar.jpg' }), status === 403 ? /HTTP 403/ : /exceeds configured limit/);
      assert.equal(calls, 2);
    }
  `);
});

test("VK keeps the photo upload path when allowed and never falls back after an uncertain upload", () => {
  runWithConfig({ NETWORK_MAX_RETRIES: '0' }, `
    import assert from 'node:assert/strict';
    const { VkClient, VkApiError } = await import('./dist/vk/client.js');
    const client = new VkClient();
    let documentCalls = 0;
    client.uploadMessageDocument = async () => { documentCalls++; return 'doc7_12'; };
    client.api = async (method) => method === 'photos.getMessagesUploadServer' ? { upload_url: 'https://upload.example/photo' } : [{ owner_id: 7, id: 12 }];
    globalThis.fetch = async () => Response.json({ server: 1, photo: 'uploaded-photo', hash: 'hash' });
    assert.equal(await client.uploadMessagePhoto(7, Buffer.from('image'), 'photo.jpg'), 'photo7_12');
    globalThis.fetch = async () => { throw new Error('connection reset'); };
    await assert.rejects(client.uploadMessagePhoto(7, Buffer.from('image'), 'photo.jpg'));
    client.api = async (method) => { throw new VkApiError(method, 9, 'Flood control'); };
    await assert.rejects(client.uploadMessagePhoto(7, Buffer.from('image'), 'photo.jpg'), /Flood control/);
    assert.equal(documentCalls, 0);
  `);
});

test("VK photo scope denial never substitutes a document and explains the required access", () => {
  runWithConfig({}, `
    import assert from 'node:assert/strict';
    const { VkClient, VkApiError } = await import('./dist/vk/client.js');
    const client = new VkClient();
    const denied = new VkApiError('photos.getMessagesUploadServer', 15, 'Access denied: no access to call this method. It cannot be called with current scopes.');
    const methods = [];
    let documentCalls = 0;
    let uploadCalls = 0;
    client.api = async (method) => { methods.push(method); throw denied; };
    client.uploadMessageDocument = async () => { documentCalls++; return 'doc7_12'; };
    globalThis.fetch = async () => { uploadCalls++; throw new Error('Unexpected upload'); };
    await assert.rejects(client.uploadMessagePhoto(7, Buffer.from('image'), 'photo.jpg'), (error) => {
      assert.match(error.message, /Configure VK_PHOTO_ACCESS_TOKEN with photos permission for the same account/);
      assert.equal(error.cause, denied);
      return true;
    });
    assert.deepEqual(methods, ['photos.getMessagesUploadServer']);
    assert.equal(documentCalls, 0);
    assert.equal(uploadCalls, 0);
  `);
});

test("a secondary photo token uploads and saves a photo while messaging keeps the primary token", () => {
  runWithConfig({ VK_PHOTO_ACCESS_TOKEN: 'test-photo-token', VK_API_MIN_INTERVAL_MS: '0' }, `
    import assert from 'node:assert/strict';
    const { VkClient } = await import('./dist/vk/client.js');
    const client = new VkClient();
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const method = url.split('/').pop();
      calls.push(method);
      if (url === 'https://upload.example/photo') {
        assert.equal(await init.body.get('photo').text(), 'image-bytes');
        return Response.json({ server: 1, photo: 'saved-image', hash: 'hash' });
      }
      const photoMethod = ['photos.getMessagesUploadServer', 'photos.saveMessagesPhoto'].includes(method);
      assert.equal(init.headers.authorization, 'Bearer ' + (photoMethod ? 'test-photo-token' : 'test-vk-token'));
      if (method === 'photos.getMessagesUploadServer') return Response.json({ response: { upload_url: 'https://upload.example/photo' } });
      if (method === 'photos.saveMessagesPhoto') return Response.json({ response: [{ owner_id: 7, id: 12, access_key: 'key' }] });
      if (method === 'messages.send') {
        assert.equal(init.body.get('attachment'), 'photo7_12_key');
        return Response.json({ response: { message_id: 55, conversation_message_id: 12, peer_id: 7 } });
      }
      return Response.json({ response: {} });
    };
    const attachment = await client.uploadMessagePhoto(7, Buffer.from('image-bytes'), 'photo.jpg');
    assert.equal(attachment, 'photo7_12_key');
    await client.sendMessage({ peerId: 7, attachments: [attachment] });
    await client.api('messages.getLongPollServer');
    await client.api('docs.getMessagesUploadServer');
    assert.deepEqual(calls, ['photos.getMessagesUploadServer', 'photo', 'photos.saveMessagesPhoto', 'messages.send', 'messages.getLongPollServer', 'docs.getMessagesUploadServer']);
  `);
});

test("photo uploads use the primary token when no secondary token is configured", () => {
  runWithConfig({ VK_PHOTO_ACCESS_TOKEN: '', VK_API_MIN_INTERVAL_MS: '0' }, `
    import assert from 'node:assert/strict';
    const { VkClient } = await import('./dist/vk/client.js');
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.headers.authorization, 'Bearer test-vk-token');
      return Response.json({ response: {} });
    };
    const client = new VkClient();
    await client.api('photos.getMessagesUploadServer');
    await client.api('photos.saveMessagesPhoto');
  `);
});

test("new VK messages recover bottom keyboards and preserve button payloads", () => {
  runWithConfig({}, `
    import assert from 'node:assert/strict';
    const { BridgeService, prepareVkKeyboard } = await import('./dist/services/bridgeService.js');
    const { VkClient } = await import('./dist/vk/client.js');
    const { pool } = await import('./dist/db.js');
    const payload = JSON.stringify({ m: 'menu', t: 'Запчасти' });
    const keyboard = { inline: false, author_id: -42, buttons: [[{ action: { type: 'text', label: 'Запчасти', payload } }]] };
    const vk = new VkClient();
    let lookups = 0;
    let current = keyboard;
    vk.api = async (method, params) => {
      assert.equal(method, 'messages.getConversationsById');
      assert.deepEqual(params, { peer_ids: '-42' });
      lookups++;
      return { items: [{ peer: { id: -99 }, current_keyboard: keyboard }, { peer: { id: -42 }, current_keyboard: current }] };
    };
    let source;
    let forwarded;
    const errors = [];
    vk.getMessageById = async () => ({ ...source });
    const bridge = new BridgeService({}, vk, {}, { error: async (...args) => errors.push(args) }, {});
    bridge.forwardVkMessage = async message => { forwarded = message; };
    const incoming = { id: 12, peer_id: -42, from_id: -42, text: 'Выберите тему', out: 0 };
    source = incoming;
    await bridge.handleVkUpdate([4, 12]);
    assert.equal(lookups, 1);
    const prepared = prepareVkKeyboard(forwarded);
    assert.equal(prepared.replyMarkup.inline_keyboard[0][0].text, 'Запчасти');
    assert.match(prepared.replyMarkup.inline_keyboard[0][0].callback_data, /^vkb:/);
    assert.deepEqual(prepared.actions[0], { id: prepared.actions[0].id, actionType: 'text', label: 'Запчасти', payload, vkInline: false, vkAuthorId: -42 });
    source = { ...incoming, keyboard: { buttons: [] } };
    await bridge.handleVkUpdate([4, 12]);
    assert.equal(lookups, 1);
    assert.equal(prepareVkKeyboard(forwarded), undefined);
    source = { ...incoming, keyboard: { ...keyboard, inline: true } };
    await bridge.handleVkUpdate([4, 12]);
    assert.equal(lookups, 1);
    assert.equal(prepareVkKeyboard(forwarded).actions[0].vkInline, true);
    source = incoming;
    for (const value of [undefined, { ...keyboard, author_id: -99 }, { ...keyboard, inline: true }, JSON.stringify(keyboard)]) {
      current = value;
      await bridge.handleVkUpdate([4, 12]);
      assert.equal(Boolean(prepareVkKeyboard(forwarded)), typeof value === 'string');
    }
    vk.getCurrentKeyboard = async () => { throw new Error('VK unavailable'); };
    await bridge.handleVkUpdate([4, 12]);
    assert.equal(forwarded.text, incoming.text);
    assert.equal(errors.length, 1);
    source = { ...incoming, out: 1 };
    forwarded = undefined;
    await bridge.handleVkUpdate([4, 12]);
    assert.equal(forwarded, undefined);
    await pool.end();
  `);
});

test("VK text button sends its label and original payload together", () => {
  runWithConfig({}, `
    import assert from 'node:assert/strict';
    const { VkClient } = await import('./dist/vk/client.js');
    const vk = new VkClient();
    const payload = '{"m":"menu","t":"Запчасти"}';
    vk.api = async (method, params) => {
      assert.equal(method, 'messages.send');
      assert.equal(params.peer_id, -42);
      assert.equal(params.message, 'Запчасти');
      assert.equal(params.payload, payload);
      return 123;
    };
    await vk.sendMessage({ peerId: -42, text: 'Запчасти', payload });
  `);
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
