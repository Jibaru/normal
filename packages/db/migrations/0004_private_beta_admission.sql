ALTER TABLE app.personal_accounts
ADD COLUMN message_retention_days smallint NOT NULL
  DEFAULT 30
  CHECK (message_retention_days > 0);

CREATE TABLE app_private.private_beta_waitlist (
  clerk_user_id text PRIMARY KEY
    CHECK (clerk_user_id ~ '^user_[A-Za-z0-9]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

REVOKE ALL ON app_private.private_beta_waitlist FROM PUBLIC;

REVOKE ALL
  ON FUNCTION app_private.resolve_personal_account_for_clerk(text)
  FROM PUBLIC;
DROP FUNCTION app_private.resolve_personal_account_for_clerk(text);

CREATE FUNCTION app_private.resolve_personal_account_for_clerk(
  verified_clerk_user_id text
)
RETURNS TABLE (
  admission_state text,
  personal_account_id uuid,
  key_available boolean,
  message_retention_days smallint,
  stored_media_limit_bytes bigint,
  whatsapp_connection_limit smallint
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    'active'::text,
    identities.personal_account_id,
    (
      envelopes.personal_account_id IS NOT NULL
      AND envelopes.ciphertext IS NOT NULL
      AND envelopes.unavailable_at IS NULL
    ),
    accounts.message_retention_days,
    accounts.stored_media_limit_bytes,
    accounts.whatsapp_connection_limit
  FROM app_private.clerk_identities AS identities
  JOIN app.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  LEFT JOIN app.personal_account_key_envelopes AS envelopes
    ON envelopes.personal_account_id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'

  UNION ALL

  SELECT
    'waitlisted'::text,
    NULL::uuid,
    false,
    NULL::smallint,
    NULL::bigint,
    NULL::smallint
  FROM app_private.private_beta_waitlist AS waitlist
  WHERE waitlist.clerk_user_id = verified_clerk_user_id
    AND NOT EXISTS (
      SELECT 1
      FROM app_private.clerk_identities AS identities
      JOIN app.personal_accounts AS accounts
        ON accounts.id = identities.personal_account_id
      WHERE identities.clerk_user_id = verified_clerk_user_id
    )
$function$;

REVOKE ALL
  ON FUNCTION app_private.create_personal_account_for_clerk(
    text,
    uuid,
    integer,
    text,
    bytea
  )
  FROM PUBLIC;
DROP FUNCTION app_private.create_personal_account_for_clerk(
  text,
  uuid,
  integer,
  text,
  bytea
);

CREATE FUNCTION app_private.admit_personal_account_for_clerk(
  verified_clerk_user_id text,
  proposed_personal_account_id uuid,
  proposed_key_version integer,
  proposed_kms_key_id text,
  proposed_key_ciphertext bytea,
  provider_approved_session_capacity integer
)
RETURNS TABLE (
  admission_state text,
  personal_account_id uuid,
  created boolean,
  message_retention_days smallint,
  stored_media_limit_bytes bigint,
  whatsapp_connection_limit smallint
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  existing_account_id uuid;
  existing_account_state text;
  next_waitlisted_clerk_user_id text;
  reserved_session_capacity bigint;
  private_beta_connection_limit constant smallint := 3;
BEGIN
  IF verified_clerk_user_id !~ '^user_[A-Za-z0-9]{1,64}$'
    OR proposed_key_version <= 0
    OR proposed_kms_key_id = ''
    OR octet_length(proposed_key_ciphertext) = 0
    OR provider_approved_session_capacity < private_beta_connection_limit
  THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('private-beta-admission', 190019)
  );

  SELECT identities.personal_account_id, accounts.state
  INTO existing_account_id, existing_account_state
  FROM app_private.clerk_identities AS identities
  JOIN app.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id;

  IF FOUND THEN
    IF existing_account_state <> 'active' THEN
      RETURN;
    END IF;

    IF existing_account_id = proposed_personal_account_id THEN
      INSERT INTO app.personal_account_key_envelopes (
        personal_account_id,
        key_version,
        kms_key_id,
        ciphertext
      )
      VALUES (
        existing_account_id,
        proposed_key_version,
        proposed_kms_key_id,
        proposed_key_ciphertext
      )
      ON CONFLICT (personal_account_id) DO NOTHING;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM app.personal_account_key_envelopes AS envelopes
      WHERE envelopes.personal_account_id = existing_account_id
        AND envelopes.ciphertext IS NOT NULL
        AND envelopes.unavailable_at IS NULL
    ) THEN
      RETURN QUERY
      SELECT
        'active'::text,
        existing_account_id,
        false,
        accounts.message_retention_days,
        accounts.stored_media_limit_bytes,
        accounts.whatsapp_connection_limit
      FROM app.personal_accounts AS accounts
      WHERE accounts.id = existing_account_id;
    END IF;

    RETURN;
  END IF;

  SELECT waitlist.clerk_user_id
  INTO next_waitlisted_clerk_user_id
  FROM app_private.private_beta_waitlist AS waitlist
  ORDER BY waitlist.created_at, waitlist.clerk_user_id
  LIMIT 1;

  IF next_waitlisted_clerk_user_id IS NOT NULL
    AND next_waitlisted_clerk_user_id <> verified_clerk_user_id
  THEN
    INSERT INTO app_private.private_beta_waitlist (clerk_user_id)
    VALUES (verified_clerk_user_id)
    ON CONFLICT (clerk_user_id) DO NOTHING;

    RETURN QUERY
    SELECT
      'waitlisted'::text,
      NULL::uuid,
      false,
      NULL::smallint,
      NULL::bigint,
      NULL::smallint;
    RETURN;
  END IF;

  SELECT COALESCE(
    sum(accounts.whatsapp_connection_limit),
    0
  )
  INTO reserved_session_capacity
  FROM app.personal_accounts AS accounts;

  IF reserved_session_capacity + private_beta_connection_limit
    > provider_approved_session_capacity
  THEN
    INSERT INTO app_private.private_beta_waitlist (clerk_user_id)
    VALUES (verified_clerk_user_id)
    ON CONFLICT (clerk_user_id) DO NOTHING;

    RETURN QUERY
    SELECT
      'waitlisted'::text,
      NULL::uuid,
      false,
      NULL::smallint,
      NULL::bigint,
      NULL::smallint;
    RETURN;
  END IF;

  DELETE FROM app_private.private_beta_waitlist AS waitlist
  WHERE waitlist.clerk_user_id = verified_clerk_user_id;

  INSERT INTO app.personal_accounts (id, state)
  VALUES (proposed_personal_account_id, 'active');

  INSERT INTO app_private.clerk_identities (
    clerk_user_id,
    personal_account_id
  )
  VALUES (
    verified_clerk_user_id,
    proposed_personal_account_id
  );

  INSERT INTO app.personal_account_key_envelopes (
    personal_account_id,
    key_version,
    kms_key_id,
    ciphertext
  )
  VALUES (
    proposed_personal_account_id,
    proposed_key_version,
    proposed_kms_key_id,
    proposed_key_ciphertext
  );

  RETURN QUERY
  SELECT
    'active'::text,
    proposed_personal_account_id,
    true,
    accounts.message_retention_days,
    accounts.stored_media_limit_bytes,
    accounts.whatsapp_connection_limit
  FROM app.personal_accounts AS accounts
  WHERE accounts.id = proposed_personal_account_id;
END
$function$;

REVOKE ALL
  ON FUNCTION app_private.resolve_personal_account_for_clerk(text)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.admit_personal_account_for_clerk(
    text,
    uuid,
    integer,
    text,
    bytea,
    integer
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.resolve_personal_account_for_clerk(text)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.admit_personal_account_for_clerk(
    text,
    uuid,
    integer,
    text,
    bytea,
    integer
  )
  TO whatsapp_api_runtime;
