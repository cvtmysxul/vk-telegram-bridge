import { config } from "../config.js";
import { VkAttachment, VkChatParticipant, VkLongPollServer, VkMessage, VkPeerInfo } from "../types.js";
import {
  fetchWithTimeout,
  fileNameFromUrl,
  isTransientHttpStatus,
  randomId,
  readResponseBodyWithinLimit,
  retryDelayMs,
  sleep,
  truncate
} from "../util.js";

interface VkResponse<T> {
  response?: T;
  error?: {
    error_code: number;
    error_msg: string;
    request_params?: unknown[];
  };
}

export class VkApiError extends Error {
  readonly name = "VkApiError";

  constructor(
    readonly method: string,
    readonly errorCode: number,
    readonly apiMessage: string
  ) {
    super(`VK ${method} failed: ${errorCode} ${apiMessage}`);
  }
}

export function isVkStickerUnavailableError(error: unknown): error is VkApiError {
  return (
    error instanceof VkApiError &&
    error.method === "messages.send" &&
    error.errorCode === 100 &&
    /sticker is not available/i.test(error.apiMessage)
  );
}

interface VkSendResponse {
  message_id?: number;
  conversation_message_id?: number;
  peer_id?: number;
}

interface VkDeleteResponseItem {
  peer_id?: number;
  message_id?: number;
  conversation_message_id?: number;
  response?: number | boolean;
  error?: unknown;
}

interface VkGroupInfo {
  id: number;
  name?: string;
  photo_50?: string;
  photo_100?: string;
  photo_200?: string;
}

interface VkGroupsGetByIdResponse {
  groups?: VkGroupInfo[];
}

interface VkUserInfo {
  id: number;
  first_name?: string;
  last_name?: string;
  photo_50?: string;
  photo_100?: string;
  photo_200?: string;
}

interface VkConversationMember {
  member_id?: number;
}

interface VkConversationMembersResponse {
  count?: number;
  items?: VkConversationMember[];
  profiles?: VkUserInfo[];
  groups?: VkGroupInfo[];
}

interface VkReactionProfile {
  id: number;
  first_name?: string;
  last_name?: string;
}

interface VkReactionGroup {
  id: number;
  name?: string;
}

interface VkReactedPeersResponse {
  count?: number;
  reactions?: Array<{ user_id: number; reaction_id: number }>;
  counters?: Array<{ reaction_id: number; count: number; user_ids?: number[] }>;
  profiles?: VkReactionProfile[];
  groups?: VkReactionGroup[];
}

export interface VkReactionActor {
  userId: number;
  reactionId: number;
  displayName: string;
}

export interface VkReactedPeers {
  count: number;
  reactions: VkReactionActor[];
  counters: Array<{ reactionId: number; count: number }>;
}

export interface VkAttachmentPresentation {
  kind: string;
  url?: string;
  title?: string;
  fallbackUrl?: string;
  sourceUrl?: string;
  description?: string;
  performer?: string;
  duration?: number;
  isRepost?: boolean;
}

interface VkSavedDocument {
  owner_id: number;
  id: number;
  access_key?: string;
}

type VkMessageDocumentUploadType = "doc" | "audio_message" | "graffiti" | "video_message";

interface VkDocsSaveResponse {
  type?: VkMessageDocumentUploadType | string;
  doc?: VkSavedDocument;
  audio_message?: VkSavedDocument;
  graffiti?: VkSavedDocument;
  video_message?: VkSavedDocument;
}

interface VkDocumentUploadResponse {
  file?: string;
  doc?: string;
  audio_message?: string;
  graffiti?: string;
  video_message?: string;
  error?: string;
}

export class VkClient {
  private readonly apiBase = "https://api.vk.ru/method";

  async api<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    form.set("v", config.vk.apiVersion);

