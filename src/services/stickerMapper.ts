import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { TelegramClient } from "../telegram/client.js";
import { TelegramSticker, TelegramStickerSet } from "../types.js";

interface StickerMappingEntry {
  vkStickerId: number;
  telegramFileUniqueId: string;
}

interface StickerPackMapping {
  vkProductId: number;
  vkTitle: string;
  telegramSetName: string;
  telegramTitle: string;
  stickers: StickerMappingEntry[];
}

interface StickerMappingFile {
  version: 1;
  generatedAt: string;
  packs: StickerPackMapping[];
}

export interface StickerMappingStats {
  packs: number;
  stickers: number;
}

export class StickerMapper {
  private readonly vkToTelegram = new Map<number, { setName: string; fileUniqueId: string }>();
  private readonly telegramToVk = new Map<string, number[]>();
  private readonly telegramSets = new Map<string, Promise<TelegramStickerSet>>();
  private initialized = false;

  constructor(private readonly telegram: TelegramClient) {}

  async initialize(): Promise<StickerMappingStats> {
    if (this.initialized) return this.stats();

    const raw = await readFile(config.stickers.mappingPath, "utf8");
    const mapping = parseStickerMapping(JSON.parse(raw) as unknown);

    for (const pack of mapping.packs) {
      const normalizedSetName = normalizeSetName(pack.telegramSetName);
      for (const sticker of pack.stickers) {
        const existingVk = this.vkToTelegram.get(sticker.vkStickerId);
        if (existingVk) {
          throw new Error(`Duplicate VK sticker mapping: ${sticker.vkStickerId}`);
        }

        const telegramKey = telegramStickerKey(normalizedSetName, sticker.telegramFileUniqueId);
        this.vkToTelegram.set(sticker.vkStickerId, {
          setName: pack.telegramSetName,
          fileUniqueId: sticker.telegramFileUniqueId
        });
        const candidates = this.telegramToVk.get(telegramKey);
        if (candidates) {
          if (!candidates.includes(sticker.vkStickerId)) candidates.push(sticker.vkStickerId);
        } else {
          this.telegramToVk.set(telegramKey, [sticker.vkStickerId]);
        }
      }
    }

    this.initialized = true;
    return this.stats();
  }

  async telegramStickerForVk(vkStickerId: number): Promise<TelegramSticker | undefined> {
    this.assertInitialized();
    const mapped = this.vkToTelegram.get(vkStickerId);
    if (!mapped) return undefined;

    const set = await this.telegramSet(mapped.setName);
    return set.stickers.find((sticker) => sticker.file_unique_id === mapped.fileUniqueId);
  }

  vkStickerForTelegram(sticker: TelegramSticker): number | undefined {
    return this.vkStickerCandidatesForTelegram(sticker)[0];
  }

  vkStickerCandidatesForTelegram(sticker: TelegramSticker): number[] {
    this.assertInitialized();
    if (!sticker.set_name || !sticker.file_unique_id) return [];
    return [...(this.telegramToVk.get(telegramStickerKey(sticker.set_name, sticker.file_unique_id)) ?? [])];
  }

  private telegramSet(name: string): Promise<TelegramStickerSet> {
    const key = normalizeSetName(name);
    let request = this.telegramSets.get(key);
    if (!request) {
      request = this.telegram.getStickerSet(name).catch((error) => {
        this.telegramSets.delete(key);
        throw error;
      });
      this.telegramSets.set(key, request);
    }
    return request;
  }

  private stats(): StickerMappingStats {
    return {
      packs: new Set([...this.vkToTelegram.values()].map((entry) => normalizeSetName(entry.setName))).size,
      stickers: this.vkToTelegram.size
    };
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("StickerMapper is not initialized");
    }
  }
}

function parseStickerMapping(value: unknown): StickerMappingFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.packs)) {
    throw new Error("Invalid sticker mapping file: expected version 1 with packs array");
  }

  for (const pack of value.packs) {
    if (
      !isRecord(pack) ||
      !Number.isInteger(pack.vkProductId) ||
      typeof pack.vkTitle !== "string" ||
      typeof pack.telegramSetName !== "string" ||
      typeof pack.telegramTitle !== "string" ||
      !Array.isArray(pack.stickers)
    ) {
      throw new Error("Invalid sticker pack mapping entry");
    }

    for (const sticker of pack.stickers) {
      if (
        !isRecord(sticker) ||
        !Number.isInteger(sticker.vkStickerId) ||
        typeof sticker.telegramFileUniqueId !== "string"
      ) {
        throw new Error(`Invalid sticker entry in Telegram set ${pack.telegramSetName}`);
      }
    }
  }

  return value as unknown as StickerMappingFile;
}

function telegramStickerKey(setName: string, fileUniqueId: string): string {
  return `${normalizeSetName(setName)}:${fileUniqueId}`;
}

function normalizeSetName(value: string): string {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
