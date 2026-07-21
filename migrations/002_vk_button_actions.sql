CREATE TABLE IF NOT EXISTS vk_button_actions (
  id text PRIMARY KEY,
  vk_peer_id bigint NOT NULL,
  vk_message_id bigint,
  vk_conversation_message_id bigint,
  vk_author_id bigint,
  vk_inline boolean NOT NULL DEFAULT false,
  telegram_chat_id bigint NOT NULL,
  telegram_message_id bigint NOT NULL,
  action_type text NOT NULL,
  label text NOT NULL,
  payload text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vk_button_actions_telegram_idx
  ON vk_button_actions(telegram_chat_id, telegram_message_id);

CREATE INDEX IF NOT EXISTS vk_button_actions_vk_idx
  ON vk_button_actions(vk_peer_id, vk_message_id);
