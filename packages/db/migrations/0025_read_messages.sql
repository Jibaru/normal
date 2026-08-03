GRANT SELECT (
  id,
  personal_account_id,
  whatsapp_connection_id,
  starts_at,
  ends_at,
  cause
) ON app.ingestion_gaps TO whatsapp_api_runtime;

CREATE INDEX stored_messages_chronological_read
ON app.stored_messages (
  personal_account_id,
  whatsapp_connection_id,
  conversation_id,
  sent_at DESC,
  public_id DESC
);
