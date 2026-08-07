CREATE OR REPLACE FUNCTION public.admit_personal_account_for_clerk(
  verified_clerk_user_id text,
  proposed_personal_account_id uuid,
  proposed_key_version integer,
  proposed_kms_key_id text,
  proposed_key_ciphertext bytea,
  provider_approved_session_capacity bigint
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
BEGIN
  IF verified_clerk_user_id !~ '^user_[A-Za-z0-9]{1,64}$'
    OR proposed_key_version <= 0
    OR proposed_kms_key_id = ''
    OR octet_length(proposed_key_ciphertext) = 0
  THEN
    RETURN;
  END IF;

  -- Keep first bootstrap requests idempotent while the legacy capacity
  -- argument remains in the signature for migration-before-deploy safety.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('personal-account-admission', 190019)
  );

  SELECT identities.personal_account_id, accounts.state
  INTO existing_account_id, existing_account_state
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id;

  IF FOUND THEN
    IF existing_account_state <> 'active' THEN
      RETURN;
    END IF;

    IF existing_account_id = proposed_personal_account_id THEN
      INSERT INTO public.personal_account_key_envelopes (
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
      ON CONFLICT ON CONSTRAINT personal_account_key_envelopes_pkey DO NOTHING;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.personal_account_key_envelopes AS envelopes
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
      FROM public.personal_accounts AS accounts
      WHERE accounts.id = existing_account_id;
    END IF;

    RETURN;
  END IF;

  INSERT INTO public.personal_accounts (id, state)
  VALUES (proposed_personal_account_id, 'active');

  INSERT INTO public.clerk_identities (
    clerk_user_id,
    personal_account_id
  )
  VALUES (
    verified_clerk_user_id,
    proposed_personal_account_id
  );

  INSERT INTO public.personal_account_key_envelopes (
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
  FROM public.personal_accounts AS accounts
  WHERE accounts.id = proposed_personal_account_id;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.load_connection_setup_failure_code_for_user(
  verified_clerk_user_id text,
  requested_setup_id text
)
RETURNS text
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT setups.provisioning_last_failure_code
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  JOIN public.connection_setups AS setups
    ON setups.personal_account_id = accounts.id
   AND setups.id = requested_setup_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
    AND setups.state = 'provisioning_failed'
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.load_connection_setup_failure_code_for_user(text, text)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.load_connection_setup_failure_code_for_user(text, text)
  TO whatsapp_api_runtime;
