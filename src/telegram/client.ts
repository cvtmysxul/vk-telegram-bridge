import { config } from "../config.js";
import {
  TelegramFileRef,
  TelegramForumTopic,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramReactionType,
  TelegramSticker,
  TelegramStickerSet,
  TelegramUpdate
} from "../types.js";
import {
  asNumber,
  fetchWithTimeout,
  isTransientHttpStatus,
  readResponseBodyWithinLimit,
  retryDelayMs,
  sleep,
  truncate
} from "../util.js";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

interface SendBase {
  chat_id?: number | string;
  message_thread_id?: number;
  reply_to_message_id?: number;
  disable_notification?: boolean;
}

interface SendText extends SendBase {
  text: string;
  link_preview_options?: { is_disabled: boolean };
  reply_markup?: TelegramInlineKeyboardMarkup;
}

interface SendFile extends SendBase {
  caption?: string;
  file: string | Buffer;
  filename?: string;
  mimeType?: string;
  duration?: number;
  performer?: string;
  title?: string;
}

export class TelegramClient {
  private readonly baseUrl = `https://api.telegram.org/bot${config.telegram.botToken}`;
  private forumTopicIconStickers?: Promise<TelegramSticker[]>;
  readonly chatId = asNumber(config.telegram.chatId);

  async getUpdates(offset?: number, timeout = 25): Promise<TelegramUpdate[]> {
    return this.requestJson<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "edited_message", "callback_query", "message_reaction"]
    });
  }

  async getForumTopicIconCustomEmojiId(emoji: string): Promise<string | undefined> {
    const stickers = await this.getForumTopicIconStickers();
    return stickers.find((sticker) => sticker.emoji === emoji)?.custom_emoji_id;
  }

  async createForumTopic(name: string, iconCustomEmojiId?: string): Promise<TelegramForumTopic> {
    return this.requestJson<TelegramForumTopic>("createForumTopic", {
      chat_id: this.chatId,
      name,
      icon_custom_emoji_id: iconCustomEmojiId
    });
  }

  async editForumTopic(messageThreadId: number, name: string, iconCustomEmojiId?: string): Promise<boolean> {
    try {
      return await this.requestJson<boolean>("editForumTopic", {
        chat_id: this.chatId,
        message_thread_id: messageThreadId,
        name,
        icon_custom_emoji_id: iconCustomEmojiId
      });
    } catch (error) {
      if (isTelegramTopicNotModified(error)) return false;
      throw error;
    }
  }

  async deleteForumTopic(messageThreadId: number): Promise<boolean> {
    return this.requestJson<boolean>("deleteForumTopic", {
      chat_id: this.chatId,
      message_thread_id: messageThreadId
    });
  }

  async sendMessage(input: SendText): Promise<TelegramMessage> {
    return this.requestJson<TelegramMessage>("sendMessage", {
      chat_id: input.chat_id ?? this.chatId,
      message_thread_id: input.message_thread_id,
      text: input.text,
      link_preview_options: input.link_preview_options,
      reply_markup: input.reply_markup,
      reply_parameters: input.reply_to_message_id
        ? { message_id: input.reply_to_message_id, allow_sending_without_reply: true }
        : undefined,
      disable_notification: input.disable_notification
    });
  }

  async editMessageText(messageId: number, text: string, chatId = this.chatId): Promise<boolean> {
    try {
      return await this.requestJson<boolean>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        link_preview_options: { is_disabled: false }
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("MESSAGE_NOT_MODIFIED") || error.message.toLowerCase().includes("message is not modified"))
      ) {
        return false;
      }
      throw error;
    }
  }

  async deleteMessage(messageId: number, chatId = this.chatId): Promise<boolean> {
    return this.requestJson<boolean>("deleteMessage", {
      chat_id: chatId,
      message_id: messageId
    });
  }

  async setMessageReaction(
    messageId: number,
    reaction: TelegramReactionType,
    chatId = this.chatId
  ): Promise<boolean> {
    return this.requestJson<boolean>("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [reaction],
      is_big: false
    });
  }

  async sendPhoto(input: SendFile): Promise<TelegramMessage> {
    return this.sendMultipart("sendPhoto", "photo", input);
  }

  async sendVideo(input: SendFile): Promise<TelegramMessage> {
    return this.sendMultipart("sendVideo", "video", input);
  }

  async sendVideoNote(input: SendFile): Promise<TelegramMessage> {
    return this.sendMultipart("sendVideoNote", "video_note", input);
  }

  async sendVoice(input: SendFile): Promise<TelegramMessage> {
    return this.sendMultipart("sendVoice", "voice", input);
  }

  async sendAudio(input: SendFile): Promise<TelegramMessage> {
    return this.sendMultipart("sendAudio", "audio", input);
  }

  async sendDocument(input: SendFile): Promise<TelegramMessage> {
    return this.sendMultipart("sendDocument", "document", input);
  }

  async sendSticker(input: SendFile): Promise<TelegramMessage> {
    return this.sendMultipart("sendSticker", "sticker", input);
  }

  async pinChatMessage(messageId: number): Promise<boolean> {
    return this.requestJson<boolean>("pinChatMessage", {
      chat_id: this.chatId,
      message_id: messageId,
      disable_notification: true
    });
  }

  async unpinChatMessage(messageId: number): Promise<boolean> {
    return this.requestJson<boolean>("unpinChatMessage", {
      chat_id: this.chatId,
      message_id: messageId
    });
  }

  async unpinAllForumTopicMessages(messageThreadId: number): Promise<boolean> {
    return this.requestJson<boolean>("unpinAllForumTopicMessages", {
      chat_id: this.chatId,
      message_thread_id: messageThreadId
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    return this.requestJson<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
      cache_time: 0
    });
  }

  async getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    return this.requestJson("getFile", { file_id: fileId });
  }

  async getStickerSet(name: string): Promise<TelegramStickerSet> {
    return this.requestJson<TelegramStickerSet>("getStickerSet", { name });
  }

  private async getForumTopicIconStickers(): Promise<TelegramSticker[]> {
    this.forumTopicIconStickers ??= this.requestJson<TelegramSticker[]>("getForumTopicIconStickers", {});
    return this.forumTopicIconStickers;
  }

  async downloadFile(file: TelegramFileRef): Promise<{ buffer: Buffer; filename: string; mimeType?: string }> {
    const info = await this.getFile(file.file_id);
    if (!info.file_path) {
      throw new Error(`Telegram returned file without file_path: ${file.file_id}`);
    }
    if (info.file_size && info.file_size > config.media.maxDownloadBytes) {
      throw new Error(`Telegram file is too large: ${info.file_size} bytes`);
    }

    const response = await fetchTelegramResource(
      `https://api.telegram.org/file/bot${config.telegram.botToken}/${info.file_path}`,
      config.runtime.mediaTimeoutMs
    );
    if (!response.ok) {
      const preview = await readResponseBodyWithinLimit(response, Math.min(config.media.maxDownloadBytes, 4_096));
      throw new Error(`Telegram file download failed ${response.status}: ${truncate(preview.toString("utf8"), 300)}`);
    }
    const buffer = await readResponseBodyWithinLimit(response, config.media.maxDownloadBytes);
    return {
      buffer,
      filename: file.file_name || info.file_path.split("/").pop() || "telegram-file",
      mimeType: file.mime_type
    };
  }

  private async sendMultipart(method: string, field: string, input: SendFile): Promise<TelegramMessage> {
    if (typeof input.file === "string") {
      return this.requestJson<TelegramMessage>(method, {
        chat_id: input.chat_id ?? this.chatId,
        message_thread_id: input.message_thread_id,
        [field]: input.file,
        caption: input.caption,
        duration: input.duration,
        performer: input.performer,
        title: input.title,
        reply_parameters: input.reply_to_message_id
          ? { message_id: input.reply_to_message_id, allow_sending_without_reply: true }
          : undefined,
        disable_notification: input.disable_notification
      });
    }

    const form = new FormData();
    form.set("chat_id", String(input.chat_id ?? this.chatId));
    if (input.message_thread_id) form.set("message_thread_id", String(input.message_thread_id));
    if (input.caption) form.set("caption", input.caption);
    if (input.duration !== undefined) form.set("duration", String(input.duration));
    if (input.performer) form.set("performer", input.performer);
    if (input.title) form.set("title", input.title);
    if (input.reply_to_message_id) {
      form.set(
        "reply_parameters",
        JSON.stringify({ message_id: input.reply_to_message_id, allow_sending_without_reply: true })
      );
    }
    if (input.disable_notification !== undefined) {
      form.set("disable_notification", String(input.disable_notification));
    }
    const blob = new Blob([bufferToBlobPart(input.file)], { type: input.mimeType || "application/octet-stream" });
    form.set(field, blob, input.filename || "file");
    return this.requestForm<TelegramMessage>(method, form);
  }

  private async requestJson<T>(method: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stripUndefined(body))
    }, method === "getUpdates" ? Math.max(config.runtime.requestTimeoutMs, 40_000) : config.runtime.requestTimeoutMs);
  }

  private async requestForm<T>(method: string, body: FormData): Promise<T> {
    return this.request<T>(method, { method: "POST", body }, config.runtime.mediaTimeoutMs);
  }

  private async request<T>(
    method: string,
    init: RequestInit,
    timeoutMs: number,
    attempt = 0
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchWithTimeout(`${this.baseUrl}/${method}`, init, timeoutMs);
    } catch (error) {
      if (isRetryableTelegramMethod(method) && attempt < config.runtime.maxNetworkRetries) {
        await sleep(retryDelayMs(attempt, config.runtime.retryBaseMs));
        return this.request(method, init, timeoutMs, attempt + 1);
      }
      throw new Error(`Telegram ${method} network request failed after ${attempt + 1} attempts`, { cause: error });
    }

    const responseText = await response.text();
    const payload = parseTelegramResponse<T>(responseText);

    if (payload.ok && payload.result !== undefined) return payload.result;

    if (payload.parameters?.retry_after && attempt < config.runtime.maxNetworkRetries) {
      await sleep((payload.parameters.retry_after + 1) * 1000);
      return this.request(method, init, timeoutMs, attempt + 1);
    }

    if (
      isRetryableTelegramMethod(method) &&
      isTransientHttpStatus(response.status) &&
      attempt < config.runtime.maxNetworkRetries
    ) {
      await sleep(retryDelayMs(attempt, config.runtime.retryBaseMs));
      return this.request(method, init, timeoutMs, attempt + 1);
    }

    throw new Error(
      `Telegram ${method} failed: ${payload.error_code ?? response.status} ${payload.description ?? "unknown error"}`
    );
  }
}

