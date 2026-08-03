ALTER TABLE app.send_operations
  ADD COLUMN message_identity text;

CREATE UNIQUE INDEX send_operations_message_identity
  ON app.send_operations (whatsapp_connection_id, message_identity)
  WHERE message_identity IS NOT NULL;

GRANT SELECT (message_identity), UPDATE (message_identity)
  ON app.send_operations TO whatsapp_api_runtime, whatsapp_webhook_runtime;
GRANT SELECT (id, public_id, personal_account_id, mcp_authorization_id,
  whatsapp_connection_id, status, created_at, status_changed_at, expires_at)
  ON app.send_operations TO whatsapp_webhook_runtime;
GRANT UPDATE (status, status_changed_at)
  ON app.send_operations TO whatsapp_webhook_runtime;
GRANT SELECT (personal_account_id, send_operation_id), DELETE
  ON app.pending_send_contents TO whatsapp_webhook_runtime;
