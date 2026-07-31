CREATE TABLE app.whatsapp_group_directory_states (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  as_of timestamptz,
  stale boolean NOT NULL,
  partial boolean NOT NULL,
  reconciliation_claim_id uuid,
  reconciliation_lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (personal_account_id, whatsapp_connection_id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (
    (reconciliation_claim_id IS NULL) =
    (reconciliation_lease_expires_at IS NULL)
  )
);

CREATE TABLE app.whatsapp_groups (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE
    CHECK (public_id ~ '^grp_[A-Za-z0-9_-]{21}$'),
  provider_locator text NOT NULL
    CHECK (provider_locator ~ '^wi1_[A-Za-z0-9_-]{43}$'),
  display_name_ciphertext_version smallint
    CHECK (display_name_ciphertext_version IS NULL OR display_name_ciphertext_version > 0),
  display_name_key_version integer
    CHECK (display_name_key_version IS NULL OR display_name_key_version > 0),
  display_name_nonce bytea
    CHECK (display_name_nonce IS NULL OR octet_length(display_name_nonce) = 12),
  display_name_ciphertext bytea,
  provider_identity_ciphertext_version smallint NOT NULL
    CHECK (provider_identity_ciphertext_version > 0),
  provider_identity_key_version integer NOT NULL
    CHECK (provider_identity_key_version > 0),
  provider_identity_nonce bytea NOT NULL
    CHECK (octet_length(provider_identity_nonce) = 12),
  provider_identity_ciphertext bytea NOT NULL
    CHECK (octet_length(provider_identity_ciphertext) > 16),
  joined boolean NOT NULL,
  last_observed_at timestamptz NOT NULL,
  provider_occurred_at timestamptz,
  provider_version text,
  received_at timestamptz,
  webhook_event_id uuid,
  webhook_item_identity text
    CHECK (
      webhook_item_identity IS NULL
      OR webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'
    ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (personal_account_id, whatsapp_connection_id, provider_locator),
  UNIQUE (personal_account_id, whatsapp_connection_id, id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (
    (
      display_name_ciphertext_version IS NULL
      AND display_name_key_version IS NULL
      AND display_name_nonce IS NULL
      AND display_name_ciphertext IS NULL
    ) OR (
      display_name_ciphertext_version IS NOT NULL
      AND display_name_key_version IS NOT NULL
      AND display_name_nonce IS NOT NULL
      AND display_name_ciphertext IS NOT NULL
      AND octet_length(display_name_ciphertext) > 16
    )
  )
);

ALTER TABLE app.whatsapp_group_directory_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_group_directory_states FORCE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_groups FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_group_directory_states_tenant
ON app.whatsapp_group_directory_states
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true), ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true), ''
  )::uuid
);

CREATE POLICY whatsapp_groups_tenant
ON app.whatsapp_groups
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true), ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true), ''
  )::uuid
);

GRANT SELECT, INSERT, UPDATE
  ON app.whatsapp_group_directory_states
  TO whatsapp_api_runtime, whatsapp_webhook_runtime;
GRANT SELECT, INSERT, UPDATE
  ON app.whatsapp_groups
  TO whatsapp_api_runtime, whatsapp_webhook_runtime;

