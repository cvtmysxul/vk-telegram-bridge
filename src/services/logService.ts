import { config } from "../config.js";
import { TelegramClient } from "../telegram/client.js";
import { truncate } from "../util.js";

interface TelegramLogRepeatState {
  lastSentAt: number;
  suppressed: number;
}

export class LogService {
  private readonly telegramQueue: string[] = [];
  private readonly telegramRepeats = new Map<string, TelegramLogRepeatState>();
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
    const now = Date.now();
    const previous = this.telegramRepeats.get(normalized);
    if (previous && now - previous.lastSentAt < config.runtime.logRepeatWindowMs) {
      previous.suppressed += 1;
      return;
    }

    const repeatSummary = previous?.suppressed
      ? `\nSuppressed ${previous.suppressed} identical Telegram log repeats`
      : "";
    this.rememberTelegramLog(normalized, now);

    const queued = truncate(`${normalized}${repeatSummary}`, 4096);
    if (this.telegramQueue.at(-1) === queued) return;
    if (this.telegramQueue.length >= 100) this.telegramQueue.shift();
    this.telegramQueue.push(queued);
    void this.flushTelegramQueue();
  }

  private rememberTelegramLog(text: string, now: number): void {
    if (!this.telegramRepeats.has(text) && this.telegramRepeats.size >= 500) {
      const oldest = this.telegramRepeats.keys().next().value;
      if (oldest !== undefined) this.telegramRepeats.delete(oldest);
    }
    this.telegramRepeats.set(text, { lastSentAt: now, suppressed: 0 });
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
