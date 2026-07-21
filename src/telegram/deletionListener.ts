import { Api, sessions, TelegramClient as MtprotoTelegramClient } from "telegram";
import { config } from "../config.js";
import { LogService } from "../services/logService.js";

type DeleteHandler = (messageIds: number[]) => Promise<void>;

export class TelegramDeletionListener {
  private client?: MtprotoTelegramClient;

  constructor(
    private readonly logs: LogService,
    private readonly onDeleted: DeleteHandler
  ) {}

  async start(): Promise<void> {
    const { apiId, apiHash, userSession } = config.telegram;
    if (!apiId || !apiHash || !userSession) {
      await this.logs.info(
        "Telegram deletion sync disabled: TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_USER_SESSION are required"
      );
      return;
    }

    const expectedChannelId = telegramChannelId(config.telegram.chatId);
    if (expectedChannelId === undefined) {
      await this.logs.error(
        `Telegram deletion sync disabled: TELEGRAM_CHAT_ID ${config.telegram.chatId} is not a supergroup/channel id`
      );
      return;
    }

    const client = new MtprotoTelegramClient(new sessions.StringSession(userSession), apiId, apiHash, {
      connectionRetries: 5,
      autoReconnect: true
    });
    client.addEventHandler((update: Api.TypeUpdate) => {
      if (!(update instanceof Api.UpdateDeleteChannelMessages)) return;
      if (update.channelId.toString() !== expectedChannelId.toString()) return;
      void this.onDeleted(update.messages).catch((error) =>
        this.logs.error(`Failed to handle deleted Telegram messages ${update.messages.join(",")}`, error)
      );
    });

    try {
      await client.connect();
      if (!(await client.checkAuthorization())) {
        throw new Error("TELEGRAM_USER_SESSION is not authorized; run npm run telegram:login");
      }
      await client.getMe();
      this.client = client;
      await this.logs.info("Telegram MTProto deletion listener started");
    } catch (error) {
      await client.disconnect().catch(() => undefined);
      await this.logs.error("Telegram deletion sync could not start", error);
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.disconnect().catch(() => undefined);
  }
}

function telegramChannelId(botApiChatId: bigint): bigint | undefined {
  const channelOffset = 1_000_000_000_000n;
  if (botApiChatId >= -channelOffset) return undefined;
  const channelId = -botApiChatId - channelOffset;
  return channelId > 0n ? channelId : undefined;
}
