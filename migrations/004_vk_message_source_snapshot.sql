ALTER TABLE vk_message_states
  ADD COLUMN IF NOT EXISTS source_snapshot text;
