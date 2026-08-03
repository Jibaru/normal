ALTER TABLE app.stored_messages
  ALTER COLUMN content_type DROP NOT NULL,
  ALTER COLUMN content_ciphertext_version DROP NOT NULL,
  ALTER COLUMN content_key_version DROP NOT NULL,
  ALTER COLUMN content_nonce DROP NOT NULL,
  ALTER COLUMN content_ciphertext DROP NOT NULL,
  ADD COLUMN edited_at timestamptz,
  ADD COLUMN deleted_at timestamptz;

ALTER TABLE app.stored_messages
  ADD CONSTRAINT stored_messages_content_or_tombstone CHECK (
    (deleted_at IS NULL AND content_type IS NOT NULL
      AND content_ciphertext_version IS NOT NULL
      AND content_key_version IS NOT NULL
      AND content_nonce IS NOT NULL
      AND content_ciphertext IS NOT NULL)
    OR
    (deleted_at IS NOT NULL AND content_type IS NULL
      AND content_ciphertext_version IS NULL
      AND content_key_version IS NULL
      AND content_nonce IS NULL
      AND content_ciphertext IS NULL)
  );

GRANT SELECT (edited_at, deleted_at)
  ON app.stored_messages TO whatsapp_api_runtime, whatsapp_webhook_runtime;
GRANT INSERT (edited_at, deleted_at), UPDATE (edited_at, deleted_at)
  ON app.stored_messages TO whatsapp_webhook_runtime;
GRANT SELECT, INSERT, UPDATE ON app.stored_messages, app.whatsapp_conversations
  TO whatsapp_webhook_runtime;
