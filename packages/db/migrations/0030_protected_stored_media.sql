ALTER TABLE app.tool_call_logs
  ADD COLUMN media_bytes_reserved bigint NOT NULL DEFAULT 0
    CHECK (media_bytes_reserved >= 0),
  ADD CONSTRAINT tool_call_logs_media_reservation
    CHECK (
      (tool_name = 'read_stored_media' AND quota_reserved)
      OR (tool_name <> 'read_stored_media' AND media_bytes_reserved = 0)
    );

CREATE INDEX tool_call_logs_media_quota
ON app.tool_call_logs (personal_account_id, started_at)
INCLUDE (media_bytes_reserved)
WHERE media_bytes_reserved > 0;

CREATE FUNCTION app_private.load_protected_stored_media(
  candidate_authorization_id uuid,
  candidate_connection_public_id text,
  candidate_message_public_id text,
  candidate_media_public_id text
)
RETURNS TABLE (
  media_id uuid, object_key text, plaintext_size_bytes bigint,
  metadata_ciphertext_version smallint, metadata_key_version integer,
  metadata_nonce bytea, metadata_ciphertext bytea,
  account_key_version integer, kms_key_id text, account_key_ciphertext bytea,
  connection_account_key_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea, connection_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, app_private
AS $function$
  SELECT media.id,media.object_key,media.plaintext_size_bytes,
    media.metadata_ciphertext_version,media.metadata_key_version,media.metadata_nonce,media.metadata_ciphertext,
    keys.key_version,keys.kms_key_id,keys.ciphertext,
    connection_keys.account_key_version,connection_keys.key_version,connection_keys.nonce,
    connection_keys.ciphertext,connections.id
  FROM app.stored_media media
  JOIN app.stored_messages messages ON messages.personal_account_id=media.personal_account_id
    AND messages.whatsapp_connection_id=media.whatsapp_connection_id AND messages.id=media.stored_message_id
  JOIN app.whatsapp_connections connections ON connections.personal_account_id=media.personal_account_id
    AND connections.id=media.whatsapp_connection_id
  JOIN app.mcp_authorization_connections selected ON selected.personal_account_id=media.personal_account_id
    AND selected.whatsapp_connection_id=media.whatsapp_connection_id
    AND selected.mcp_authorization_id=candidate_authorization_id
  JOIN app.whatsapp_connection_key_envelopes connection_keys ON connection_keys.personal_account_id=media.personal_account_id
    AND connection_keys.whatsapp_connection_id=media.whatsapp_connection_id
  JOIN app.personal_account_key_envelopes keys ON keys.personal_account_id=media.personal_account_id
    AND keys.key_version=connection_keys.account_key_version
  WHERE media.personal_account_id=nullif(pg_catalog.current_setting('app.personal_account_id',true),'')::uuid
    AND connections.public_id=candidate_connection_public_id
    AND messages.public_id=candidate_message_public_id
    AND media.public_id=candidate_media_public_id AND media.state='ready'
    AND media.plaintext_size_bytes <= 16777216 AND messages.deleted_at IS NULL
    AND connections.state <> 'deleting' AND keys.unavailable_at IS NULL
    AND keys.ciphertext IS NOT NULL AND connection_keys.unavailable_at IS NULL
    AND connection_keys.ciphertext IS NOT NULL;
$function$;

REVOKE ALL ON FUNCTION app_private.load_protected_stored_media(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.load_protected_stored_media(uuid,text,text,text) TO whatsapp_api_runtime;