    for (let attempt = 0; attempt <= config.runtime.maxNetworkRetries; attempt += 1) {
      let response: Response;
      try {
        response = await fetchWithTimeout(
          `${this.apiBase}/${method}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.vk.accessToken}`,
              "content-type": "application/x-www-form-urlencoded"
            },
            body: form
          },
          config.runtime.requestTimeoutMs
        );
      } catch (error) {
        if (attempt < config.runtime.maxNetworkRetries) {
          await sleep(retryDelayMs(attempt, config.runtime.retryBaseMs));
          continue;
        }
        throw new Error(`VK ${method} network request failed after ${attempt + 1} attempts`, { cause: error });
      }

      const responseText = await response.text();
      if (isTransientHttpStatus(response.status) && attempt < config.runtime.maxNetworkRetries) {
        await sleep(retryDelayMs(attempt, config.runtime.retryBaseMs));
        continue;
      }

      const payload = parseVkResponse<T>(responseText);
      if (payload.error) {
        if (isRetryableVkError(payload.error.error_code) && attempt < config.runtime.maxNetworkRetries) {
          await sleep(retryDelayMs(attempt, Math.max(350, config.runtime.retryBaseMs)));
          continue;
        }
        throw new VkApiError(method, payload.error.error_code, payload.error.error_msg);
      }
      if (payload.response === undefined) {
        throw new Error(`VK ${method} returned empty response`);
      }
      return payload.response;
    }

    throw new Error(`VK ${method} failed after retries`);
  }

  async getLongPollServer(): Promise<VkLongPollServer> {
    return this.api("messages.getLongPollServer", {
      need_pts: 1,
      lp_version: config.vk.longPollVersion
    });
  }

  async getMessageById(messageId: number): Promise<VkMessage | undefined> {
    const response = await this.api<{ items: VkMessage[] }>("messages.getById", {
      message_ids: String(messageId),
      extended: 1
    });
    return response.items[0];
  }

  async getMessageByConversationMessageId(peerId: number, conversationMessageId: number): Promise<VkMessage | undefined> {
    const response = await this.api<{ items: VkMessage[] }>("messages.getByConversationMessageId", {
      peer_id: peerId,
      conversation_message_ids: String(conversationMessageId),
      extended: 1
    });
    return response.items[0];
  }

  async findRecentOutgoingMessage(
    peerId: number,
    input: { date?: number; text?: string }
  ): Promise<VkMessage | undefined> {
    if (!input.date) return undefined;
    const response = await this.api<{ items: VkMessage[] }>("messages.getHistory", {
      peer_id: peerId,
      count: 100,
      extended: 0
    });
    const expectedText = input.text?.trim();
    const candidates = response.items
      .filter((message) => message.out === 1 && message.peer_id === peerId && message.date !== undefined)
      .filter((message) => Math.abs((message.date ?? 0) - input.date!) <= 120)
      .filter((message) => !expectedText || message.text?.trim() === expectedText)
      .sort((left, right) =>
        Math.abs((left.date ?? 0) - input.date!) - Math.abs((right.date ?? 0) - input.date!)
      );

    if (expectedText) return candidates[0];
    const closest = candidates[0];
    return closest && Math.abs((closest.date ?? 0) - input.date) <= 10 ? closest : undefined;
  }

  async getPeerInfo(peerId: number): Promise<VkPeerInfo> {
    if (peerId > 2_000_000_000) {
      const response = await this.api<{
        items: Array<{
          peer?: { id: number };
          chat_settings?: {
            title?: string;
            photo?: { photo_50?: string; photo_100?: string; photo_200?: string };
          };
        }>;
      }>(
        "messages.getConversationsById",
        { peer_ids: String(peerId), extended: 1 }
      );
      const item = response.items[0];
      const title = item?.chat_settings?.title || `VK chat ${peerId - 2_000_000_000}`;
      return {
        peerId,
        displayName: title,
        title,
        avatarUrl: bestAvatarUrl(item?.chat_settings?.photo),
        isChat: true,
        raw: item ?? {}
      };
    }

    if (peerId < 0) {
      const groupId = Math.abs(peerId);
      const response = await this.api<VkGroupInfo[] | VkGroupsGetByIdResponse>("groups.getById", {
        group_id: String(groupId),
        fields: "photo_50,photo_100,photo_200"
      });
      const group = firstVkGroup(response);
      const title = group?.name || `VK group ${groupId}`;
      return {
        peerId,
        displayName: title,
        title,
        avatarUrl: bestAvatarUrl(group),
        isChat: false,
        raw: group ?? {}
      };
    }

    const response = await this.api<VkUserInfo[]>("users.get", {
      user_ids: String(peerId),
      fields: "photo_50,photo_100,photo_200"
    });
    const user = response[0];
    const firstName = user?.first_name || "";
    const lastName = user?.last_name || "";
    const displayName = `${firstName} ${lastName}`.trim() || `VK user ${peerId}`;
    return {
      peerId,
      displayName,
      firstName,
      lastName,
      avatarUrl: bestAvatarUrl(user),
      isChat: false,
      raw: user ?? {}
    };
  }

  async getChatParticipants(peerId: number): Promise<VkChatParticipant[]> {
    if (peerId <= 2_000_000_000) return [];

    const response = await this.api<VkConversationMembersResponse>("messages.getConversationMembers", {
      peer_id: peerId,
      fields: "photo_50"
    });
    const profiles = new Map((response.profiles ?? []).map((profile) => [profile.id, profile]));
    const groups = new Map((response.groups ?? []).map((group) => [group.id, group]));
    const participants = new Map<number, VkChatParticipant>();

    for (const item of response.items ?? []) {
      const id = item.member_id;
      if (!id || participants.has(id)) continue;

      if (id > 0) {
        const profile = profiles.get(id);
        const displayName = `${profile?.first_name ?? ""} ${profile?.last_name ?? ""}`.trim() || `VK id${id}`;
        participants.set(id, { id, displayName });
        continue;
      }

      const group = groups.get(Math.abs(id));
      participants.set(id, { id, displayName: group?.name || `VK community ${Math.abs(id)}` });
    }

    return [...participants.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "ru", { sensitivity: "base" })
    );
  }

  async getSenderName(userId: number | undefined): Promise<string | undefined> {
    if (!userId) return undefined;
    const user = await this.getPeerInfo(userId);
    return user.displayName;
  }

  async sendMessage(input: {
    peerId: number;
    text?: string;
    attachments?: string[];
    stickerId?: number;
    replyToMessageId?: number;
    payload?: string;
  }): Promise<VkSendResponse> {
    const response = await this.api<VkSendResponse | number>("messages.send", {
      peer_id: input.peerId,
      message: input.text || undefined,
      attachment: input.attachments?.length ? input.attachments.join(",") : undefined,
      sticker_id: input.stickerId,
      random_id: randomId(),
      reply_to: input.replyToMessageId,
      payload: input.payload
    });

    const normalized: VkSendResponse =
      typeof response === "number" ? { message_id: response, peer_id: input.peerId } : response;
    if (!normalized.message_id || normalized.conversation_message_id) return normalized;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const message = await this.getMessageById(normalized.message_id).catch(() => undefined);
      if (message?.conversation_message_id) {
        return {
          message_id: message.id,
          conversation_message_id: message.conversation_message_id,
          peer_id: message.peer_id
        };
      }
      if (attempt < 2) await sleep(150 * (attempt + 1));
    }
    return normalized;
  }

  async editMessage(input: {
    peerId: number;
    messageId?: number;
    conversationMessageId?: number;
    text: string;
    attachments?: string[];
  }): Promise<boolean> {
    if (!input.messageId && !input.conversationMessageId) {
      throw new Error("VK messages.edit requires message_id or cmid");
    }

    const response = await this.api<boolean | number>("messages.edit", {
      peer_id: input.peerId,
      message_id: input.messageId,
      cmid: input.messageId ? undefined : input.conversationMessageId,
      message: input.text,
      attachment: input.attachments?.length ? input.attachments.join(",") : undefined,
      keep_forward_messages: 1,
      keep_snippets: 1
    });
    return response === true || response === 1;
  }

  async deleteMessage(input: {
    peerId: number;
    messageId?: number;
    conversationMessageId?: number;
  }): Promise<boolean> {
    if (!input.messageId && !input.conversationMessageId) {
      throw new Error("VK messages.delete requires message_id or cmid");
    }

    const response = await this.api<VkDeleteResponseItem[]>("messages.delete", {
      peer_id: input.peerId,
      message_ids: input.messageId ? String(input.messageId) : undefined,
      cmids: input.messageId ? undefined : String(input.conversationMessageId),
      delete_for_all: 1
    });
    const result = response[0];
    if (result?.error) {
      throw new Error(`VK messages.delete returned item error: ${JSON.stringify(result.error)}`);
    }
    return result?.response === true || result?.response === 1;
  }

  async sendReaction(peerId: number, conversationMessageId: number, reactionId: number): Promise<boolean> {
    const response = await this.api<boolean | number>("messages.sendReaction", {
      peer_id: peerId,
      cmid: conversationMessageId,
      reaction_id: reactionId
    });
    return response === true || response === 1;
  }

  async deleteReaction(peerId: number, conversationMessageId: number): Promise<boolean> {
    const response = await this.api<boolean | number>("messages.deleteReaction", {
      peer_id: peerId,
      cmid: conversationMessageId
    });
    return response === true || response === 1;
  }

  async getReactedPeers(peerId: number, conversationMessageId: number): Promise<VkReactedPeers> {
    const response = await this.api<VkReactedPeersResponse>("messages.getReactedPeers", {
      peer_id: peerId,
      cmid: conversationMessageId
    });
    const names = new Map<number, string>();
    for (const profile of response.profiles ?? []) {
      const name = vkUserDisplayName(profile);
      if (name) names.set(profile.id, name);
    }
    for (const group of response.groups ?? []) {
      names.set(-group.id, group.name || `VK group ${group.id}`);
    }

    const reactionActors = new Map<string, { userId: number; reactionId: number }>();
    for (const reaction of response.reactions ?? []) {
      addReactionActor(reactionActors, reaction.user_id, reaction.reaction_id);
    }
    for (const counter of response.counters ?? []) {
      for (const userId of counter.user_ids ?? []) {
        addReactionActor(reactionActors, userId, counter.reaction_id);
      }
    }

    const missingUserIds = [...reactionActors.values()]
      .map((reaction) => reaction.userId)
      .filter((userId) => userId > 0 && !names.has(userId));
    for (const userIds of chunks([...new Set(missingUserIds)], 1_000)) {
      try {
        const profiles = await this.api<VkUserInfo[]>("users.get", {
          user_ids: userIds.join(",")
        });
        for (const profile of profiles) {
          const name = vkUserDisplayName(profile);
          if (name) names.set(profile.id, name);
        }
      } catch {}
    }

    return {
      count: response.count ?? reactionActors.size,
      reactions: [...reactionActors.values()].map((reaction) => ({
        userId: reaction.userId,
        reactionId: reaction.reactionId,
        displayName: names.get(reaction.userId) ?? `VK user ${reaction.userId}`
      })),
      counters: (response.counters ?? []).map((counter) => ({
        reactionId: counter.reaction_id,
        count: counter.count
      }))
    };
  }

  editableAttachmentIds(message: VkMessage): string[] {
    return (message.attachments ?? []).flatMap((attachment) => {
      const id = editableVkAttachmentId(attachment);
      return id ? [id] : [];
    });
  }

  async sendMessageEvent(input: {
    peerId: number;
    payload: string;
    messageId?: number;
    conversationMessageId?: number;
    authorId?: number;
  }): Promise<string> {
    const eventId = await this.api<unknown>("messages.sendMessageEvent", {
      peer_id: input.peerId,
      payload: input.payload,
      message_id: input.messageId,
      conversation_message_id: input.conversationMessageId,
      author_id: input.authorId
    });
    if (typeof eventId !== "string" || !eventId) {
      throw new Error(`VK messages.sendMessageEvent returned invalid event id: ${JSON.stringify(eventId)}`);
    }
    return eventId;
  }

  async uploadMessagePhoto(peerId: number, buffer: Buffer, filename: string, mimeType?: string): Promise<string> {
    const server = await this.api<{ upload_url: string }>("photos.getMessagesUploadServer", { peer_id: peerId });
    const uploaded = await uploadMultipart<{ server: number; photo: string; hash: string }>(server.upload_url, {
      fieldName: "photo",
      buffer,
      filename,
      mimeType: mimeType || "image/jpeg"
    });
    const saved = await this.api<Array<{ owner_id: number; id: number; access_key?: string }>>(
      "photos.saveMessagesPhoto",
      uploaded
    );
    const photo = saved[0];
    if (!photo) throw new Error("VK did not return saved photo");
    return `photo${photo.owner_id}_${photo.id}${photo.access_key ? `_${photo.access_key}` : ""}`;
  }

  async uploadMessageDocument(
    peerId: number,
    buffer: Buffer,
    filename: string,
    mimeType?: string,
    type: VkMessageDocumentUploadType = "doc"
  ): Promise<string> {
    const server = await this.api<{ upload_url: string }>("docs.getMessagesUploadServer", {
      peer_id: peerId,
      type
    });
    const file = await uploadMessageDocumentFile(server.upload_url, {
      buffer,
      filename,
      mimeType: mimeType || "application/octet-stream",
      type
    });
    const saved = await this.api<VkDocsSaveResponse>("docs.save", {
      file,
      title: filename
    });

    const document = saved.doc ?? saved.audio_message ?? saved.graffiti ?? saved.video_message;
    if (!document) {
      throw new Error(`VK did not return saved document: ${JSON.stringify(saved)}`);
    }

    return vkAttachmentId("doc", document);
  }

  async uploadVideo(buffer: Buffer, filename: string, mimeType?: string): Promise<string> {
    const saved = await this.api<{ upload_url: string; owner_id: number; video_id: number; access_key?: string }>(
      "video.save",
      {
        name: filename,
        wallpost: 0
      }
    );
    await uploadMultipart<unknown>(saved.upload_url, {
      fieldName: "video_file",
      buffer,
      filename,
      mimeType: mimeType || "video/mp4"
    });
    return `video${saved.owner_id}_${saved.video_id}${saved.access_key ? `_${saved.access_key}` : ""}`;
  }

  async unpin(peerId: number): Promise<boolean> {
    await this.api("messages.unpin", { peer_id: peerId });
    return true;
  }

  async pin(peerId: number, conversationMessageId: number): Promise<boolean> {
    await this.api("messages.pin", {
      peer_id: peerId,
      conversation_message_id: conversationMessageId
    });
    return true;
  }

  bestVkAttachmentLink(attachment: VkAttachment): VkAttachmentPresentation {
    const rawValue = attachment[attachment.type];
    if (!isRecord(rawValue)) return { kind: attachment.type };
    const value = rawValue;

    if (attachment.type === "photo") {
      return { kind: "photo", url: bestImageUrl(value.sizes), title: "photo.jpg" };
    }

    if (attachment.type === "sticker") {
      const animationUrl = firstString(value.animation_url);
      const fallbackUrl = vkStickerCdnUrl(value);
      if (animationUrl) {
        return {
          kind: "animated_sticker",
          url: animationUrl,
          fallbackUrl,
          title: "sticker.tgs"
        };
      }

      const url =
        bestImageUrl(value.images) ||
        bestImageUrl(value.images_with_background) ||
        bestStickerLegacyImageUrl(value) ||
        firstString(value.url) ||
        fallbackUrl;
      return {
        kind: "sticker",
        url,
        title: "sticker.png"
      };
    }

    if (attachment.type === "doc") {
      const sourceUrl = vkAttachmentSourceUrl("doc", value);
      return {
        kind: "document",
        url: firstText(value.url),
        title: firstText(value.title) || fileNameFromUrl(String(value.url || ""), "document"),
        fallbackUrl: sourceUrl,
        sourceUrl
      };
    }

    if (attachment.type === "graffiti") {
      const sourceUrl = vkAttachmentSourceUrl("graffiti", value);
      return {
        kind: "document",
        url: firstText(value.url),
        title: firstText(value.title) || fileNameFromUrl(String(value.url || ""), "graffiti"),
        fallbackUrl: sourceUrl,
        sourceUrl
      };
    }

    if (attachment.type === "audio_message") {
      return {
        kind: "voice",
        url: (value.link_ogg as string | undefined) || (value.link_mp3 as string | undefined),
        title: "voice.ogg"
      };
    }

    if (attachment.type === "video_message") {
      return {
        kind: "video_note",
        url:
          (value.link_mp4 as string | undefined) ||
          bestVideoFileUrl(value.files) ||
          (value.url as string | undefined),
        title: "video-note.mp4"
      };
    }

    if (attachment.type === "video") {
      const sourceUrl = vkAttachmentSourceUrl("video", value);
      return {
        kind: "video",
        url: bestVideoFileUrl(value.files),
        title: firstText(value.title) || "VK video",
        sourceUrl
      };
    }

    if (attachment.type === "audio") {
      const sourceUrl = vkAttachmentSourceUrl("audio", value);
      return {
        kind: "audio",
        url: firstText(value.url),
        title: firstText(value.title) || "Без названия",
        performer: firstText(value.artist, value.performer),
        duration: nonNegativeInteger(value.duration),
        fallbackUrl: sourceUrl,
        sourceUrl
      };
    }

    if (attachment.type === "wall") {
      const isRepost = Array.isArray(value.copy_history) && value.copy_history.length > 0;
      return {
        kind: "wall",
        title: isRepost ? "Репост VK" : "Пост VK",
        description: firstText(value.text),
        sourceUrl: vkAttachmentSourceUrl("wall", value),
        isRepost
      };
    }

    if (attachment.type === "link") {
      const url = firstText(value.url);
      return {
        kind: "link",
        url,
        title: firstText(value.title, value.caption) || "Ссылка VK",
        description: firstText(value.description),
        sourceUrl: url
      };
    }

    if (attachment.type === "market" || attachment.type === "market_album") {
      return {
        kind: attachment.type,
        title: firstText(value.title, value.name) || (attachment.type === "market" ? "Товар VK" : "Подборка товаров VK"),
        description: firstText(value.description),
        sourceUrl: vkAttachmentSourceUrl(attachment.type, value)
      };
    }

    if (attachment.type === "poll") {
      return {
        kind: "poll",
        title: firstText(value.question) || "Опрос VK",
        description: firstText(value.description),
        sourceUrl: vkAttachmentSourceUrl("poll", value)
      };
    }

    return {
      kind: attachment.type,
      title: firstText(value.title, value.name) || undefined,
      description: firstText(value.description, value.text, value.caption),
      sourceUrl: vkAttachmentSourceUrl(attachment.type, value)
    };
  }
}

