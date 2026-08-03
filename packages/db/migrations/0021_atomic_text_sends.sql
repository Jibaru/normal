ALTER TABLE app.tool_call_logs
ADD CONSTRAINT tool_call_logs_tenant_id_unique UNIQUE (personal_account_id, id);

CREATE TABLE app.send_operations (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^snd_[A-Za-z0-9_-]{21}$'),
  personal_account_id uuid NOT NULL,
  mcp_authorization_id uuid NOT NULL,
  tool_call_log_id uuid NOT NULL UNIQUE,
  whatsapp_connection_id uuid NOT NULL,
  recipient_type text NOT NULL CHECK (recipient_type IN ('contact', 'group')),
  recipient_public_id text NOT NULL CHECK (recipient_public_id ~ '^(ctc|grp)_[A-Za-z0-9_-]{21}$'),
  status text NOT NULL CHECK (status IN ('processing','accepted','sent','delivered','read','failed','unknown')),
  created_at timestamptz NOT NULL,
  status_changed_at timestamptz NOT NULL,
  attempt_claimed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (personal_account_id, mcp_authorization_id)
    REFERENCES app.mcp_authorizations (personal_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id) ON DELETE CASCADE,
  UNIQUE (personal_account_id, id),
  FOREIGN KEY (personal_account_id, tool_call_log_id)
    REFERENCES app.tool_call_logs (personal_account_id, id) ON DELETE CASCADE,
  CHECK (lease_expires_at = attempt_claimed_at + interval '30 seconds'),
  CHECK (expires_at = created_at + interval '90 days')
);

CREATE TABLE app.send_idempotency_bindings (
  personal_account_id uuid NOT NULL,
  mcp_authorization_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{21}$'),
  send_operation_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^sf1_[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (mcp_authorization_id, idempotency_key),
  UNIQUE (send_operation_id),
  FOREIGN KEY (personal_account_id, mcp_authorization_id)
    REFERENCES app.mcp_authorizations (personal_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, send_operation_id)
    REFERENCES app.send_operations (personal_account_id, id) ON DELETE CASCADE,
  CHECK (expires_at = created_at + interval '90 days')
);

CREATE TABLE app.pending_send_contents (
  send_operation_id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  ciphertext_version smallint NOT NULL CHECK (ciphertext_version = 1),
  key_version integer NOT NULL CHECK (key_version > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 16),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, send_operation_id)
    REFERENCES app.send_operations (personal_account_id, id) ON DELETE CASCADE
);

CREATE TABLE app.send_quota_reservations (
  send_operation_id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL REFERENCES app.personal_accounts (id) ON DELETE CASCADE,
  mcp_authorization_id uuid NOT NULL,
  reserved_at timestamptz NOT NULL,
  FOREIGN KEY (personal_account_id, mcp_authorization_id)
    REFERENCES app.mcp_authorizations (personal_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, send_operation_id)
    REFERENCES app.send_operations (personal_account_id, id) ON DELETE CASCADE
);
CREATE INDEX send_quota_account_time ON app.send_quota_reservations (personal_account_id, reserved_at);
CREATE INDEX send_quota_authorization_time ON app.send_quota_reservations (mcp_authorization_id, reserved_at);

ALTER TABLE app.send_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.send_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.send_idempotency_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.send_idempotency_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.pending_send_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pending_send_contents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.send_quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.send_quota_reservations FORCE ROW LEVEL SECURITY;

CREATE POLICY send_operations_tenant ON app.send_operations
USING (personal_account_id = nullif(current_setting('app.personal_account_id', true), '')::uuid)
WITH CHECK (personal_account_id = nullif(current_setting('app.personal_account_id', true), '')::uuid);
CREATE POLICY send_bindings_tenant ON app.send_idempotency_bindings
USING (personal_account_id = nullif(current_setting('app.personal_account_id', true), '')::uuid)
WITH CHECK (personal_account_id = nullif(current_setting('app.personal_account_id', true), '')::uuid);
CREATE POLICY pending_send_contents_tenant ON app.pending_send_contents
USING (personal_account_id = nullif(current_setting('app.personal_account_id', true), '')::uuid)
WITH CHECK (personal_account_id = nullif(current_setting('app.personal_account_id', true), '')::uuid);
CREATE POLICY send_quota_tenant ON app.send_quota_reservations
USING (personal_account_id = nullif(current_setting('app.personal_account_id', true), '')::uuid)
WITH CHECK (personal_account_id = nullif(current_setting('app.personal_account_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON app.send_operations TO whatsapp_api_runtime;
GRANT SELECT, INSERT, UPDATE ON app.send_idempotency_bindings TO whatsapp_api_runtime;
GRANT SELECT, INSERT, DELETE ON app.pending_send_contents TO whatsapp_api_runtime;
GRANT SELECT, INSERT ON app.send_quota_reservations TO whatsapp_api_runtime;

CREATE FUNCTION app_private.bootstrap_send_operation(candidate_send_id uuid)
RETURNS uuid LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT personal_account_id FROM app.send_operations WHERE id = candidate_send_id
$function$;
REVOKE ALL ON FUNCTION app_private.bootstrap_send_operation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.bootstrap_send_operation(uuid) TO whatsapp_api_runtime;

CREATE FUNCTION app_private.load_send_key_material(
  requested_personal_account_id uuid,
  requested_connection_id uuid
)
RETURNS TABLE (
  account_key_version integer,
  kms_key_id text,
  account_key_ciphertext bytea,
  connection_account_key_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea,
  authority_key_version integer,
  authority_nonce bytea,
  authority_ciphertext bytea,
  identity_key_version integer,
  identity_nonce bytea,
  identity_ciphertext bytea
)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT account_keys.key_version, account_keys.kms_key_id,
    account_keys.ciphertext, connection_keys.account_key_version,
    connection_keys.key_version, connection_keys.nonce,
    connection_keys.ciphertext, sessions.authority_key_version,
    sessions.authority_nonce, sessions.authority_ciphertext,
    identity_keys.credential_key_version, identity_keys.credential_nonce,
    identity_keys.credential_ciphertext
  FROM app.personal_account_key_envelopes account_keys
  JOIN app.whatsapp_connection_key_envelopes connection_keys
    ON connection_keys.personal_account_id=account_keys.personal_account_id
  JOIN app.whatsapp_connection_provider_sessions sessions
    ON sessions.personal_account_id=connection_keys.personal_account_id
   AND sessions.whatsapp_connection_id=connection_keys.whatsapp_connection_id
  JOIN app.whatsapp_connection_secrets identity_keys
    ON identity_keys.personal_account_id=connection_keys.personal_account_id
   AND identity_keys.whatsapp_connection_id=connection_keys.whatsapp_connection_id
  WHERE account_keys.personal_account_id=requested_personal_account_id
    AND connection_keys.whatsapp_connection_id=requested_connection_id
    AND requested_personal_account_id = nullif(current_setting('app.personal_account_id', true), '')::uuid
    AND account_keys.unavailable_at IS NULL
    AND connection_keys.unavailable_at IS NULL
$function$;
REVOKE ALL ON FUNCTION app_private.load_send_key_material(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.load_send_key_material(uuid, uuid) TO whatsapp_api_runtime;
