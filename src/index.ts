import { closeDb, migrate } from "./db.js";
import { BridgeService } from "./services/bridgeService.js";
import { LogService } from "./services/logService.js";
import { StickerMapper } from "./services/stickerMapper.js";
import { TopicService } from "./services/topicService.js";
import { TelegramClient } from "./telegram/client.js";
import { TelegramDeletionListener } from "./telegram/deletionListener.js";
import { VkClient } from "./vk/client.js";

const telegram = new TelegramClient();
const vk = new VkClient();
const logs = new LogService(telegram);
const topics = new TopicService(telegram, vk, logs);
const stickers = new StickerMapper(telegram);
const bridge = new BridgeService(telegram, vk, topics, logs, stickers);
const telegramDeletions = new TelegramDeletionListener(logs, (messageIds) =>
  bridge.handleTelegramDeletedMessages(messageIds)
);

async function main(): Promise<void> {
  await migrate();
  const stickerStats = await stickers.initialize();
  console.log(`Loaded ${stickerStats.stickers} sticker mappings from ${stickerStats.packs} Telegram packs`);
  installShutdownHandlers();
  await telegramDeletions.start();
  await bridge.start();
}

function installShutdownHandlers(): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down`);
    bridge.stop();
    void telegramDeletions
      .stop()
      .finally(() => closeDb())
      .finally(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(async (error) => {
  console.error("Bridge crashed", error);
  await telegramDeletions.stop().catch(() => undefined);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