function isRetryableTelegramMethod(method: string): boolean {
  return new Set([
    "getUpdates",
    "getFile",
    "getStickerSet",
    "getForumTopicIconStickers",
    "editForumTopic",
    "deleteForumTopic",
    "editMessageText",
    "deleteMessage",
    "setMessageReaction",
    "pinChatMessage",
    "unpinChatMessage",
    "unpinAllForumTopicMessages"
  ]).has(method);
}

async function fetchTelegramResource(url: string, timeoutMs: number, attempt = 0): Promise<Response> {
  try {
    const response = await fetchWithTimeout(url, {}, timeoutMs);
    if (isTransientHttpStatus(response.status) && attempt < config.runtime.maxNetworkRetries) {
      await response.body?.cancel().catch(() => undefined);
      await sleep(retryDelayMs(attempt, config.runtime.retryBaseMs));
      return fetchTelegramResource(url, timeoutMs, attempt + 1);
    }
    return response;
  } catch (error) {
    if (attempt < config.runtime.maxNetworkRetries) {
      await sleep(retryDelayMs(attempt, config.runtime.retryBaseMs));
      return fetchTelegramResource(url, timeoutMs, attempt + 1);
    }
    throw new Error(`Telegram file download failed after ${attempt + 1} attempts`, { cause: error });
  }
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function parseTelegramResponse<T>(text: string): TelegramResponse<T> {
  try {
    return JSON.parse(text) as TelegramResponse<T>;
  } catch {
    return { ok: false, description: text || "empty response" };
  }
}

function isTelegramTopicNotModified(error: unknown): boolean {
  return error instanceof Error && error.message.includes("TOPIC_NOT_MODIFIED");
}

function bufferToBlobPart(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}
