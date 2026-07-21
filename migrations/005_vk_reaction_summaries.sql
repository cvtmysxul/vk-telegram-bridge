CREATE TABLE IF NOT EXISTS vk_reaction_summaries (
  id bigserial PRIMARY KEY,
  vk_peer_id bigint NOT NULL,
  vk_conversation_message_id bigint NOT NULL,
  telegram_chat_id bigint NOT NULL,
  telegram_message_id bigint NOT NULL,
  telegram_thread_id integer NOT NULL,
  summary_telegram_message_id bigint NOT NULL,
  snapshot text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vk_reaction_summaries_vk_message_idx
  ON vk_reaction_summaries(vk_peer_id, vk_conversation_message_id);

CREATE INDEX IF NOT EXISTS vk_reaction_summaries_telegram_idx
  ON vk_reaction_summaries(telegram_chat_id, summary_telegram_message_id);
