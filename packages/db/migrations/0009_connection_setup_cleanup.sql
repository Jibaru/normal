ALTER TABLE app.connection_setups
  DROP CONSTRAINT connection_setups_state_check,
  DROP CONSTRAINT connection_setup_terminal_has_no_lease;

ALTER TABLE app.connection_setups
  ADD CONSTRAINT connection_setups_state_check
    CHECK (
      state IN (
        'provisioning_pending',
        'provisioned',
        'provisioning_failed',
        'provisioning_quarantined',
        'cancelled',
        'expired'
      )
    ),
  ADD COLUMN cleanup_state text
    CHECK (cleanup_state IS NULL OR cleanup_state IN ('pending', 'complete')),
  ADD COLUMN cleanup_lease_owner text
    CHECK (
      cleanup_lease_owner IS NULL
      OR cleanup_lease_owner ~ '^cscw_[A-Za-z0-9_-]{43}$'
    ),
  ADD COLUMN cleanup_lease_expires_at timestamptz,
  ADD COLUMN cleanup_attempt_count integer NOT NULL DEFAULT 0
    CHECK (cleanup_attempt_count >= 0),
  ADD COLUMN cleanup_last_failure_code text
    CHECK (
      cleanup_last_failure_code IS NULL
      OR cleanup_last_failure_code ~ '^[a-z][a-z0-9_]{0,63}$'
    ),
  ADD CONSTRAINT connection_setup_cleanup_state_matches_terminal
    CHECK (
      (state IN ('cancelled', 'expired')) = (cleanup_state IS NOT NULL)
    ),
  ADD CONSTRAINT connection_setup_cleanup_lease_complete
    CHECK (
      (cleanup_lease_owner IS NULL) = (cleanup_lease_expires_at IS NULL)
    ),
  ADD CONSTRAINT connection_setup_cleanup_complete_has_no_lease
    CHECK (
      cleanup_state <> 'complete'
      OR (
        cleanup_lease_owner IS NULL
        AND cleanup_lease_expires_at IS NULL
      )
    ),
  ADD CONSTRAINT connection_setup_non_cancellable_terminal_has_no_lease
    CHECK (
      state IN ('provisioning_pending', 'cancelled', 'expired')
      OR (
        provisioning_lease_owner IS NULL
        AND provisioning_lease_expires_at IS NULL
      )
    );

CREATE INDEX connection_setups_cleanup_candidates
ON app.connection_setups (updated_at, id)
WHERE cleanup_state = 'pending';

ALTER TABLE app.whatsapp_number_reservations
  DROP CONSTRAINT whatsapp_number_reservations_pkey,
  DROP CONSTRAINT whatsapp_number_reservations_personal_account_id_connection_key,
  ADD COLUMN released_at timestamptz,
  ADD CONSTRAINT whatsapp_number_reservations_pkey
    PRIMARY KEY (personal_account_id, connection_setup_id),
  ADD CONSTRAINT whatsapp_number_reservation_release_order
    CHECK (released_at IS NULL OR released_at >= created_at);

CREATE UNIQUE INDEX whatsapp_number_reservations_active_token
ON app.whatsapp_number_reservations (number_token)
WHERE released_at IS NULL;

