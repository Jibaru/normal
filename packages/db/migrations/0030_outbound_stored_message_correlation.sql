ALTER TABLE app.stored_messages
  ALTER COLUMN webhook_item_identity DROP NOT NULL;

GRANT SELECT, INSERT, UPDATE
  ON app.whatsapp_conversations, app.stored_messages
  TO whatsapp_webhook_runtime;

GRANT SELECT (recipient_type, recipient_public_id)
  ON app.send_operations TO whatsapp_webhook_runtime;
GRANT SELECT (key_version, nonce, ciphertext, expires_at)
  ON app.pending_send_contents TO whatsapp_webhook_runtime;
GRANT SELECT (personal_account_id, whatsapp_connection_id, public_id, provider_identity_index)
  ON app.directory_contacts TO whatsapp_webhook_runtime;
GRANT SELECT (personal_account_id, whatsapp_connection_id, public_id, provider_locator)
  ON app.whatsapp_groups TO whatsapp_webhook_runtime;
