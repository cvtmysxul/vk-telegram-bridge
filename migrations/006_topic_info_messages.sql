CREATE TABLE IF NOT EXISTS topic_info_messages (
  id bigserial PRIMARY KEY,
  vk_peer_id bigint NOT NULL REFERENCES vk_peers(peer_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('profile', 'participants')),
  telegram_chat_id bigint NOT NULL,
  telegram_message_id bigint NOT NULL,
  telegram_thread_id integer NOT NULL,
  snapshot text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS topic_info_messages_telegram_idx
  ON topic_info_messages(telegram_chat_id, telegram_message_id);

CREATE INDEX IF NOT EXISTS topic_info_messages_peer_kind_idx
  ON topic_info_messages(vk_peer_id, kind);