CREATE FUNCTION app_private.bootstrap_whatsapp_group_projection(
  requested_personal_account_id uuid,
  requested_whatsapp_connection_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT connections.personal_account_id
  FROM app.whatsapp_connections AS connections
  JOIN app.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE connections.personal_account_id = requested_personal_account_id
    AND connections.id = requested_whatsapp_connection_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
$function$;

REVOKE ALL
  ON FUNCTION app_private.bootstrap_whatsapp_group_projection(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION app_private.bootstrap_whatsapp_group_projection(uuid, uuid)
  TO whatsapp_api_runtime, whatsapp_webhook_runtime;

CREATE FUNCTION app_private.load_mcp_group_projection_material(
  requested_authorization_id uuid,
  requested_oauth_subject text,
  requested_client_id text,
  requested_at timestamptz,
  requested_connection_public_id text
)
RETURNS TABLE (
  connection_id uuid,
  connection_created_at timestamptz,
  personal_account_id uuid,
  as_of timestamptz,
  stale boolean,
  partial boolean,
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    connections.id,
    connections.created_at,
    connections.personal_account_id,
    states.as_of,
    coalesce(states.stale, true),
    coalesce(states.partial, true),
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
  JOIN app.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  JOIN app.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  LEFT JOIN app.whatsapp_group_directory_states AS states
    ON states.personal_account_id = connections.personal_account_id
   AND states.whatsapp_connection_id = connections.id
  WHERE authorizations.id = requested_authorization_id
    AND authorizations.oauth_subject = requested_oauth_subject
    AND (
      requested_client_id IS NULL
      OR authorizations.client_id = requested_client_id
    )
    AND authorizations.personal_account_id = nullif(
      pg_catalog.current_setting('app.personal_account_id', true), ''
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
    AND 'directory:read' = ANY(authorizations.scopes)
    AND connections.public_id = requested_connection_public_id
    AND connections.state <> 'deleting'
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL
  FOR SHARE OF authorizations, accounts, connections
$function$;

REVOKE ALL
  ON FUNCTION app_private.load_mcp_group_projection_material(
    uuid, text, text, timestamptz, text
  )
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION app_private.load_mcp_group_projection_material(
    uuid, text, text, timestamptz, text
  )
  TO whatsapp_api_runtime;

CREATE FUNCTION app_private.claim_whatsapp_group_reconciliation(
  requested_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  claim_id uuid,
  personal_account_id uuid,
  whatsapp_connection_id uuid,
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea,
  authority_ciphertext_version smallint,
  authority_key_version integer,
  authority_nonce bytea,
  authority_ciphertext bytea,
  identity_ciphertext_version smallint,
  identity_key_version integer,
  identity_nonce bytea,
  identity_ciphertext bytea
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 100 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid group reconciliation claim limit';
  END IF;

  INSERT INTO app.whatsapp_group_directory_states (
    personal_account_id, whatsapp_connection_id, as_of,
    stale, partial, updated_at
  )
  SELECT
    connections.personal_account_id,
    connections.id,
    NULL,
    true,
    true,
    connections.created_at
  FROM app.whatsapp_connections AS connections
  JOIN app.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE accounts.state = 'active'
    AND connections.state = 'connected'
  ON CONFLICT ON CONSTRAINT whatsapp_group_directory_states_pkey DO NOTHING;

  RETURN QUERY
  WITH candidates AS (
    SELECT states.personal_account_id, states.whatsapp_connection_id
    FROM app.whatsapp_group_directory_states AS states
    JOIN app.whatsapp_connections AS connections
      ON connections.personal_account_id = states.personal_account_id
     AND connections.id = states.whatsapp_connection_id
    JOIN app.personal_accounts AS accounts
      ON accounts.id = connections.personal_account_id
    WHERE accounts.state = 'active'
      AND connections.state = 'connected'
      AND (
        states.reconciliation_lease_expires_at IS NULL
        OR states.reconciliation_lease_expires_at <= requested_at
      )
      AND (
        (states.as_of IS NULL AND states.updated_at < requested_at)
        OR states.as_of <= requested_at - interval '55 minutes'
      )
    ORDER BY states.as_of NULLS FIRST, states.whatsapp_connection_id
    FOR UPDATE OF states SKIP LOCKED
    LIMIT requested_limit
  ), claimed AS (
    UPDATE app.whatsapp_group_directory_states AS states
    SET
      reconciliation_claim_id = gen_random_uuid(),
      reconciliation_lease_expires_at = requested_at + interval '10 minutes',
      updated_at = requested_at
    FROM candidates
    WHERE states.personal_account_id = candidates.personal_account_id
      AND states.whatsapp_connection_id = candidates.whatsapp_connection_id
    RETURNING
      states.reconciliation_claim_id,
      states.personal_account_id,
      states.whatsapp_connection_id
  )
  SELECT
    claimed.reconciliation_claim_id,
    claimed.personal_account_id,
    claimed.whatsapp_connection_id,
    account_keys.key_version,
    account_keys.kms_key_id,
    account_keys.ciphertext,
    connection_keys.account_key_version,
    connection_keys.key_version,
    connection_keys.nonce,
    connection_keys.ciphertext,
    provider_sessions.authority_ciphertext_version,
    provider_sessions.authority_key_version,
    provider_sessions.authority_nonce,
    provider_sessions.authority_ciphertext,
    identity_keys.credential_ciphertext_version,
    identity_keys.credential_key_version,
    identity_keys.credential_nonce,
    identity_keys.credential_ciphertext
  FROM claimed
  JOIN app.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = claimed.personal_account_id
   AND connection_keys.whatsapp_connection_id = claimed.whatsapp_connection_id
  JOIN app.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = claimed.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  JOIN app.whatsapp_connection_provider_sessions AS provider_sessions
    ON provider_sessions.personal_account_id = claimed.personal_account_id
   AND provider_sessions.whatsapp_connection_id = claimed.whatsapp_connection_id
   AND provider_sessions.authority_key_version = connection_keys.key_version
  JOIN app.whatsapp_connection_secrets AS identity_keys
    ON identity_keys.personal_account_id = claimed.personal_account_id
   AND identity_keys.whatsapp_connection_id = claimed.whatsapp_connection_id
   AND identity_keys.credential_key_version = connection_keys.key_version
  WHERE account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL;
END
$function$;

REVOKE ALL
  ON FUNCTION app_private.claim_whatsapp_group_reconciliation(timestamptz, integer)
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION app_private.claim_whatsapp_group_reconciliation(timestamptz, integer)
  TO whatsapp_api_runtime;
