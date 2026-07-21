export type Direction = "vk_to_tg" | "tg_to_vk";

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReactionUpdated;
}

export type TelegramReactionType =
  | { type: "emoji"; emoji: string }
  | { type: "custom_emoji"; custom_emoji_id: string }
  | { type: "paid" };

export interface TelegramMessageReactionUpdated {
  chat: { id: number; type: string; title?: string; is_forum?: boolean };
  message_id: number;
  user?: TelegramUser;
  actor_chat?: { id: number; type: string; title?: string };
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramFileRef {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
  duration?: number;
  file_name?: string;
  mime_type?: string;
  emoji?: string;
  set_name?: string;
  is_animated?: boolean;
  is_video?: boolean;
  thumbnail?: TelegramFileRef;
}

export interface TelegramSticker extends TelegramFileRef {
  type?: string;
  custom_emoji_id?: string;
}

export interface TelegramStickerSet {
  name: string;
  title: string;
  sticker_type: string;
  stickers: TelegramSticker[];
}

export interface TelegramAudio extends TelegramFileRef {
  performer?: string;
  title?: string;
}

export interface TelegramForwardOrigin {
  type?: "user" | "hidden_user" | "chat" | "channel" | string;
  date?: number;
  sender_user?: TelegramUser;
  sender_user_name?: string;
  sender_chat?: { id: number; type: string; title?: string; username?: string };
  chat?: { id: number; type: string; title?: string; username?: string };
  author_signature?: string;
  message_id?: number;
}

export interface TelegramLocation {
  latitude: number;
  longitude: number;
}

export interface TelegramVenue {
  location: TelegramLocation;
  title: string;
  address: string;
}

export interface TelegramContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
}

export interface TelegramPoll {
  question: string;
  options: Array<{ text: string; voter_count?: number }>;
  total_voter_count?: number;
  is_closed?: boolean;
}

export interface TelegramDice {
  emoji: string;
  value: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TelegramUser;
  chat: { id: number; type: string; title?: string; is_forum?: boolean };
  date: number;
  edit_date?: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  pinned_message?: TelegramMessage;
  photo?: TelegramFileRef[];
  voice?: TelegramFileRef;
  document?: TelegramFileRef;
  video?: TelegramFileRef;
  audio?: TelegramAudio;
  video_note?: TelegramFileRef;
  animation?: TelegramFileRef;
  sticker?: TelegramSticker;
  forward_origin?: TelegramForwardOrigin;
  forward_from?: TelegramUser;
  forward_from_chat?: { id: number; type: string; title?: string; username?: string };
  forward_sender_name?: string;
  forward_date?: number;
  location?: TelegramLocation;
  venue?: TelegramVenue;
  contact?: TelegramContact;
  poll?: TelegramPoll;
  dice?: TelegramDice;
  forum_topic_created?: unknown;
  forum_topic_edited?: unknown;
  forum_topic_closed?: unknown;
  forum_topic_reopened?: unknown;
  general_forum_topic_hidden?: unknown;
  general_forum_topic_unhidden?: unknown;
  message_auto_delete_timer_changed?: unknown;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}

export interface TelegramForumTopic {
  message_thread_id: number;
  name: string;
}

export interface VkLongPollServer {
  key: string;
  server: string;
  ts: string | number;
  pts?: string | number;
}

export type VkLongPollUpdate = unknown[];

export interface VkAttachment {
  type: string;
  [key: string]: unknown;
}

export interface VkKeyboardButtonAction {
  type?: string;
  label?: string;
  payload?: unknown;
  link?: string;
  app_id?: number;
  owner_id?: number;
  hash?: string;
}

export interface VkKeyboardButton {
  action?: VkKeyboardButtonAction;
  color?: string;
}

export interface VkKeyboard {
  inline?: boolean;
  one_time?: boolean;
  author_id?: number;
  buttons?: VkKeyboardButton[][];
}

export interface VkMessage {
  id: number;
  conversation_message_id?: number;
  peer_id: number;
  from_id?: number;
  date?: number;
  update_time?: number;
  text?: string;
  out?: number;
  random_id?: number;
  attachments?: VkAttachment[];
  reaction_id?: number;
  reactions?: Array<{
    reaction_id: number;
    count: number;
    user_ids?: number[];
  }>;
  last_reaction_id?: number;
  keyboard?: VkKeyboard | string;
  template?: unknown;
  reply_message?: VkMessage;
  fwd_messages?: VkMessage[];
  action?: {
    type?: string;
    member_id?: number;
    conversation_message_id?: number;
    message?: string;
    text?: string;
    email?: string;
    style?: string;
    photo?: {
      photo_50?: string;
      photo_100?: string;
      photo_200?: string;
    };
    [key: string]: unknown;
  };
}

export interface VkPeerInfo {
  peerId: number;
  displayName: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  avatarUrl?: string;
  isChat: boolean;
  raw: unknown;
}

export interface VkChatParticipant {
  id: number;
  displayName: string;
}

export interface MessageMapRow {
  vk_peer_id: string;
  vk_message_id: string | null;
  vk_conversation_message_id: string | null;
  telegram_chat_id: string;
  telegram_message_id: string;
  telegram_thread_id: number;
  direction: Direction;
}
