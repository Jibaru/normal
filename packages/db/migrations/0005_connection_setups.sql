CREATE TABLE app.connection_setups (
  id text PRIMARY KEY
    CHECK (id ~ '^cst_[A-Za-z0-9_-]{21}$'),
  personal_account_id uuid NOT NULL
    REFERENCES app.personal_accounts (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{21}$'),
  state text NOT NULL
    CHECK (state IN ('provisioning_pending')),
  number_ciphertext_version smallint NOT NULL
    CHECK (number_ciphertext_version > 0),
  number_key_version integer NOT NULL
    CHECK (number_key_version > 0),
  number_nonce bytea NOT NULL
    CHECK (octet_length(number_nonce) = 12),
  number_ciphertext bytea NOT NULL
    CHECK (octet_length(number_ciphertext) > 16),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (personal_account_id, id),
  UNIQUE (personal_account_id, idempotency_key),
  CHECK (expires_at = created_at + interval '15 minutes'),
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.connection_setup_key_envelopes (
  personal_account_id uuid NOT NULL,
  connection_setup_id text NOT NULL,
  account_key_version integer NOT NULL
    CHECK (account_key_version > 0),
  key_version integer NOT NULL
    CHECK (key_version > 0),
  nonce bytea NOT NULL
    CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL
    CHECK (octet_length(ciphertext) > 16),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (personal_account_id, connection_setup_id),
  FOREIGN KEY (personal_account_id, connection_setup_id)
    REFERENCES app.connection_setups (personal_account_id, id)
    ON DELETE CASCADE
);

CREATE TABLE app.whatsapp_number_reservations (
  number_token bytea PRIMARY KEY
    CONSTRAINT whatsapp_number_reservation_token_length
    CHECK (octet_length(number_token) = 32),
  personal_account_id uuid NOT NULL,
  connection_setup_id text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (personal_account_id, connection_setup_id),
  FOREIGN KEY (personal_account_id, connection_setup_id)
    REFERENCES app.connection_setups (personal_account_id, id)
    ON DELETE RESTRICT
);

ALTER TABLE app.connection_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_setups FORCE ROW LEVEL SECURITY;
ALTER TABLE app.connection_setup_key_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_setup_key_envelopes FORCE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_number_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_number_reservations FORCE ROW LEVEL SECURITY;

CREATE POLICY connection_setups_tenant
ON app.connection_setups
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

CREATE POLICY connection_setup_key_envelopes_tenant
ON app.connection_setup_key_envelopes
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

CREATE POLICY whatsapp_number_reservations_tenant
ON app.whatsapp_number_reservations
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
  ON app.connection_setups, app.whatsapp_number_reservations
  TO whatsapp_api_runtime;

CREATE FUNCTION app_private.load_connection_setup_account(
  verified_clerk_user_id text
)
RETURNS TABLE (
  personal_account_id uuid,
  whatsapp_connection_limit smallint,
  account_key_version integer,
  kms_key_id text,
  account_key_ciphertext bytea
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    accounts.id,
    accounts.whatsapp_connection_limit,
    envelopes.key_version,
    envelopes.kms_key_id,
    envelopes.ciphertext
  FROM app_private.clerk_identities AS identities
  JOIN app.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  JOIN app.personal_account_key_envelopes AS envelopes
    ON envelopes.personal_account_id = accounts.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
    AND envelopes.unavailable_at IS NULL
    AND envelopes.ciphertext IS NOT NULL
$function$;

CREATE FUNCTION app_private.start_connection_setup(
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

REVOKE ALL
  ON FUNCTION app_private.load_connection_setup_account(text)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.start_connection_setup(
    uuid,
    text,
    text,
    bytea,
    smallint,
    integer,
    bytea,
    bytea,
    integer,
    integer,
    bytea,
    bytea,
    timestamptz
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.load_connection_setup_account(text)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.start_connection_setup(
    uuid,
    text,
    text,
    bytea,
    smallint,
    integer,
    bytea,
    bytea,
    integer,
    integer,
    bytea,
    bytea,
    timestamptz
  )
  TO whatsapp_api_runtime;
