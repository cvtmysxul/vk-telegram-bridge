CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vk_peers (
  peer_id bigint PRIMARY KEY,
  display_name text NOT NULL,
  first_name text,
  last_name text,
  title text,
  is_chat boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topics (
  id bigserial PRIMARY KEY,
  vk_peer_id bigint UNIQUE REFERENCES vk_peers(peer_id) ON DELETE CASCADE,
  telegram_chat_id bigint NOT NULL,
  message_thread_id integer NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS topics_active_thread_idx
  ON topics(telegram_chat_id, message_thread_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS topics_lru_idx
  ON topics(created_at)
  WHERE deleted_at IS NULL AND vk_peer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_map (
  id bigserial PRIMARY KEY,
  vk_peer_id bigint NOT NULL,
  vk_message_id bigint,
  vk_conversation_message_id bigint,
  telegram_chat_id bigint NOT NULL,
  telegram_message_id bigint NOT NULL,
  telegram_thread_id integer NOT NULL,
  direction text NOT NULL CHECK (direction IN ('vk_to_tg', 'tg_to_vk')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS message_map_telegram_idx
  ON message_map(telegram_chat_id, telegram_message_id);

CREATE INDEX IF NOT EXISTS message_map_vk_idx
  ON message_map(vk_peer_id, vk_message_id);

CREATE INDEX IF NOT EXISTS message_map_vk_cmid_idx
  ON message_map(vk_peer_id, vk_conversation_message_id);

CREATE TABLE IF NOT EXISTS peer_pins (
  vk_peer_id bigint PRIMARY KEY,
  vk_message_id bigint,
  vk_conversation_message_id bigint,
  telegram_chat_id bigint NOT NULL,
  telegram_message_id bigint,
  telegram_thread_id integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
