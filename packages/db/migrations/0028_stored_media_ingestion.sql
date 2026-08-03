ALTER TABLE app.personal_accounts
  ADD COLUMN stored_media_used_bytes bigint NOT NULL DEFAULT 0
    CHECK (stored_media_used_bytes >= 0 AND stored_media_used_bytes <= stored_media_limit_bytes);

ALTER TABLE app.stored_messages
  ADD CONSTRAINT stored_messages_tenant_identity
  UNIQUE (personal_account_id, whatsapp_connection_id, id);

CREATE TABLE app.stored_media (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  stored_message_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^med_[A-Za-z0-9_-]{21}$'),
  state text NOT NULL CHECK (state IN ('pending','ready','rejected','failed')),
  media_type text NOT NULL CHECK (media_type IN ('audio','document','image','sticker','video')),
  source_ciphertext_version smallint CHECK (source_ciphertext_version = 1),
  source_key_version integer CHECK (source_key_version > 0),
  source_nonce bytea CHECK (octet_length(source_nonce) = 12),
  source_ciphertext bytea,
  object_key text UNIQUE,
  plaintext_size_bytes bigint CHECK (plaintext_size_bytes >= 0),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  metadata_ciphertext_version smallint CHECK (metadata_ciphertext_version = 1),
  metadata_key_version integer CHECK (metadata_key_version > 0),
  metadata_nonce bytea CHECK (octet_length(metadata_nonce) = 12),
  metadata_ciphertext bytea,
  failure_code text CHECK (failure_code IN ('policy_rejected','processing_failed','object_missing','quota_exceeded')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (personal_account_id, whatsapp_connection_id, stored_message_id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id, stored_message_id)
    REFERENCES app.stored_messages (personal_account_id, whatsapp_connection_id, id) ON DELETE CASCADE,
  CHECK (
    (state = 'pending' AND source_ciphertext IS NOT NULL AND source_nonce IS NOT NULL
      AND source_key_version IS NOT NULL AND source_ciphertext_version IS NOT NULL
      AND object_key IS NULL AND plaintext_size_bytes IS NULL AND sha256 IS NULL
      AND metadata_ciphertext IS NULL AND failure_code IS NULL)
    OR
    (state = 'ready' AND source_ciphertext IS NULL AND source_nonce IS NULL
      AND source_key_version IS NULL AND source_ciphertext_version IS NULL
      AND object_key IS NOT NULL AND plaintext_size_bytes IS NOT NULL AND sha256 IS NOT NULL
      AND metadata_ciphertext IS NOT NULL AND metadata_nonce IS NOT NULL
      AND metadata_key_version IS NOT NULL AND metadata_ciphertext_version IS NOT NULL
      AND failure_code IS NULL)
    OR
    (state IN ('rejected','failed') AND source_ciphertext IS NULL AND source_nonce IS NULL
      AND source_key_version IS NULL AND source_ciphertext_version IS NULL
      AND object_key IS NULL AND plaintext_size_bytes IS NULL AND sha256 IS NULL
      AND metadata_ciphertext IS NULL AND metadata_nonce IS NULL
      AND metadata_key_version IS NULL AND metadata_ciphertext_version IS NULL
      AND failure_code IS NOT NULL)
  )
);

CREATE INDEX stored_media_pending ON app.stored_media (created_at, id) WHERE state = 'pending';

CREATE TABLE app.stored_media_object_deletions (
  personal_account_id uuid NOT NULL,
  object_key text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT transaction_timestamp()
  ,PRIMARY KEY (personal_account_id, object_key)
);

ALTER TABLE app.stored_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stored_media FORCE ROW LEVEL SECURITY;
ALTER TABLE app.stored_media_object_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stored_media_object_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY stored_media_tenant ON app.stored_media
  USING (personal_account_id = nullif(pg_catalog.current_setting('app.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(pg_catalog.current_setting('app.personal_account_id', true), '')::uuid);
CREATE POLICY stored_media_object_deletions_tenant ON app.stored_media_object_deletions
  USING (personal_account_id = nullif(pg_catalog.current_setting('app.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(pg_catalog.current_setting('app.personal_account_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.stored_media TO whatsapp_api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.stored_media TO whatsapp_webhook_runtime;
GRANT SELECT, INSERT, DELETE ON app.stored_media_object_deletions TO whatsapp_api_runtime, whatsapp_webhook_runtime;
GRANT SELECT (stored_media_used_bytes), UPDATE (stored_media_used_bytes)
  ON app.personal_accounts TO whatsapp_api_runtime, whatsapp_webhook_runtime;

CREATE FUNCTION app_private.list_pending_stored_media(requested_limit integer)
RETURNS TABLE (
  id uuid, personal_account_id uuid, whatsapp_connection_id uuid, media_type text,
  source_ciphertext_version smallint, source_key_version integer, source_nonce bytea, source_ciphertext bytea,
  account_key_version integer, account_kms_key_id text, account_key_ciphertext bytea,
  connection_key_account_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea,
  authority_ciphertext_version smallint, authority_key_version integer,
  authority_nonce bytea, authority_ciphertext bytea
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app, app_private AS $function$
  SELECT media.id, media.personal_account_id, media.whatsapp_connection_id, media.media_type,
    media.source_ciphertext_version, media.source_key_version, media.source_nonce, media.source_ciphertext,
    account_keys.key_version, account_keys.kms_key_id, account_keys.ciphertext,
    connection_keys.account_key_version, connection_keys.key_version, connection_keys.nonce, connection_keys.ciphertext,
    sessions.authority_ciphertext_version, sessions.authority_key_version, sessions.authority_nonce, sessions.authority_ciphertext
  FROM app.stored_media media
  JOIN app.whatsapp_connection_key_envelopes connection_keys
    ON connection_keys.personal_account_id=media.personal_account_id AND connection_keys.whatsapp_connection_id=media.whatsapp_connection_id
  JOIN app.personal_account_key_envelopes account_keys
    ON account_keys.personal_account_id=media.personal_account_id AND account_keys.key_version=connection_keys.account_key_version
  JOIN app.whatsapp_connection_provider_sessions sessions
    ON sessions.personal_account_id=media.personal_account_id AND sessions.whatsapp_connection_id=media.whatsapp_connection_id
      AND sessions.authority_key_version=connection_keys.key_version
  WHERE media.state='pending' AND account_keys.unavailable_at IS NULL AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL AND connection_keys.ciphertext IS NOT NULL
    AND sessions.authority_ciphertext IS NOT NULL
  ORDER BY media.created_at, media.id LIMIT requested_limit;
$function$;
REVOKE ALL ON FUNCTION app_private.list_pending_stored_media(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.list_pending_stored_media(integer) TO whatsapp_api_runtime;

CREATE FUNCTION app_private.list_stored_media_object_deletions(requested_limit integer)
RETURNS TABLE (personal_account_id uuid, object_key text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app, app_private AS $function$
  SELECT deletions.personal_account_id, deletions.object_key
  FROM app.stored_media_object_deletions deletions
  ORDER BY deletions.requested_at, deletions.object_key LIMIT requested_limit;
$function$;
REVOKE ALL ON FUNCTION app_private.list_stored_media_object_deletions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.list_stored_media_object_deletions(integer) TO whatsapp_api_runtime;
