CREATE TABLE IF NOT EXISTS vk_message_states (
  id bigserial PRIMARY KEY,
  vk_peer_id bigint NOT NULL,
  vk_message_id bigint NOT NULL,
  vk_conversation_message_id bigint,
  telegram_chat_id bigint NOT NULL,
  telegram_message_id bigint NOT NULL,
  telegram_thread_id integer NOT NULL,
  current_text text NOT NULL,
  edited boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false,
  history_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vk_message_states_vk_message_idx
  ON vk_message_states(vk_peer_id, vk_message_id);

CREATE INDEX IF NOT EXISTS vk_message_states_vk_cmid_idx
  ON vk_message_states(vk_peer_id, vk_conversation_message_id);

CREATE TABLE IF NOT EXISTS vk_message_versions (
  id bigserial PRIMARY KEY,
  state_id bigint NOT NULL REFERENCES vk_message_states(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  text text NOT NULL,
  vk_date integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vk_message_versions_state_version_idx
  ON vk_message_versions(state_id, version_no);
