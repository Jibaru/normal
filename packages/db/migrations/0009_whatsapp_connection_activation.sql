ALTER TABLE app.whatsapp_connections
  ALTER COLUMN display_name_ciphertext DROP NOT NULL,
  ADD COLUMN connection_setup_id text UNIQUE
    REFERENCES app.connection_setups (id) ON DELETE RESTRICT,
  ADD COLUMN number_suffix text
    CHECK (number_suffix IS NULL OR number_suffix ~ '^[0-9]{4}$'),
  ADD COLUMN state text NOT NULL DEFAULT 'degraded'
    CHECK (
      state IN (
        'connected',
        'connecting',
        'disconnected',
        'reconnect_required',
        'degraded',
        'deleting'
      )
    ),
  ADD COLUMN state_changed_at timestamptz NOT NULL
    DEFAULT transaction_timestamp();

ALTER TABLE app.connection_setups
  DROP CONSTRAINT connection_setups_state_check,
  ADD CONSTRAINT connection_setups_state_check
    CHECK (
      state IN (
        'provisioning_pending',
        'provisioned',
        'provisioning_failed',
        'provisioning_quarantined',
        'activated'
      )
    );

ALTER TABLE app.whatsapp_connection_secrets
  ADD COLUMN credential_ciphertext_version smallint
    CHECK (
      credential_ciphertext_version IS NULL
      OR credential_ciphertext_version > 0
    ),
  ADD COLUMN credential_key_version integer
    CHECK (credential_key_version IS NULL OR credential_key_version > 0),
  ADD COLUMN credential_nonce bytea
    CHECK (credential_nonce IS NULL OR octet_length(credential_nonce) = 12),
  ADD CONSTRAINT whatsapp_connection_secret_envelope_complete
    CHECK (
      (
        credential_ciphertext_version IS NULL
        AND credential_key_version IS NULL
        AND credential_nonce IS NULL
      )
      OR (
        credential_ciphertext_version IS NOT NULL
        AND credential_key_version IS NOT NULL
        AND credential_nonce IS NOT NULL
        AND octet_length(credential_ciphertext) > 16
      )
    ) NOT VALID;

CREATE TABLE app.whatsapp_connection_provider_sessions (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  locator_ciphertext_version smallint NOT NULL
    CHECK (locator_ciphertext_version > 0),
  locator_key_version integer NOT NULL
    CHECK (locator_key_version > 0),
  locator_nonce bytea NOT NULL
    CHECK (octet_length(locator_nonce) = 12),
  locator_ciphertext bytea NOT NULL
    CHECK (octet_length(locator_ciphertext) > 16),
  authority_ciphertext_version smallint NOT NULL
    CHECK (authority_ciphertext_version > 0),
  authority_key_version integer NOT NULL
    CHECK (authority_key_version > 0),
  authority_nonce bytea NOT NULL
    CHECK (octet_length(authority_nonce) = 12),
  authority_ciphertext bytea NOT NULL
    CHECK (octet_length(authority_ciphertext) > 16),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (personal_account_id, whatsapp_connection_id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE
);

ALTER TABLE app.whatsapp_connection_provider_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_connection_provider_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_connection_provider_sessions_tenant
ON app.whatsapp_connection_provider_sessions
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid
);

GRANT SELECT
  ON app.whatsapp_connection_provider_sessions
  TO whatsapp_api_runtime;

