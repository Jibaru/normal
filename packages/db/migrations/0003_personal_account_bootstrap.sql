ALTER TABLE app.personal_accounts
ADD COLUMN stored_media_limit_bytes bigint NOT NULL
  DEFAULT 5368709120
  CHECK (stored_media_limit_bytes = 5368709120),
ADD COLUMN whatsapp_connection_limit smallint NOT NULL
  DEFAULT 3
  CHECK (whatsapp_connection_limit = 3);

CREATE OR REPLACE FUNCTION app_private.bootstrap_personal_account_for_clerk(
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

CREATE FUNCTION app_private.resolve_personal_account_for_clerk(
  verified_clerk_user_id text
)
RETURNS TABLE (
  personal_account_id uuid,
  key_available boolean,
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
    identities.personal_account_id,
    (
      envelopes.personal_account_id IS NOT NULL
      AND envelopes.ciphertext IS NOT NULL
      AND envelopes.unavailable_at IS NULL
    ) AS key_available,
    accounts.stored_media_limit_bytes,
    accounts.whatsapp_connection_limit
  FROM app_private.clerk_identities AS identities
  JOIN app.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  LEFT JOIN app.personal_account_key_envelopes AS envelopes
    ON envelopes.personal_account_id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
$function$;

CREATE FUNCTION app_private.create_personal_account_for_clerk(
  verified_clerk_user_id text,
  proposed_personal_account_id uuid,
  proposed_key_version integer,
  proposed_kms_key_id text,
  proposed_key_ciphertext bytea
)
RETURNS TABLE (
  personal_account_id uuid,
  created boolean,
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
BEGIN
  IF verified_clerk_user_id !~ '^user_[A-Za-z0-9]{1,64}$'
    OR proposed_key_version <= 0
    OR proposed_kms_key_id = ''
    OR octet_length(proposed_key_ciphertext) = 0
  THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(verified_clerk_user_id, 180018)
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
        existing_account_id,
        false,
        accounts.stored_media_limit_bytes,
        accounts.whatsapp_connection_limit
      FROM app.personal_accounts AS accounts
      WHERE accounts.id = existing_account_id;
    END IF;

    RETURN;
  END IF;

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
    proposed_personal_account_id,
    true,
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
  ON FUNCTION app_private.create_personal_account_for_clerk(
    text,
    uuid,
    integer,
    text,
    bytea
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.resolve_personal_account_for_clerk(text)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.create_personal_account_for_clerk(
    text,
    uuid,
    integer,
    text,
    bytea
  )
  TO whatsapp_api_runtime;