CREATE FUNCTION app_private.cancel_connection_setup(
  verified_clerk_user_id text,
  requested_setup_id text,
  requested_cancelled_at timestamptz
)
RETURNS TABLE (
  outcome text,
  setup_id text,
  setup_state text,
  setup_cleanup_state text
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  setup app.connection_setups%ROWTYPE;
BEGIN
  IF requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$' THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup cancellation';
  END IF;

  SELECT setups.*
  INTO setup
  FROM app.connection_setups AS setups
  JOIN app_private.clerk_identities AS identities
    ON identities.personal_account_id = setups.personal_account_id
  JOIN app.personal_accounts AS accounts
    ON accounts.id = setups.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND setups.id = requested_setup_id
    AND accounts.state = 'active'
  FOR UPDATE OF setups;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF setup.state IN ('cancelled', 'expired') THEN
    RETURN QUERY SELECT
      'replay'::text,
      setup.id,
      setup.state,
      CASE
        WHEN setup.cleanup_state = 'complete' THEN 'complete'
        WHEN setup.cleanup_last_failure_code IS NOT NULL THEN 'retrying'
        ELSE 'pending'
      END;
    RETURN;
  END IF;

  UPDATE app.connection_setups
  SET
    state = 'cancelled',
    cleanup_state = 'pending',
    cleanup_last_failure_code = NULL,
    updated_at = greatest(updated_at, requested_cancelled_at)
  WHERE id = setup.id;

  RETURN QUERY SELECT
    'cancelled'::text,
    setup.id,
    'cancelled'::text,
    'pending'::text;
END
$function$;

CREATE FUNCTION app_private.expire_connection_setups(
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
      USING MESSAGE = 'invalid Connection Setup expiry limit';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT setups.id
    FROM app.connection_setups AS setups
    WHERE setups.state NOT IN ('cancelled', 'expired')
      AND setups.expires_at <= requested_observed_at
    ORDER BY setups.expires_at, setups.id
    LIMIT requested_limit
    FOR UPDATE SKIP LOCKED
  ),
  expired AS (
    UPDATE app.connection_setups AS setups
    SET
      state = 'expired',
      cleanup_state = 'pending',
      cleanup_last_failure_code = NULL,
      updated_at = greatest(setups.updated_at, requested_observed_at)
    FROM candidates
    WHERE setups.id = candidates.id
    RETURNING setups.id
  )
  SELECT expired.id
  FROM expired
  ORDER BY expired.id;
END
$function$;

CREATE FUNCTION app_private.claim_connection_setup_cleanup(
  requested_setup_id text,
  requested_worker_id text,
  requested_claimed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  setup app.connection_setups%ROWTYPE;
BEGIN
  IF requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$'
    OR requested_worker_id !~ '^cscw_[A-Za-z0-9_-]{43}$'
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup cleanup claim';
  END IF;

  SELECT *
  INTO setup
  FROM app.connection_setups
  WHERE id = requested_setup_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF setup.state NOT IN ('cancelled', 'expired') THEN
    RETURN 'not_terminal';
  END IF;
  IF setup.cleanup_state = 'complete' THEN
    RETURN 'complete';
  END IF;
  IF setup.provisioning_lease_expires_at > requested_claimed_at
    OR setup.cleanup_lease_expires_at > requested_claimed_at
  THEN
    RETURN 'leased';
  END IF;

  UPDATE app.connection_setups
  SET
    provisioning_lease_owner = NULL,
    provisioning_lease_expires_at = NULL,
    cleanup_attempt_count = cleanup_attempt_count + 1,
    cleanup_last_failure_code = NULL,
    cleanup_lease_owner = requested_worker_id,
    cleanup_lease_expires_at = requested_claimed_at + interval '2 minutes',
    updated_at = greatest(updated_at, requested_claimed_at)
  WHERE id = setup.id;

  RETURN 'claimed';
END
$function$;

CREATE FUNCTION app_private.renew_connection_setup_cleanup_lease(
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
      cleanup_lease_expires_at = requested_observed_at + interval '2 minutes',
      updated_at = greatest(updated_at, requested_observed_at)
    WHERE id = requested_setup_id
      AND state IN ('cancelled', 'expired')
      AND cleanup_state = 'pending'
      AND cleanup_lease_owner = requested_worker_id
      AND cleanup_lease_expires_at > requested_observed_at
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM renewed)
$function$;

CREATE FUNCTION app_private.release_connection_setup_cleanup_lease(
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
      USING MESSAGE = 'invalid Connection Setup cleanup failure';
  END IF;

  WITH changed AS (
    UPDATE app.connection_setups
    SET
      cleanup_last_failure_code = requested_failure_code,
      cleanup_lease_owner = NULL,
      cleanup_lease_expires_at = NULL,
      updated_at = greatest(updated_at, requested_observed_at)
    WHERE id = requested_setup_id
      AND state IN ('cancelled', 'expired')
      AND cleanup_state = 'pending'
      AND cleanup_lease_owner = requested_worker_id
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM changed) INTO released;
  RETURN released;
END
$function$;

CREATE FUNCTION app_private.finish_connection_setup_cleanup(
  requested_setup_id text,
  requested_worker_id text,
  requested_observed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  setup app.connection_setups%ROWTYPE;
BEGIN
  SELECT *
  INTO setup
  FROM app.connection_setups
  WHERE id = requested_setup_id
  FOR UPDATE;

  IF NOT FOUND
    OR setup.state NOT IN ('cancelled', 'expired')
    OR setup.cleanup_state <> 'pending'
    OR setup.cleanup_lease_owner IS DISTINCT FROM requested_worker_id
    OR setup.cleanup_lease_expires_at <= requested_observed_at
  THEN
    RETURN false;
  END IF;

  UPDATE app.whatsapp_number_reservations
  SET released_at = coalesce(released_at, requested_observed_at)
  WHERE personal_account_id = setup.personal_account_id
    AND connection_setup_id = setup.id;

  DELETE FROM app.connection_setup_provider_sessions
  WHERE personal_account_id = setup.personal_account_id
    AND connection_setup_id = setup.id;

  DELETE FROM app.connection_setup_key_envelopes
  WHERE personal_account_id = setup.personal_account_id
    AND connection_setup_id = setup.id;

  UPDATE app.connection_setups
  SET
    cleanup_state = 'complete',
    cleanup_last_failure_code = NULL,
    cleanup_lease_owner = NULL,
    cleanup_lease_expires_at = NULL,
    provisioning_lease_owner = NULL,
    provisioning_lease_expires_at = NULL,
    updated_at = greatest(updated_at, requested_observed_at)
  WHERE id = setup.id;

  RETURN true;
END
$function$;

CREATE FUNCTION app_private.list_connection_setup_cleanup_candidates(
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
      USING MESSAGE = 'invalid Connection Setup cleanup candidate limit';
  END IF;

  RETURN QUERY
  SELECT setups.id
  FROM app.connection_setups AS setups
  WHERE setups.state IN ('cancelled', 'expired')
    AND setups.cleanup_state = 'pending'
    AND (
      setups.provisioning_lease_expires_at IS NULL
      OR setups.provisioning_lease_expires_at <= requested_observed_at
    )
    AND (
      setups.cleanup_lease_expires_at IS NULL
      OR setups.cleanup_lease_expires_at <= requested_observed_at
    )
  ORDER BY setups.updated_at, setups.id
  LIMIT requested_limit;
END
$function$;

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
        AND NOT (
          setups.state IN ('cancelled', 'expired')
          AND setups.cleanup_state = 'complete'
        )
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
      IF violated_constraint = 'whatsapp_number_reservations_active_token' THEN
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
  ON FUNCTION app_private.cancel_connection_setup(text, text, timestamptz)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.expire_connection_setups(timestamptz, integer)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.claim_connection_setup_cleanup(text, text, timestamptz)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.renew_connection_setup_cleanup_lease(text, text, timestamptz)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.release_connection_setup_cleanup_lease(text, text, timestamptz, text)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.finish_connection_setup_cleanup(text, text, timestamptz)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.list_connection_setup_cleanup_candidates(timestamptz, integer)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.cancel_connection_setup(text, text, timestamptz)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.expire_connection_setups(timestamptz, integer)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.claim_connection_setup_cleanup(text, text, timestamptz)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.renew_connection_setup_cleanup_lease(text, text, timestamptz)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.release_connection_setup_cleanup_lease(text, text, timestamptz, text)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.finish_connection_setup_cleanup(text, text, timestamptz)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.list_connection_setup_cleanup_candidates(timestamptz, integer)
  TO whatsapp_api_runtime;