CREATE OR REPLACE FUNCTION app_private.start_connection_setup(
  requested_personal_account_id uuid,
  requested_setup_id text,
  requested_idempotency_key text,
  requested_number_token bytea,
  requested_number_ciphertext_version smallint,
  requested_number_key_version integer,
  requested_number_nonce bytea,
  requested_number_ciphertext bytea,
  requested_account_key_version integer,
  requested_connection_key_version integer,
  requested_connection_key_nonce bytea,
  requested_connection_key_ciphertext bytea,
  requested_created_at timestamptz
)
RETURNS TABLE (
  outcome text,
  setup_id text,
  setup_state text,
  setup_created_at timestamptz,
  setup_expires_at timestamptz
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  connection_limit smallint;
  existing_number_token bytea;
  existing_setup_created_at timestamptz;
  existing_setup_expires_at timestamptz;
  existing_setup_id text;
  existing_setup_state text;
  retained_count bigint;
  tenant_context uuid;
  violated_constraint text;
BEGIN
  tenant_context := nullif(
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid;
  IF tenant_context IS NULL
    OR tenant_context IS DISTINCT FROM requested_personal_account_id
    OR requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$'
    OR requested_idempotency_key !~ '^[A-Za-z0-9_-]{21}$'
    OR octet_length(requested_number_token) <> 32
    OR requested_number_ciphertext_version <= 0
    OR requested_number_key_version <= 0
    OR octet_length(requested_number_nonce) <> 12
    OR octet_length(requested_number_ciphertext) <= 16
    OR requested_account_key_version <= 0
    OR requested_connection_key_version <= 0
    OR octet_length(requested_connection_key_nonce) <> 12
    OR octet_length(requested_connection_key_ciphertext) <= 16
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup request';
  END IF;

  SELECT accounts.whatsapp_connection_limit
  INTO connection_limit
  FROM app.personal_accounts AS accounts
  JOIN app.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = accounts.id
  WHERE accounts.id = requested_personal_account_id
    AND accounts.state = 'active'
    AND account_keys.key_version = requested_account_key_version
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
  FOR UPDATE OF accounts;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT
    setups.id,
    setups.state,
    setups.created_at,
    setups.expires_at,
    reservations.number_token
  INTO
    existing_setup_id,
    existing_setup_state,
    existing_setup_created_at,
    existing_setup_expires_at,
    existing_number_token
  FROM app.connection_setups AS setups
  JOIN app.whatsapp_number_reservations AS reservations
    ON reservations.personal_account_id = setups.personal_account_id
   AND reservations.connection_setup_id = setups.id
  WHERE setups.personal_account_id = requested_personal_account_id
    AND setups.idempotency_key = requested_idempotency_key;

  IF FOUND THEN
    IF existing_number_token = requested_number_token THEN
      RETURN QUERY SELECT
        'replay'::text,
        existing_setup_id,
        existing_setup_state,
        existing_setup_created_at,
        existing_setup_expires_at;
    ELSE
      RETURN QUERY SELECT
        'idempotency_conflict'::text,
        NULL::text,
        NULL::text,
        NULL::timestamptz,
        NULL::timestamptz;
    END IF;
    RETURN;
  END IF;

  SELECT
    (
      SELECT count(*)
      FROM app.whatsapp_connections AS connections
      WHERE connections.personal_account_id = requested_personal_account_id
    ) + (
      SELECT count(*)
      FROM app.connection_setups AS setups
      WHERE setups.personal_account_id = requested_personal_account_id
        AND setups.state <> 'activated'
    )
  INTO retained_count;

  IF retained_count >= connection_limit THEN
    RETURN QUERY SELECT
      'connection_limit_reached'::text,
      NULL::text,
      NULL::text,
      NULL::timestamptz,
      NULL::timestamptz;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO app.connection_setups (
      id,
      personal_account_id,
      idempotency_key,
      state,
      number_ciphertext_version,
      number_key_version,
      number_nonce,
      number_ciphertext,
      created_at,
      expires_at,
      updated_at
    )
    VALUES (
      requested_setup_id,
      requested_personal_account_id,
      requested_idempotency_key,
      'provisioning_pending',
      requested_number_ciphertext_version,
      requested_number_key_version,
      requested_number_nonce,
      requested_number_ciphertext,
      requested_created_at,
      requested_created_at + interval '15 minutes',
      requested_created_at
    );

    INSERT INTO app.connection_setup_key_envelopes (
      personal_account_id,
      connection_setup_id,
      account_key_version,
      key_version,
      nonce,
      ciphertext,
      created_at
    )
    VALUES (
      requested_personal_account_id,
      requested_setup_id,
      requested_account_key_version,
      requested_connection_key_version,
      requested_connection_key_nonce,
      requested_connection_key_ciphertext,
      requested_created_at
    );

    INSERT INTO app.whatsapp_number_reservations (
      number_token,
      personal_account_id,
      connection_setup_id,
      created_at
    )
    VALUES (
      requested_number_token,
      requested_personal_account_id,
      requested_setup_id,
      requested_created_at
    );
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
      IF violated_constraint = 'whatsapp_number_reservations_pkey' THEN
        RETURN QUERY SELECT
          'number_unavailable'::text,
          NULL::text,
          NULL::text,
          NULL::timestamptz,
          NULL::timestamptz;
        RETURN;
      END IF;
      RAISE;
  END;

  RETURN QUERY SELECT
    'created'::text,
    requested_setup_id,
    'provisioning_pending'::text,
    requested_created_at,
    requested_created_at + interval '15 minutes';
END
$function$;

CREATE FUNCTION app_private.load_connection_setup_for_activation(
  verified_clerk_user_id text,
  requested_setup_id text
)
RETURNS TABLE (
  outcome text,
  personal_account_id uuid,
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  setup_key_account_version integer,
  setup_key_version integer,
  setup_key_nonce bytea,
  setup_key_ciphertext bytea,
  number_ciphertext_version smallint,
  number_key_version integer,
  number_nonce bytea,
  number_ciphertext bytea,
  connection_public_id text,
  connection_display_name text,
  connection_number_suffix text,
  connection_state text,
  connection_state_changed_at timestamptz
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    CASE setups.state
      WHEN 'provisioning_pending' THEN 'pending'
      ELSE setups.state
    END,
    setups.personal_account_id,
    account_keys.key_version,
    account_keys.kms_key_id,
    account_keys.ciphertext,
    setup_keys.account_key_version,
    setup_keys.key_version,
    setup_keys.nonce,
    setup_keys.ciphertext,
    setups.number_ciphertext_version,
    setups.number_key_version,
    setups.number_nonce,
    setups.number_ciphertext,
    connections.public_id,
    NULL::text,
    connections.number_suffix,
    connections.state,
    connections.state_changed_at
  FROM app_private.clerk_identities AS identities
  JOIN app.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  JOIN app.connection_setups AS setups
    ON setups.personal_account_id = accounts.id
   AND setups.id = requested_setup_id
  JOIN app.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = accounts.id
   AND account_keys.unavailable_at IS NULL
   AND account_keys.ciphertext IS NOT NULL
  JOIN app.connection_setup_key_envelopes AS setup_keys
    ON setup_keys.personal_account_id = setups.personal_account_id
   AND setup_keys.connection_setup_id = setups.id
  LEFT JOIN app.connection_setup_provider_sessions AS provider_sessions
    ON provider_sessions.personal_account_id = setups.personal_account_id
   AND provider_sessions.connection_setup_id = setups.id
   AND provider_sessions.ordinal = 0
  LEFT JOIN app.whatsapp_connections AS connections
    ON connections.personal_account_id = setups.personal_account_id
   AND connections.connection_setup_id = setups.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
    AND setups.state IN (
      'provisioning_pending',
      'provisioned',
      'provisioning_failed',
      'provisioning_quarantined',
      'activated'
    )
    AND (
      (setups.state <> 'activated' AND connections.id IS NULL)
      OR (setups.state = 'activated' AND connections.id IS NOT NULL)
    )
    AND (
      setups.state <> 'provisioned'
      OR provider_sessions.ordinal = 0
    )
$function$;

CREATE FUNCTION app_private.load_whatsapp_connection_account(
  verified_clerk_user_id text
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT identities.personal_account_id
  FROM app_private.clerk_identities AS identities
  JOIN app.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
$function$;

CREATE FUNCTION app_private.activate_connection_setup(
  requested_personal_account_id uuid,
  requested_setup_id text,
  requested_connection_id uuid,
  requested_public_id text,
  requested_webhook_ingress_id uuid,
  requested_number_suffix text,
  requested_connected_at timestamptz,
  requested_account_key_version integer,
  requested_connection_key_version integer,
  requested_connection_key_nonce bytea,
  requested_connection_key_ciphertext bytea,
  requested_locator_ciphertext_version smallint,
  requested_locator_key_version integer,
  requested_locator_nonce bytea,
  requested_locator_ciphertext bytea,
  requested_authority_ciphertext_version smallint,
  requested_authority_key_version integer,
  requested_authority_nonce bytea,
  requested_authority_ciphertext bytea,
  requested_webhook_secret_ciphertext_version smallint,
  requested_webhook_secret_key_version integer,
  requested_webhook_secret_nonce bytea,
  requested_webhook_secret_ciphertext bytea
)
RETURNS TABLE (
  public_id text,
  display_name text,
  number_suffix text,
  state text,
  state_changed_at timestamptz
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  setup app.connection_setups%ROWTYPE;
  tenant_context uuid;
BEGIN
  tenant_context := nullif(
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid;
  IF tenant_context IS NULL
    OR tenant_context IS DISTINCT FROM requested_personal_account_id
    OR requested_public_id !~ '^con_[A-Za-z0-9_-]{21}$'
    OR requested_number_suffix !~ '^[0-9]{4}$'
    OR requested_account_key_version <= 0
    OR requested_connection_key_version <= 0
    OR octet_length(requested_connection_key_nonce) <> 12
    OR octet_length(requested_connection_key_ciphertext) <= 16
    OR requested_locator_ciphertext_version <= 0
    OR requested_locator_key_version <= 0
    OR octet_length(requested_locator_nonce) <> 12
    OR octet_length(requested_locator_ciphertext) <= 16
    OR requested_authority_ciphertext_version <= 0
    OR requested_authority_key_version <= 0
    OR octet_length(requested_authority_nonce) <> 12
    OR octet_length(requested_authority_ciphertext) <= 16
    OR requested_webhook_secret_ciphertext_version <= 0
    OR requested_webhook_secret_key_version <= 0
    OR octet_length(requested_webhook_secret_nonce) <> 12
    OR octet_length(requested_webhook_secret_ciphertext) <= 16
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid WhatsApp Connection activation';
  END IF;

  SELECT *
  INTO setup
  FROM app.connection_setups
  WHERE id = requested_setup_id
    AND personal_account_id = requested_personal_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF setup.state = 'activated' THEN
    RETURN QUERY
    SELECT
      connections.public_id,
      NULL::text,
      connections.number_suffix,
      connections.state,
      connections.state_changed_at
    FROM app.whatsapp_connections AS connections
    WHERE connections.personal_account_id = requested_personal_account_id
      AND connections.connection_setup_id = requested_setup_id;
    RETURN;
  END IF;

  IF setup.state <> 'provisioned'
    OR NOT EXISTS (
      SELECT 1
      FROM app.connection_setup_provider_sessions AS provider_sessions
      WHERE provider_sessions.personal_account_id =
        requested_personal_account_id
        AND provider_sessions.connection_setup_id = requested_setup_id
        AND provider_sessions.ordinal = 0
    )
  THEN
    RAISE data_exception
      USING MESSAGE = 'Connection Setup is not activatable';
  END IF;

  INSERT INTO app.whatsapp_connections (
    id,
    personal_account_id,
    webhook_ingress_id,
    display_name_ciphertext,
    created_at,
    updated_at,
    public_id,
    connection_setup_id,
    number_suffix,
    state,
    state_changed_at
  )
  VALUES (
    requested_connection_id,
    requested_personal_account_id,
    requested_webhook_ingress_id,
    NULL,
    requested_connected_at,
    requested_connected_at,
    requested_public_id,
    requested_setup_id,
    requested_number_suffix,
    'connected',
    requested_connected_at
  );

  INSERT INTO app.whatsapp_connection_key_envelopes (
    personal_account_id,
    whatsapp_connection_id,
    account_key_version,
    key_version,
    nonce,
    ciphertext,
    created_at
  )
  VALUES (
    requested_personal_account_id,
    requested_connection_id,
    requested_account_key_version,
    requested_connection_key_version,
    requested_connection_key_nonce,
    requested_connection_key_ciphertext,
    requested_connected_at
  );

  INSERT INTO app.whatsapp_connection_provider_sessions (
    personal_account_id,
    whatsapp_connection_id,
    locator_ciphertext_version,
    locator_key_version,
    locator_nonce,
    locator_ciphertext,
    authority_ciphertext_version,
    authority_key_version,
    authority_nonce,
    authority_ciphertext,
    created_at,
    updated_at
  )
  VALUES (
    requested_personal_account_id,
    requested_connection_id,
    requested_locator_ciphertext_version,
    requested_locator_key_version,
    requested_locator_nonce,
    requested_locator_ciphertext,
    requested_authority_ciphertext_version,
    requested_authority_key_version,
    requested_authority_nonce,
    requested_authority_ciphertext,
    requested_connected_at,
    requested_connected_at
  );

  INSERT INTO app.whatsapp_connection_secrets (
    personal_account_id,
    whatsapp_connection_id,
    credential_ciphertext,
    credential_ciphertext_version,
    credential_key_version,
    credential_nonce,
    created_at,
    updated_at
  )
  VALUES (
    requested_personal_account_id,
    requested_connection_id,
    requested_webhook_secret_ciphertext,
    requested_webhook_secret_ciphertext_version,
    requested_webhook_secret_key_version,
    requested_webhook_secret_nonce,
    requested_connected_at,
    requested_connected_at
  );

  UPDATE app.connection_setups
  SET
    state = 'activated',
    updated_at = greatest(updated_at, requested_connected_at)
  WHERE id = requested_setup_id
    AND personal_account_id = requested_personal_account_id;

  RETURN QUERY SELECT
    requested_public_id,
    NULL::text,
    requested_number_suffix,
    'connected'::text,
    requested_connected_at;
END
$function$;

REVOKE ALL
  ON FUNCTION app_private.load_connection_setup_for_activation(text, text)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.load_whatsapp_connection_account(text)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.activate_connection_setup(
    uuid,
    text,
    uuid,
    text,
    uuid,
    text,
    timestamptz,
    integer,
    integer,
    bytea,
    bytea,
    smallint,
    integer,
    bytea,
    bytea,
    smallint,
    integer,
    bytea,
    bytea,
    smallint,
    integer,
    bytea,
    bytea
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.load_connection_setup_for_activation(text, text)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.load_whatsapp_connection_account(text)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.activate_connection_setup(
    uuid,
    text,
    uuid,
    text,
    uuid,
    text,
    timestamptz,
    integer,
    integer,
    bytea,
    bytea,
    smallint,
    integer,
    bytea,
    bytea,
    smallint,
    integer,
    bytea,
    bytea,
    smallint,
    integer,
    bytea,
    bytea
  )
  TO whatsapp_api_runtime;