function vkAttachmentId(prefix: string, item: VkSavedDocument): string {
  return `${prefix}${item.owner_id}_${item.id}${item.access_key ? `_${item.access_key}` : ""}`;
}

function editableVkAttachmentId(attachment: VkAttachment): string | undefined {
  const value = attachment[attachment.type];
  if (!isRecord(value)) return undefined;

  const ownerId = numericId(value.owner_id ?? value.from_id);
  const id = numericId(value.id);
  if (ownerId === undefined || id === undefined) return undefined;

  const type =
    attachment.type === "audio_message" || attachment.type === "graffiti" || attachment.type === "video_message"
      ? "doc"
      : attachment.type;
  if (!["photo", "video", "audio", "doc", "wall", "market", "market_album"].includes(type)) {
    return undefined;
  }

  const accessKey = typeof value.access_key === "string" && value.access_key ? `_${value.access_key}` : "";
  return `${type}${ownerId}_${id}${accessKey}`;
}

function firstVkGroup(response: VkGroupInfo[] | VkGroupsGetByIdResponse): VkGroupInfo | undefined {
  return Array.isArray(response) ? response[0] : response.groups?.[0];
}

function vkUserDisplayName(user: Pick<VkUserInfo, "first_name" | "last_name">): string {
  return `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
}

function addReactionActor(
  actors: Map<string, { userId: number; reactionId: number }>,
  userId: number,
  reactionId: number
): void {
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(reactionId)) return;
  actors.set(`${reactionId}:${userId}`, { userId, reactionId });
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}

function bestAvatarUrl(value: { photo_50?: string; photo_100?: string; photo_200?: string } | undefined): string | undefined {
  return firstString(value?.photo_200, value?.photo_100, value?.photo_50);
}

function bestVideoFileUrl(files: unknown): string | undefined {
  if (!files || typeof files !== "object") return undefined;
  const value = files as Record<string, unknown>;
  return firstString(value.mp4_1080, value.mp4_720, value.mp4_480, value.mp4_360, value.mp4_240);
}

function bestImageUrl(images: unknown): string | undefined {
  if (!Array.isArray(images)) return undefined;
  return [...images]
    .sort((a, b) => imageArea(b) - imageArea(a))
    .map((image) => (isRecord(image) ? image.url : undefined))
    .find((url): url is string => typeof url === "string" && url.length > 0);
}

function bestStickerLegacyImageUrl(value: Record<string, unknown>): string | undefined {
  return firstString(
    value.photo_512,
    value.photo_352,
    value.photo_256,
    value.photo_128,
    value.photo_64,
    value.photo_512_url,
    value.photo_352_url,
    value.photo_256_url,
    value.photo_128_url,
    value.photo_64_url
  );
}

function vkStickerCdnUrl(value: Record<string, unknown>): string | undefined {
  const stickerId = numericStickerId(value.sticker_id ?? value.id);
  return stickerId ? `https://vk.ru/sticker/1-${stickerId}-512-` : undefined;
}

