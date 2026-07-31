ALTER TABLE app.connection_setups
  DROP CONSTRAINT connection_setups_state_check;

ALTER TABLE app.connection_setups
  ADD CONSTRAINT connection_setups_state_check
    CHECK (
      state IN (
        'provisioning_pending',
        'provisioned',
        'provisioning_failed',
        'provisioning_quarantined'
      )
    ),
  ADD COLUMN provisioning_lease_owner text
    CHECK (
      provisioning_lease_owner IS NULL
      OR provisioning_lease_owner ~ '^cspw_[A-Za-z0-9_-]{43}$'
    ),
  ADD COLUMN provisioning_lease_expires_at timestamptz,
  ADD COLUMN provisioning_attempt_count integer NOT NULL DEFAULT 0
    CHECK (provisioning_attempt_count >= 0),
  ADD COLUMN provisioning_last_failure_code text
    CHECK (
      provisioning_last_failure_code IS NULL
      OR provisioning_last_failure_code ~ '^[a-z][a-z0-9_]{0,63}$'
    ),
  ADD CONSTRAINT connection_setup_provisioning_lease_complete
    CHECK (
      (provisioning_lease_owner IS NULL)
      = (provisioning_lease_expires_at IS NULL)
    ),
  ADD CONSTRAINT connection_setup_terminal_has_no_lease
    CHECK (
      state = 'provisioning_pending'
      OR (
        provisioning_lease_owner IS NULL
        AND provisioning_lease_expires_at IS NULL
      )
    );

CREATE INDEX connection_setups_provisioning_candidates
ON app.connection_setups (created_at, id)
WHERE state = 'provisioning_pending';

CREATE TABLE app.connection_setup_provider_sessions (
  personal_account_id uuid NOT NULL,
  connection_setup_id text NOT NULL,
  ordinal smallint NOT NULL
    CHECK (ordinal >= 0),
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
  PRIMARY KEY (personal_account_id, connection_setup_id, ordinal),
  FOREIGN KEY (personal_account_id, connection_setup_id)
    REFERENCES app.connection_setups (personal_account_id, id)
    ON DELETE CASCADE
);

ALTER TABLE app.connection_setup_provider_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_setup_provider_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY connection_setup_provider_sessions_tenant
ON app.connection_setup_provider_sessions
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

