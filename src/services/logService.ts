import { TelegramClient } from "../telegram/client.js";
import { truncate } from "../util.js";

export class LogService {
  private readonly telegramQueue: string[] = [];
  private flushing = false;

  constructor(private readonly telegram: TelegramClient) {}

  async info(message: string): Promise<void> {
    console.log(message);
    this.enqueueTelegram(`INFO\n${message}`);
  }

  async error(message: string, error?: unknown): Promise<void> {
    const details = error instanceof Error ? `${error.name}: ${error.message}` : error ? String(error) : "";
    console.error(message, error);
    this.enqueueTelegram(`ERROR\n${message}${details ? `\n${details}` : ""}`);
  }

  private enqueueTelegram(text: string): void {
    const normalized = truncate(text, 4096);
    if (this.telegramQueue.at(-1) === normalized) return;
    if (this.telegramQueue.length >= 100) this.telegramQueue.shift();
    this.telegramQueue.push(normalized);
    void this.flushTelegramQueue();
  }

  private async flushTelegramQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.telegramQueue.length) {
        const text = this.telegramQueue.shift();
        if (!text) continue;
        try {
          await this.toTelegram(text);
        } catch (error) {
          console.error("failed to write telegram log", error);
          this.telegramQueue.length = 0;
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async toTelegram(text: string): Promise<void> {
    await this.telegram.sendMessage({
      text,
      disable_notification: true,
      link_preview_options: { is_disabled: true }
    });
  }
}