function imageArea(image: unknown): number {
  if (!isRecord(image)) return 0;
  const width = numericSize(image.width);
  const height = numericSize(image.height);
  return width * height;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function numericStickerId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function numericId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function numericSize(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10) || 0;
  return 0;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function nonNegativeInteger(value: unknown): number | undefined {
  const numberValue = numericId(value);
  return numberValue !== undefined && numberValue >= 0 ? numberValue : undefined;
}

function vkAttachmentSourceUrl(type: string, value: Record<string, unknown>): string | undefined {
  const ownerId = numericId(type === "wall" ? value.from_id ?? value.owner_id : value.owner_id ?? value.from_id);
  const id = numericId(value.id);
  if (ownerId === undefined || id === undefined) return undefined;

  switch (type) {
    case "doc":
    case "graffiti":
      return `https://vk.com/doc${ownerId}_${id}`;
    case "video":
      return `https://vk.com/video${ownerId}_${id}`;
    case "audio":
      return `https://vk.com/audio${ownerId}_${id}`;
    case "wall":
      return `https://vk.com/wall${ownerId}_${id}`;
    case "market":
      return `https://vk.com/market${ownerId}_${id}`;
    case "market_album":
      return `https://vk.com/market${ownerId}?section=album_${id}`;
    case "poll":
      return `https://vk.com/poll${ownerId}_${id}`;
    default:
      return undefined;
  }
}

function uploadedFileToken(uploaded: VkDocumentUploadResponse, type: VkMessageDocumentUploadType): string {
  if (uploaded.error) {
    throw new Error(`VK ${type} upload returned error: ${uploaded.error}`);
  }

  const file = firstString(
    uploaded.file,
    uploaded[type],
    uploaded.doc,
    uploaded.audio_message,
    uploaded.graffiti,
    uploaded.video_message
  );
  if (!file) {
    throw new Error(`VK ${type} upload returned no file token: ${truncate(JSON.stringify(uploaded), 500)}`);
  }
  return file;
}

async function uploadMessageDocumentFile(
  uploadUrl: string,
  input: { buffer: Buffer; filename: string; mimeType: string; type: VkMessageDocumentUploadType }
): Promise<string> {
  const fieldNames =
    input.type === "video_message"
      ? ["file", "video_message", "circle"]
      : input.type === "graffiti"
        ? ["file", "graffiti"]
        : ["file"];
  let lastError: unknown;

  for (const fieldName of fieldNames) {
    try {
      const uploaded = await uploadMultipart<VkDocumentUploadResponse>(uploadUrl, {
        fieldName,
        buffer: input.buffer,
        filename: input.filename,
        mimeType: input.mimeType
      });
      return uploadedFileToken(uploaded, input.type);
    } catch (error) {
      lastError = error;
    }
  }

  const suffix = `Tried multipart fields: ${fieldNames.join(", ")}`;
  if (lastError instanceof Error) {
    throw new Error(`${lastError.message}. ${suffix}`);
  }
  throw new Error(`${String(lastError)}. ${suffix}`);
}

async function uploadMultipart<T>(
  url: string,
  file: { fieldName: string; buffer: Buffer; filename: string; mimeType: string },
  attempt = 0
): Promise<T> {
  const form = new FormData();
  form.set(file.fieldName, new Blob([bufferToBlobPart(file.buffer)], { type: file.mimeType }), file.filename);
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { method: "POST", body: form }, config.runtime.mediaTimeoutMs);
  } catch (error) {
    if (attempt < config.runtime.maxNetworkRetries) {
      await sleep(retryDelayMs(attempt, config.runtime.retryBaseMs));
      return uploadMultipart(url, file, attempt + 1);
    }
    throw new Error(`VK upload network request failed after ${attempt + 1} attempts`, { cause: error });
  }
  if (isTransientHttpStatus(response.status) && attempt < config.runtime.maxNetworkRetries) {
    await response.body?.cancel().catch(() => undefined);
    await sleep(retryDelayMs(attempt, config.runtime.retryBaseMs));
    return uploadMultipart(url, file, attempt + 1);
  }
  if (!response.ok) {
    const preview = await readResponseBodyWithinLimit(response, Math.min(config.media.maxDownloadBytes, 4_096));
    throw new Error(`VK upload failed ${response.status}: ${truncate(preview.toString("utf8"), 500)}`);
  }
  return (await response.json()) as T;
}

function isRetryableVkError(code: number): boolean {
  return code === 1 || code === 6 || code === 9 || code === 10;
}

function parseVkResponse<T>(text: string): VkResponse<T> {
  try {
    return JSON.parse(text) as VkResponse<T>;
  } catch {
    return {
      error: {
        error_code: -1,
        error_msg: text || "empty response"
      }
    };
  }
}

function bufferToBlobPart(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}
