GRANT SELECT (
  id,
  personal_account_id,
  whatsapp_connection_id,
  starts_at,
  ends_at,
  cause
) ON app.ingestion_gaps TO whatsapp_api_runtime;

CREATE FUNCTION app_private.load_mcp_message_read_material(
  requested_authorization_id uuid,
  requested_oauth_subject text,
  requested_client_id text,
  requested_at timestamptz,
  requested_connection_public_id text,
  requested_conversation_public_id text
)
RETURNS TABLE (
  connection_id uuid,
  connection_created_at timestamptz,
  message_retention_days integer,
  personal_account_id uuid,
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea
)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    connections.id,
    connections.created_at,
    accounts.message_retention_days,
    connections.personal_account_id,
    account_keys.key_version,
    account_keys.kms_key_id,
    account_keys.ciphertext,
    connection_keys.account_key_version,
    connection_keys.key_version,
    connection_keys.nonce,
    connection_keys.ciphertext
  FROM app.mcp_authorizations AS authorizations
  JOIN app.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  JOIN app.mcp_authorization_connections AS selected
    ON selected.personal_account_id = authorizations.personal_account_id
   AND selected.mcp_authorization_id = authorizations.id
  JOIN app.whatsapp_connections AS connections
    ON connections.personal_account_id = selected.personal_account_id
   AND connections.id = selected.whatsapp_connection_id
  JOIN app.whatsapp_conversations AS conversations
    ON conversations.personal_account_id = connections.personal_account_id
   AND conversations.whatsapp_connection_id = connections.id
  JOIN app.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
  JOIN app.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = account_keys.personal_account_id
   AND connection_keys.account_key_version = account_keys.key_version
   AND connection_keys.whatsapp_connection_id = connections.id
  WHERE authorizations.id = requested_authorization_id
    AND authorizations.oauth_subject = requested_oauth_subject
    AND (
      requested_client_id IS NULL
      OR authorizations.client_id = requested_client_id
    )
    AND authorizations.personal_account_id = nullif(
      pg_catalog.current_setting('app.personal_account_id', true),
      ''
    )::uuid
    AND authorizations.state = 'active'
    AND authorizations.refresh_family_state = 'active'
    AND authorizations.absolute_expires_at > requested_at
    AND accounts.state = 'active'
    AND EXISTS (
      SELECT 1
      FROM app_private.clerk_identities AS identities
      WHERE identities.personal_account_id = authorizations.personal_account_id
    )
    AND 'messages:read' = ANY(authorizations.scopes)
    AND connections.public_id = requested_connection_public_id
    AND conversations.public_id = requested_conversation_public_id
    AND connections.state <> 'deleting'
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL
$function$;

REVOKE ALL
  ON FUNCTION app_private.load_mcp_message_read_material(
    uuid, text, text, timestamptz, text, text
  )
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION app_private.load_mcp_message_read_material(
    uuid, text, text, timestamptz, text, text
  )
  TO whatsapp_api_runtime;

CREATE INDEX stored_messages_chronological_read
ON app.stored_messages (
  personal_account_id,
  whatsapp_connection_id,
  conversation_id,
  sent_at DESC,
  public_id DESC
);