CREATE FUNCTION app_private.claim_connection_setup_provisioning(
  requested_setup_id text,
  requested_worker_id text,
  requested_claimed_at timestamptz
)
RETURNS TABLE (
  outcome text,
  personal_account_id uuid,
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea,
  number_ciphertext_version smallint,
  number_key_version integer,
  number_nonce bytea,
  number_ciphertext bytea
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  account_key app.personal_account_key_envelopes%ROWTYPE;
  connection_key app.connection_setup_key_envelopes%ROWTYPE;
  setup app.connection_setups%ROWTYPE;
BEGIN
  IF requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$'
    OR requested_worker_id !~ '^cspw_[A-Za-z0-9_-]{43}$'
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup provisioning claim';
  END IF;

  SELECT *
  INTO setup
  FROM app.connection_setups
  WHERE id = requested_setup_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_found'::text,
      NULL::uuid,
      NULL::integer,
      NULL::text,
      NULL::bytea,
      NULL::integer,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::smallint,
      NULL::integer,
      NULL::bytea,
      NULL::bytea;
    RETURN;
  END IF;

  IF setup.state <> 'provisioning_pending' THEN
    RETURN QUERY SELECT
      'not_pending'::text,
      NULL::uuid,
      NULL::integer,
      NULL::text,
      NULL::bytea,
      NULL::integer,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::smallint,
      NULL::integer,
      NULL::bytea,
      NULL::bytea;
    RETURN;
  END IF;

  IF setup.expires_at <= requested_claimed_at THEN
    RETURN QUERY SELECT
      'expired'::text,
      NULL::uuid,
      NULL::integer,
      NULL::text,
      NULL::bytea,
      NULL::integer,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::smallint,
      NULL::integer,
      NULL::bytea,
      NULL::bytea;
    RETURN;
  END IF;

  IF setup.provisioning_lease_expires_at > requested_claimed_at THEN
    RETURN QUERY SELECT
      'leased'::text,
      NULL::uuid,
      NULL::integer,
      NULL::text,
      NULL::bytea,
      NULL::integer,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::smallint,
      NULL::integer,
      NULL::bytea,
      NULL::bytea;
    RETURN;
  END IF;

  SELECT *
  INTO connection_key
  FROM app.connection_setup_key_envelopes AS connection_keys
  WHERE connection_keys.personal_account_id = setup.personal_account_id
    AND connection_keys.connection_setup_id = setup.id;

  SELECT *
  INTO account_key
  FROM app.personal_account_key_envelopes AS account_keys
  WHERE account_keys.personal_account_id = setup.personal_account_id
    AND account_keys.key_version = connection_key.account_key_version
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL;

  IF connection_key.personal_account_id IS NULL
    OR account_key.personal_account_id IS NULL
  THEN
    RAISE data_exception
      USING MESSAGE = 'Connection Setup provisioning key unavailable';
  END IF;

  UPDATE app.connection_setups
  SET
    provisioning_attempt_count = provisioning_attempt_count + 1,
    provisioning_last_failure_code = NULL,
    provisioning_lease_expires_at = requested_claimed_at + interval '2 minutes',
    provisioning_lease_owner = requested_worker_id,
    updated_at = greatest(updated_at, requested_claimed_at)
  WHERE id = setup.id;

  RETURN QUERY SELECT
    'claimed'::text,
    setup.personal_account_id,
    account_key.key_version,
    account_key.kms_key_id,
    account_key.ciphertext,
    connection_key.account_key_version,
    connection_key.key_version,
    connection_key.nonce,
    connection_key.ciphertext,
    setup.number_ciphertext_version,
    setup.number_key_version,
    setup.number_nonce,
    setup.number_ciphertext;
END
$function$;

CREATE FUNCTION app_private.renew_connection_setup_provisioning_lease(
  requested_setup_id text,
  requested_worker_id text,
  requested_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH renewed AS (
    UPDATE app.connection_setups
    SET
      provisioning_lease_expires_at =
        requested_observed_at + interval '2 minutes',
      updated_at = greatest(updated_at, requested_observed_at)
    WHERE id = requested_setup_id
      AND state = 'provisioning_pending'
      AND expires_at > requested_observed_at
      AND provisioning_lease_owner = requested_worker_id
      AND provisioning_lease_expires_at > requested_observed_at
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM renewed)
$function$;

CREATE FUNCTION app_private.release_connection_setup_provisioning_lease(
  requested_setup_id text,
  requested_worker_id text,
  requested_observed_at timestamptz,
  requested_failure_code text
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  released boolean;
BEGIN
  IF requested_failure_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup provisioning failure';
  END IF;

  WITH changed AS (
    UPDATE app.connection_setups
    SET
      provisioning_last_failure_code = requested_failure_code,
      provisioning_lease_expires_at = NULL,
      provisioning_lease_owner = NULL,
      updated_at = greatest(updated_at, requested_observed_at)
    WHERE id = requested_setup_id
      AND state = 'provisioning_pending'
      AND provisioning_lease_owner = requested_worker_id
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM changed) INTO released;
  RETURN released;
END
$function$;

CREATE FUNCTION app_private.fail_connection_setup_provisioning(
  requested_setup_id text,
  requested_worker_id text,
  requested_observed_at timestamptz,
  requested_failure_code text
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  failed boolean;
BEGIN
  IF requested_failure_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup provisioning failure';
  END IF;

  WITH changed AS (
    UPDATE app.connection_setups
    SET
      state = 'provisioning_failed',
      provisioning_last_failure_code = requested_failure_code,
      provisioning_lease_expires_at = NULL,
      provisioning_lease_owner = NULL,
      updated_at = greatest(updated_at, requested_observed_at)
    WHERE id = requested_setup_id
      AND state = 'provisioning_pending'
      AND provisioning_lease_owner = requested_worker_id
      AND provisioning_lease_expires_at > requested_observed_at
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM changed) INTO failed;
  RETURN failed;
END
$function$;

CREATE FUNCTION app_private.finish_connection_setup_provisioning(
  requested_setup_id text,
  requested_worker_id text,
  requested_observed_at timestamptz,
  requested_outcome text,
  requested_sessions jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  expected_count integer;
  session jsonb;
  session_index integer;
  setup app.connection_setups%ROWTYPE;
BEGIN
  IF requested_outcome NOT IN ('provisioned', 'quarantined')
    OR jsonb_typeof(requested_sessions) <> 'array'
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup provisioning result';
  END IF;

  expected_count := jsonb_array_length(requested_sessions);
  IF (requested_outcome = 'provisioned' AND expected_count <> 1)
    OR (requested_outcome = 'quarantined' AND expected_count < 2)
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup provider session count';
  END IF;

  SELECT *
  INTO setup
  FROM app.connection_setups
  WHERE id = requested_setup_id
  FOR UPDATE;

  IF NOT FOUND
    OR setup.state <> 'provisioning_pending'
    OR setup.provisioning_lease_owner IS DISTINCT FROM requested_worker_id
    OR setup.provisioning_lease_expires_at <= requested_observed_at
  THEN
    RETURN false;
  END IF;

  FOR session_index IN 0..expected_count - 1 LOOP
    session := requested_sessions -> session_index;
    IF jsonb_typeof(session) <> 'object'
      OR (session ->> 'ordinal')::integer <> session_index
      OR (session ->> 'locatorCiphertextVersion')::integer <= 0
      OR (session ->> 'locatorKeyVersion')::integer <= 0
      OR octet_length(decode(session ->> 'locatorNonce', 'base64')) <> 12
      OR octet_length(decode(session ->> 'locatorCiphertext', 'base64')) <= 16
      OR (session ->> 'authorityCiphertextVersion')::integer <= 0
      OR (session ->> 'authorityKeyVersion')::integer <= 0
      OR octet_length(decode(session ->> 'authorityNonce', 'base64')) <> 12
      OR octet_length(decode(session ->> 'authorityCiphertext', 'base64')) <= 16
    THEN
      RAISE invalid_parameter_value
        USING MESSAGE = 'invalid encrypted provider session';
    END IF;

    INSERT INTO app.connection_setup_provider_sessions (
      personal_account_id,
      connection_setup_id,
      ordinal,
      locator_ciphertext_version,
      locator_key_version,
      locator_nonce,
      locator_ciphertext,
      authority_ciphertext_version,
      authority_key_version,
      authority_nonce,
      authority_ciphertext,
      created_at
    )
    VALUES (
      setup.personal_account_id,
      setup.id,
      session_index,
      (session ->> 'locatorCiphertextVersion')::smallint,
      (session ->> 'locatorKeyVersion')::integer,
      decode(session ->> 'locatorNonce', 'base64'),
      decode(session ->> 'locatorCiphertext', 'base64'),
      (session ->> 'authorityCiphertextVersion')::smallint,
      (session ->> 'authorityKeyVersion')::integer,
      decode(session ->> 'authorityNonce', 'base64'),
      decode(session ->> 'authorityCiphertext', 'base64'),
      requested_observed_at
    );
  END LOOP;

  UPDATE app.connection_setups
  SET
    state = CASE requested_outcome
      WHEN 'provisioned' THEN 'provisioned'
      ELSE 'provisioning_quarantined'
    END,
    provisioning_last_failure_code = NULL,
    provisioning_lease_expires_at = NULL,
    provisioning_lease_owner = NULL,
    updated_at = greatest(updated_at, requested_observed_at)
  WHERE id = setup.id;

  RETURN true;
END
$function$;

CREATE FUNCTION app_private.list_connection_setup_provisioning_candidates(
  requested_observed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (setup_id text)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup provisioning candidate limit';
  END IF;

  RETURN QUERY
  SELECT setups.id
  FROM app.connection_setups AS setups
  WHERE setups.state = 'provisioning_pending'
    AND setups.expires_at > requested_observed_at
    AND (
      setups.provisioning_lease_expires_at IS NULL
      OR setups.provisioning_lease_expires_at <= requested_observed_at
    )
  ORDER BY setups.created_at, setups.id
  LIMIT requested_limit;
END
$function$;

REVOKE ALL
  ON TABLE app.connection_setup_provider_sessions
  FROM PUBLIC, whatsapp_api_runtime, whatsapp_webhook_runtime;

GRANT SELECT
  ON app.connection_setup_provider_sessions
  TO whatsapp_api_runtime;

REVOKE ALL
  ON FUNCTION app_private.claim_connection_setup_provisioning(
    text,
    text,
    timestamptz
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.renew_connection_setup_provisioning_lease(
    text,
    text,
    timestamptz
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.release_connection_setup_provisioning_lease(
    text,
    text,
    timestamptz,
    text
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.fail_connection_setup_provisioning(
    text,
    text,
    timestamptz,
    text
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.finish_connection_setup_provisioning(
    text,
    text,
    timestamptz,
    text,
    jsonb
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.list_connection_setup_provisioning_candidates(
    timestamptz,
    integer
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.claim_connection_setup_provisioning(
    text,
    text,
    timestamptz
  )
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.renew_connection_setup_provisioning_lease(
    text,
    text,
    timestamptz
  )
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.release_connection_setup_provisioning_lease(
    text,
    text,
    timestamptz,
    text
  )
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.fail_connection_setup_provisioning(
    text,
    text,
    timestamptz,
    text
  )
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.finish_connection_setup_provisioning(
    text,
    text,
    timestamptz,
    text,
    jsonb
  )
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.list_connection_setup_provisioning_candidates(
    timestamptz,
    integer
  )
  TO whatsapp_api_runtime;
