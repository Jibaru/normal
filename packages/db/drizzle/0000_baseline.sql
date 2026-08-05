DO $roles$
DECLARE
  granted_role name;
  runtime_role name;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'whatsapp_api_runtime'::name,
    'whatsapp_webhook_runtime'::name
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname = runtime_role
    ) THEN
      RAISE EXCEPTION 'required runtime role % does not exist', runtime_role;
    END IF;

    EXECUTE format(
      'ALTER ROLE %I NOREPLICATION NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
      runtime_role
    );

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname = runtime_role
        AND (rolsuper OR rolreplication OR rolbypassrls)
    ) THEN
      RAISE EXCEPTION 'runtime role % has prohibited privileged attributes', runtime_role;
    END IF;

    FOR granted_role IN
      SELECT parent.rolname
      FROM pg_catalog.pg_auth_members AS memberships
      JOIN pg_catalog.pg_roles AS parent
        ON parent.oid = memberships.roleid
      JOIN pg_catalog.pg_roles AS member
        ON member.oid = memberships.member
      WHERE member.rolname = runtime_role
    LOOP
      EXECUTE format('REVOKE %I FROM %I', granted_role, runtime_role);
    END LOOP;
  END LOOP;
END
$roles$;
--> statement-breakpoint

REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT
  ON public.drizzle_migrations
  TO whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE TABLE public.personal_accounts (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('active', 'deleting')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
--> statement-breakpoint

CREATE TABLE public.clerk_identities (
  clerk_user_id text PRIMARY KEY,
  personal_account_id uuid NOT NULL UNIQUE
    REFERENCES public.personal_accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
--> statement-breakpoint

CREATE TABLE public.whatsapp_connections (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL
    REFERENCES public.personal_accounts (id) ON DELETE CASCADE,
  webhook_ingress_id uuid NOT NULL UNIQUE,
  display_name_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (personal_account_id, id)
);
--> statement-breakpoint

CREATE TABLE public.whatsapp_connection_secrets (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  credential_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint

ALTER TABLE public.personal_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.personal_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_connection_secrets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_connection_secrets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY personal_accounts_tenant
ON public.personal_accounts
USING (
  id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY whatsapp_connections_tenant
ON public.whatsapp_connections
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY whatsapp_connection_secrets_tenant
ON public.whatsapp_connection_secrets
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

GRANT SELECT, UPDATE ON public.personal_accounts TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.whatsapp_connections
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.whatsapp_connection_secrets
  TO whatsapp_api_runtime;
--> statement-breakpoint

GRANT SELECT ON public.personal_accounts TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.whatsapp_connections TO whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_personal_account_for_clerk(
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
  FROM public.clerk_identities AS identities
  WHERE identities.clerk_user_id = verified_clerk_user_id
$function$;
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_whatsapp_connection_for_ingress(
  verified_webhook_ingress_id uuid
)
RETURNS TABLE (
  personal_account_id uuid,
  whatsapp_connection_id uuid
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    connections.personal_account_id,
    connections.id AS whatsapp_connection_id
  FROM public.whatsapp_connections AS connections
  WHERE connections.webhook_ingress_id = verified_webhook_ingress_id
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.bootstrap_personal_account_for_clerk(text)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.bootstrap_whatsapp_connection_for_ingress(uuid)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.bootstrap_personal_account_for_clerk(text)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.bootstrap_whatsapp_connection_for_ingress(uuid)
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE public.personal_account_key_envelopes (
  personal_account_id uuid PRIMARY KEY
    REFERENCES public.personal_accounts (id) ON DELETE CASCADE,
  key_version integer CHECK (key_version > 0),
  kms_key_id text CHECK (kms_key_id <> ''),
  ciphertext bytea,
  unavailable_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (
    (
      ciphertext IS NOT NULL
      AND key_version IS NOT NULL
      AND kms_key_id IS NOT NULL
      AND unavailable_at IS NULL
    )
    OR (ciphertext IS NULL AND unavailable_at IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE TABLE public.whatsapp_connection_key_envelopes (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  account_key_version integer CHECK (account_key_version > 0),
  key_version integer CHECK (key_version > 0),
  nonce bytea,
  ciphertext bytea,
  unavailable_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (
    (
      nonce IS NOT NULL
      AND ciphertext IS NOT NULL
      AND account_key_version IS NOT NULL
      AND key_version IS NOT NULL
      AND unavailable_at IS NULL
    )
    OR (nonce IS NULL AND ciphertext IS NULL AND unavailable_at IS NOT NULL)
  )
);
--> statement-breakpoint

ALTER TABLE public.personal_account_key_envelopes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.personal_account_key_envelopes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_connection_key_envelopes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_connection_key_envelopes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY personal_account_key_envelopes_tenant
ON public.personal_account_key_envelopes
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY whatsapp_connection_key_envelopes_tenant
ON public.whatsapp_connection_key_envelopes
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

GRANT INSERT
  ON public.personal_account_key_envelopes
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT INSERT
  ON public.whatsapp_connection_key_envelopes
  TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.load_available_personal_account_key(
  requested_personal_account_id uuid
)
RETURNS TABLE (
  personal_account_id uuid,
  key_version integer,
  kms_key_id text,
  ciphertext bytea
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    envelopes.personal_account_id,
    envelopes.key_version,
    envelopes.kms_key_id,
    envelopes.ciphertext
  FROM public.personal_account_key_envelopes AS envelopes
  JOIN public.personal_accounts AS accounts
    ON accounts.id = envelopes.personal_account_id
  WHERE envelopes.personal_account_id = requested_personal_account_id
    AND requested_personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true),
      ''
    )::uuid
    AND accounts.state = 'active'
    AND envelopes.unavailable_at IS NULL
    AND envelopes.ciphertext IS NOT NULL
$function$;
--> statement-breakpoint

CREATE FUNCTION public.load_available_whatsapp_connection_key(
  requested_personal_account_id uuid,
  requested_whatsapp_connection_id uuid
)
RETURNS TABLE (
  personal_account_id uuid,
  whatsapp_connection_id uuid,
  account_key_version integer,
  key_version integer,
  nonce bytea,
  ciphertext bytea
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    connection_envelopes.personal_account_id,
    connection_envelopes.whatsapp_connection_id,
    connection_envelopes.account_key_version,
    connection_envelopes.key_version,
    connection_envelopes.nonce,
    connection_envelopes.ciphertext
  FROM public.whatsapp_connection_key_envelopes AS connection_envelopes
  JOIN public.personal_account_key_envelopes AS account_envelopes
    ON account_envelopes.personal_account_id =
      connection_envelopes.personal_account_id
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connection_envelopes.personal_account_id
  WHERE connection_envelopes.personal_account_id =
      requested_personal_account_id
    AND connection_envelopes.whatsapp_connection_id =
      requested_whatsapp_connection_id
    AND requested_personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true),
      ''
    )::uuid
    AND accounts.state = 'active'
    AND account_envelopes.unavailable_at IS NULL
    AND account_envelopes.ciphertext IS NOT NULL
    AND account_envelopes.key_version =
      connection_envelopes.account_key_version
    AND connection_envelopes.unavailable_at IS NULL
    AND connection_envelopes.nonce IS NOT NULL
    AND connection_envelopes.ciphertext IS NOT NULL
$function$;
--> statement-breakpoint

CREATE FUNCTION public.make_personal_account_key_unavailable(
  requested_personal_account_id uuid,
  requested_unavailable_at timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  effective_unavailable_at timestamptz;
  tenant_context uuid;
BEGIN
  tenant_context := nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid;
  IF tenant_context IS NULL
    OR tenant_context IS DISTINCT FROM requested_personal_account_id
  THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'Personal Account context does not match';
  END IF;

  INSERT INTO public.personal_account_key_envelopes (
    personal_account_id,
    unavailable_at
  )
  VALUES (
    requested_personal_account_id,
    requested_unavailable_at
  )
  ON CONFLICT (personal_account_id)
  DO UPDATE SET
    ciphertext = NULL,
    unavailable_at = coalesce(
      personal_account_key_envelopes.unavailable_at,
      excluded.unavailable_at
    )
  RETURNING unavailable_at INTO effective_unavailable_at;

  RETURN effective_unavailable_at;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.make_whatsapp_connection_key_unavailable(
  requested_personal_account_id uuid,
  requested_whatsapp_connection_id uuid,
  requested_unavailable_at timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  effective_unavailable_at timestamptz;
  tenant_context uuid;
BEGIN
  tenant_context := nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid;
  IF tenant_context IS NULL
    OR tenant_context IS DISTINCT FROM requested_personal_account_id
  THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'Personal Account context does not match';
  END IF;

  INSERT INTO public.whatsapp_connection_key_envelopes (
    personal_account_id,
    whatsapp_connection_id,
    unavailable_at
  )
  VALUES (
    requested_personal_account_id,
    requested_whatsapp_connection_id,
    requested_unavailable_at
  )
  ON CONFLICT (personal_account_id, whatsapp_connection_id)
  DO UPDATE SET
    ciphertext = NULL,
    nonce = NULL,
    unavailable_at = coalesce(
      whatsapp_connection_key_envelopes.unavailable_at,
      excluded.unavailable_at
    )
  RETURNING unavailable_at INTO effective_unavailable_at;

  RETURN effective_unavailable_at;
END
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.load_available_personal_account_key(uuid)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.load_available_whatsapp_connection_key(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.make_personal_account_key_unavailable(
    uuid,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.make_whatsapp_connection_key_unavailable(
    uuid,
    uuid,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.load_available_personal_account_key(uuid)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.load_available_whatsapp_connection_key(uuid, uuid)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.make_personal_account_key_unavailable(
    uuid,
    timestamptz
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.make_whatsapp_connection_key_unavailable(
    uuid,
    uuid,
    timestamptz
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.personal_accounts
ADD COLUMN stored_media_limit_bytes bigint NOT NULL
  DEFAULT 5368709120
  CHECK (stored_media_limit_bytes = 5368709120),
ADD COLUMN whatsapp_connection_limit smallint NOT NULL
  DEFAULT 3
  CHECK (whatsapp_connection_limit = 3);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.bootstrap_personal_account_for_clerk(
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
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
$function$;
--> statement-breakpoint

CREATE FUNCTION public.resolve_personal_account_for_clerk(
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
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  LEFT JOIN public.personal_account_key_envelopes AS envelopes
    ON envelopes.personal_account_id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
$function$;
--> statement-breakpoint

CREATE FUNCTION public.create_personal_account_for_clerk(
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
      ON CONFLICT (personal_account_id) DO NOTHING;
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
        existing_account_id,
        false,
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
    proposed_personal_account_id,
    true,
    accounts.stored_media_limit_bytes,
    accounts.whatsapp_connection_limit
  FROM public.personal_accounts AS accounts
  WHERE accounts.id = proposed_personal_account_id;
END
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.resolve_personal_account_for_clerk(text)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.create_personal_account_for_clerk(
    text,
    uuid,
    integer,
    text,
    bytea
  )
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.resolve_personal_account_for_clerk(text)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.create_personal_account_for_clerk(
    text,
    uuid,
    integer,
    text,
    bytea
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.personal_accounts
ADD COLUMN message_retention_days smallint NOT NULL
  DEFAULT 30
  CHECK (message_retention_days > 0);
--> statement-breakpoint

CREATE TABLE public.private_beta_waitlist (
  clerk_user_id text PRIMARY KEY
    CHECK (clerk_user_id ~ '^user_[A-Za-z0-9]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
--> statement-breakpoint

REVOKE ALL ON public.private_beta_waitlist FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.resolve_personal_account_for_clerk(text)
  FROM PUBLIC;
--> statement-breakpoint
DROP FUNCTION public.resolve_personal_account_for_clerk(text);
--> statement-breakpoint

CREATE FUNCTION public.resolve_personal_account_for_clerk(
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
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  LEFT JOIN public.personal_account_key_envelopes AS envelopes
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
  FROM public.private_beta_waitlist AS waitlist
  WHERE waitlist.clerk_user_id = verified_clerk_user_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.clerk_identities AS identities
      JOIN public.personal_accounts AS accounts
        ON accounts.id = identities.personal_account_id
      WHERE identities.clerk_user_id = verified_clerk_user_id
    )
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.create_personal_account_for_clerk(
    text,
    uuid,
    integer,
    text,
    bytea
  )
  FROM PUBLIC;
--> statement-breakpoint
DROP FUNCTION public.create_personal_account_for_clerk(
  text,
  uuid,
  integer,
  text,
  bytea
);
--> statement-breakpoint

CREATE FUNCTION public.admit_personal_account_for_clerk(
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
      ON CONFLICT (personal_account_id) DO NOTHING;
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

  SELECT waitlist.clerk_user_id
  INTO next_waitlisted_clerk_user_id
  FROM public.private_beta_waitlist AS waitlist
  ORDER BY waitlist.created_at, waitlist.clerk_user_id
  LIMIT 1;

  IF next_waitlisted_clerk_user_id IS NOT NULL
    AND next_waitlisted_clerk_user_id <> verified_clerk_user_id
  THEN
    INSERT INTO public.private_beta_waitlist (clerk_user_id)
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
  FROM public.personal_accounts AS accounts;

  IF reserved_session_capacity + private_beta_connection_limit
    > provider_approved_session_capacity
  THEN
    INSERT INTO public.private_beta_waitlist (clerk_user_id)
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

  DELETE FROM public.private_beta_waitlist AS waitlist
  WHERE waitlist.clerk_user_id = verified_clerk_user_id;

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

REVOKE ALL
  ON FUNCTION public.resolve_personal_account_for_clerk(text)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.admit_personal_account_for_clerk(
    text,
    uuid,
    integer,
    text,
    bytea,
    bigint
  )
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.resolve_personal_account_for_clerk(text)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.admit_personal_account_for_clerk(
    text,
    uuid,
    integer,
    text,
    bytea,
    bigint
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE public.connection_setups (
  id text PRIMARY KEY
    CHECK (id ~ '^cst_[A-Za-z0-9_-]{21}$'),
  personal_account_id uuid NOT NULL
    REFERENCES public.personal_accounts (id) ON DELETE CASCADE,
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
--> statement-breakpoint

CREATE TABLE public.connection_setup_key_envelopes (
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
    REFERENCES public.connection_setups (personal_account_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE public.whatsapp_number_reservations (
  number_token bytea PRIMARY KEY
    CONSTRAINT whatsapp_number_reservation_token_length
    CHECK (octet_length(number_token) = 32),
  personal_account_id uuid NOT NULL,
  connection_setup_id text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (personal_account_id, connection_setup_id),
  FOREIGN KEY (personal_account_id, connection_setup_id)
    REFERENCES public.connection_setups (personal_account_id, id)
    ON DELETE RESTRICT
);
--> statement-breakpoint

ALTER TABLE public.connection_setups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.connection_setups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.connection_setup_key_envelopes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.connection_setup_key_envelopes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_number_reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_number_reservations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY connection_setups_tenant
ON public.connection_setups
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY connection_setup_key_envelopes_tenant
ON public.connection_setup_key_envelopes
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY whatsapp_number_reservations_tenant
ON public.whatsapp_number_reservations
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

GRANT SELECT
  ON public.connection_setups, public.whatsapp_number_reservations
  TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.load_connection_setup_account(
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
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  JOIN public.personal_account_key_envelopes AS envelopes
    ON envelopes.personal_account_id = accounts.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
    AND envelopes.unavailable_at IS NULL
    AND envelopes.ciphertext IS NOT NULL
$function$;
--> statement-breakpoint

CREATE FUNCTION public.start_connection_setup(
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
    pg_catalog.current_setting('public.personal_account_id', true),
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
  FROM public.personal_accounts AS accounts
  JOIN public.personal_account_key_envelopes AS account_keys
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
  FROM public.connection_setups AS setups
  JOIN public.whatsapp_number_reservations AS reservations
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
      FROM public.whatsapp_connections AS connections
      WHERE connections.personal_account_id = requested_personal_account_id
    ) + (
      SELECT count(*)
      FROM public.connection_setups AS setups
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
    INSERT INTO public.connection_setups (
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

    INSERT INTO public.connection_setup_key_envelopes (
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

    INSERT INTO public.whatsapp_number_reservations (
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
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.load_connection_setup_account(text)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.start_connection_setup(
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
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.load_connection_setup_account(text)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.start_connection_setup(
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
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.whatsapp_connections
ADD COLUMN public_id text;
--> statement-breakpoint

UPDATE public.whatsapp_connections
SET public_id = 'con_' || translate(
  substring(
    encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
    FROM 1 FOR 21
  ),
  '+/',
  '-_'
);
--> statement-breakpoint

ALTER TABLE public.whatsapp_connections
ALTER COLUMN public_id SET NOT NULL,
ALTER COLUMN public_id SET DEFAULT (
  'con_' || translate(
    substring(
      encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
      FROM 1 FOR 21
    ),
    '+/',
    '-_'
  )
);
--> statement-breakpoint

ALTER TABLE public.whatsapp_connections
ADD CONSTRAINT whatsapp_connections_public_id_unique UNIQUE (public_id),
ADD CONSTRAINT whatsapp_connections_public_id_format CHECK (
  public_id ~ '^con_[A-Za-z0-9_-]{21}$'
);
--> statement-breakpoint

CREATE TABLE public.mcp_authorizations (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL
    REFERENCES public.personal_accounts (id) ON DELETE CASCADE,
  oauth_subject text NOT NULL UNIQUE
    CHECK (oauth_subject ~ '^[A-Za-z0-9_-]{43}$'),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 128),
  client_class text NOT NULL CHECK (client_class ~ '^[a-z][a-z0-9_-]{0,63}$'),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 4
    AND scopes <@ ARRAY[
      'connections:read',
      'directory:read',
      'messages:read',
      'messages:send'
    ]::text[]
    AND cardinality(scopes) =
      ('connections:read' = ANY(scopes))::integer +
      ('directory:read' = ANY(scopes))::integer +
      ('messages:read' = ANY(scopes))::integer +
      ('messages:send' = ANY(scopes))::integer
  ),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  reverified_at timestamptz NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (
    reverified_at <= authorized_at
    AND reverified_at > authorized_at - interval '5 minutes'
  ),
  CHECK (
    absolute_expires_at > authorized_at
    AND absolute_expires_at <= authorized_at + interval '90 days'
  ),
  CHECK (
    (state = 'active' AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL)
  ),
  UNIQUE (personal_account_id, id),
  UNIQUE (personal_account_id, id, client_id, oauth_subject)
);
--> statement-breakpoint

CREATE TABLE public.mcp_authorization_connections (
  personal_account_id uuid NOT NULL,
  mcp_authorization_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (mcp_authorization_id, whatsapp_connection_id),
  FOREIGN KEY (personal_account_id, mcp_authorization_id)
    REFERENCES public.mcp_authorizations (personal_account_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint

ALTER TABLE public.mcp_authorizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_authorizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_authorization_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_authorization_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY mcp_authorizations_tenant
ON public.mcp_authorizations
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY mcp_authorization_connections_tenant
ON public.mcp_authorization_connections
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.mcp_authorizations
TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.mcp_authorization_connections
TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_mcp_authorization(
  candidate_authorization_id uuid,
  candidate_oauth_subject text,
  candidate_client_id text,
  observed_at timestamptz
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT authorizations.personal_account_id
  FROM public.mcp_authorizations AS authorizations
  JOIN public.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  WHERE authorizations.id = candidate_authorization_id
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND authorizations.client_id = candidate_client_id
    AND authorizations.state = 'active'
    AND authorizations.absolute_expires_at > observed_at
    AND accounts.state = 'active'
$function$;
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.bootstrap_mcp_authorization(uuid, text, text, timestamptz)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
ON FUNCTION public.bootstrap_mcp_authorization(uuid, text, text, timestamptz)
TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.mcp_authorizations
ADD COLUMN refresh_family_state text NOT NULL DEFAULT 'active'
  CHECK (refresh_family_state IN ('active', 'revoked')),
ADD COLUMN refresh_family_revoked_at timestamptz,
ADD CONSTRAINT mcp_authorizations_refresh_family_revoked_at_check CHECK (
  (
    refresh_family_state = 'active'
    AND refresh_family_revoked_at IS NULL
  )
  OR (
    refresh_family_state = 'revoked'
    AND refresh_family_revoked_at IS NOT NULL
  )
);
--> statement-breakpoint

CREATE TABLE public.mcp_refresh_credentials (
  credential_hash bytea PRIMARY KEY
    CHECK (octet_length(credential_hash) = 32),
  personal_account_id uuid NOT NULL,
  mcp_authorization_id uuid NOT NULL,
  issued_at timestamptz NOT NULL,
  inactive_expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (personal_account_id, mcp_authorization_id)
    REFERENCES public.mcp_authorizations (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (
    inactive_expires_at > issued_at
    AND inactive_expires_at <= issued_at + interval '30 days'
  ),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);
--> statement-breakpoint

CREATE UNIQUE INDEX mcp_refresh_credentials_one_current
ON public.mcp_refresh_credentials (mcp_authorization_id)
WHERE consumed_at IS NULL;
--> statement-breakpoint

ALTER TABLE public.mcp_refresh_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_refresh_credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY mcp_refresh_credentials_tenant
ON public.mcp_refresh_credentials
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.mcp_refresh_credentials
TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_mcp_refresh_authorization(
  candidate_oauth_subject text,
  candidate_client_id text,
  observed_at timestamptz
)
RETURNS TABLE (
  personal_account_id uuid,
  mcp_authorization_id uuid
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    authorizations.personal_account_id,
    authorizations.id AS mcp_authorization_id
  FROM public.mcp_authorizations AS authorizations
  JOIN public.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  WHERE authorizations.oauth_subject = candidate_oauth_subject
    AND authorizations.client_id = candidate_client_id
    AND authorizations.state = 'active'
    AND authorizations.refresh_family_state = 'active'
    AND authorizations.absolute_expires_at > observed_at
    AND accounts.state = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.clerk_identities AS identities
      WHERE identities.personal_account_id =
        authorizations.personal_account_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.mcp_authorization_connections AS selected
      JOIN public.whatsapp_connections AS connections
        ON connections.personal_account_id = selected.personal_account_id
        AND connections.id = selected.whatsapp_connection_id
      WHERE selected.personal_account_id =
          authorizations.personal_account_id
        AND selected.mcp_authorization_id = authorizations.id
    )
$function$;
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_mcp_refresh_credential(
  candidate_credential_hash bytea,
  candidate_oauth_subject text,
  candidate_client_id text
)
RETURNS TABLE (
  personal_account_id uuid,
  mcp_authorization_id uuid
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    credentials.personal_account_id,
    credentials.mcp_authorization_id
  FROM public.mcp_refresh_credentials AS credentials
  JOIN public.mcp_authorizations AS authorizations
    ON authorizations.personal_account_id = credentials.personal_account_id
    AND authorizations.id = credentials.mcp_authorization_id
  WHERE credentials.credential_hash = candidate_credential_hash
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND authorizations.client_id = candidate_client_id
$function$;
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.bootstrap_mcp_refresh_authorization(
  text,
  text,
  timestamptz
)
FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.bootstrap_mcp_refresh_credential(bytea, text, text)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
ON FUNCTION public.bootstrap_mcp_refresh_authorization(
  text,
  text,
  timestamptz
)
TO whatsapp_api_runtime;
--> statement-breakpoint

GRANT EXECUTE
ON FUNCTION public.bootstrap_mcp_refresh_credential(bytea, text, text)
TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.bootstrap_mcp_authorization(
  candidate_authorization_id uuid,
  candidate_oauth_subject text,
  candidate_client_id text,
  observed_at timestamptz
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT authorizations.personal_account_id
  FROM public.mcp_authorizations AS authorizations
  JOIN public.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  WHERE authorizations.id = candidate_authorization_id
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND authorizations.client_id = candidate_client_id
    AND authorizations.state = 'active'
    AND authorizations.refresh_family_state = 'active'
    AND authorizations.absolute_expires_at > observed_at
    AND accounts.state = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.clerk_identities AS identities
      WHERE identities.personal_account_id =
        authorizations.personal_account_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.mcp_authorization_connections AS selected
      JOIN public.whatsapp_connections AS connections
        ON connections.personal_account_id = selected.personal_account_id
        AND connections.id = selected.whatsapp_connection_id
      WHERE selected.personal_account_id =
          authorizations.personal_account_id
        AND selected.mcp_authorization_id = authorizations.id
    )
$function$;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.connection_setups
  DROP CONSTRAINT connection_setups_state_check;
--> statement-breakpoint

ALTER TABLE public.connection_setups
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
--> statement-breakpoint

CREATE INDEX connection_setups_provisioning_candidates
ON public.connection_setups (created_at, id)
WHERE state = 'provisioning_pending';
--> statement-breakpoint

CREATE TABLE public.connection_setup_provider_sessions (
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
    REFERENCES public.connection_setups (personal_account_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint

ALTER TABLE public.connection_setup_provider_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.connection_setup_provider_sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY connection_setup_provider_sessions_tenant
ON public.connection_setup_provider_sessions
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE FUNCTION public.claim_connection_setup_provisioning(
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
  account_key public.personal_account_key_envelopes%ROWTYPE;
  connection_key public.connection_setup_key_envelopes%ROWTYPE;
  setup public.connection_setups%ROWTYPE;
BEGIN
  IF requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$'
    OR requested_worker_id !~ '^cspw_[A-Za-z0-9_-]{43}$'
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup provisioning claim';
  END IF;

  SELECT *
  INTO setup
  FROM public.connection_setups
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
  FROM public.connection_setup_key_envelopes AS connection_keys
  WHERE connection_keys.personal_account_id = setup.personal_account_id
    AND connection_keys.connection_setup_id = setup.id;

  SELECT *
  INTO account_key
  FROM public.personal_account_key_envelopes AS account_keys
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

  UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE FUNCTION public.renew_connection_setup_provisioning_lease(
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
    UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE FUNCTION public.release_connection_setup_provisioning_lease(
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
    UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE FUNCTION public.fail_connection_setup_provisioning(
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
    UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE FUNCTION public.finish_connection_setup_provisioning(
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
  setup public.connection_setups%ROWTYPE;
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
  FROM public.connection_setups
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

    INSERT INTO public.connection_setup_provider_sessions (
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

  UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE FUNCTION public.list_connection_setup_provisioning_candidates(
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
  FROM public.connection_setups AS setups
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
--> statement-breakpoint

REVOKE ALL
  ON TABLE public.connection_setup_provider_sessions
  FROM PUBLIC, whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint

GRANT SELECT
  ON public.connection_setup_provider_sessions
  TO whatsapp_api_runtime;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.claim_connection_setup_provisioning(
    text,
    text,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.renew_connection_setup_provisioning_lease(
    text,
    text,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.release_connection_setup_provisioning_lease(
    text,
    text,
    timestamptz,
    text
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.fail_connection_setup_provisioning(
    text,
    text,
    timestamptz,
    text
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.finish_connection_setup_provisioning(
    text,
    text,
    timestamptz,
    text,
    jsonb
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.list_connection_setup_provisioning_candidates(
    timestamptz,
    integer
  )
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.claim_connection_setup_provisioning(
    text,
    text,
    timestamptz
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.renew_connection_setup_provisioning_lease(
    text,
    text,
    timestamptz
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.release_connection_setup_provisioning_lease(
    text,
    text,
    timestamptz,
    text
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.fail_connection_setup_provisioning(
    text,
    text,
    timestamptz,
    text
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.finish_connection_setup_provisioning(
    text,
    text,
    timestamptz,
    text,
    jsonb
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.list_connection_setup_provisioning_candidates(
    timestamptz,
    integer
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.mcp_authorizations
ADD COLUMN public_id text,
ADD COLUMN client_name text CHECK (
  client_name IS NULL
  OR (
    length(client_name) BETWEEN 1 AND 128
    AND client_name = btrim(client_name)
  )
);
--> statement-breakpoint

UPDATE public.mcp_authorizations
SET public_id = 'mca_' || translate(
  substring(
    encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
    FROM 1 FOR 21
  ),
  '+/',
  '-_'
);
--> statement-breakpoint

ALTER TABLE public.mcp_authorizations
ALTER COLUMN public_id SET NOT NULL,
ALTER COLUMN public_id SET DEFAULT (
  'mca_' || translate(
    substring(
      encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
      FROM 1 FOR 21
    ),
    '+/',
    '-_'
  )
);
--> statement-breakpoint

ALTER TABLE public.mcp_authorizations
ADD CONSTRAINT mcp_authorizations_public_id_unique UNIQUE (public_id),
ADD CONSTRAINT mcp_authorizations_public_id_format CHECK (
  public_id ~ '^mca_[A-Za-z0-9_-]{21}$'
);
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_mcp_access_authorization(
  candidate_authorization_id uuid,
  candidate_oauth_subject text,
  observed_at timestamptz
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT authorizations.personal_account_id
  FROM public.mcp_authorizations AS authorizations
  JOIN public.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  WHERE authorizations.id = candidate_authorization_id
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND authorizations.state = 'active'
    AND authorizations.absolute_expires_at > observed_at
    AND accounts.state = 'active'
$function$;
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.bootstrap_mcp_access_authorization(
  uuid, text, timestamptz
)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
ON FUNCTION public.bootstrap_mcp_access_authorization(
  uuid, text, timestamptz
)
TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.connection_setups
  DROP CONSTRAINT connection_setups_state_check,
  DROP CONSTRAINT connection_setup_terminal_has_no_lease;
--> statement-breakpoint

ALTER TABLE public.connection_setups
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
--> statement-breakpoint

CREATE INDEX connection_setups_cleanup_candidates
ON public.connection_setups (updated_at, id)
WHERE cleanup_state = 'pending';
--> statement-breakpoint

ALTER TABLE public.whatsapp_number_reservations
  DROP CONSTRAINT whatsapp_number_reservations_pkey,
  DROP CONSTRAINT whatsapp_number_reservations_personal_account_id_connection_key,
  ADD COLUMN released_at timestamptz,
  ADD CONSTRAINT whatsapp_number_reservations_pkey
    PRIMARY KEY (personal_account_id, connection_setup_id),
  ADD CONSTRAINT whatsapp_number_reservation_release_order
    CHECK (released_at IS NULL OR released_at >= created_at);
--> statement-breakpoint

CREATE UNIQUE INDEX whatsapp_number_reservations_active_token
ON public.whatsapp_number_reservations (number_token)
WHERE released_at IS NULL;
--> statement-breakpoint

CREATE FUNCTION public.cancel_connection_setup(
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
  setup public.connection_setups%ROWTYPE;
BEGIN
  IF requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$' THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup cancellation';
  END IF;

  SELECT setups.*
  INTO setup
  FROM public.connection_setups AS setups
  JOIN public.clerk_identities AS identities
    ON identities.personal_account_id = setups.personal_account_id
  JOIN public.personal_accounts AS accounts
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

  UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE FUNCTION public.expire_connection_setups(
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
    FROM public.connection_setups AS setups
    WHERE setups.state NOT IN ('cancelled', 'expired')
      AND setups.expires_at <= requested_observed_at
    ORDER BY setups.expires_at, setups.id
    LIMIT requested_limit
    FOR UPDATE SKIP LOCKED
  ),
  expired AS (
    UPDATE public.connection_setups AS setups
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
--> statement-breakpoint

CREATE FUNCTION public.claim_connection_setup_cleanup(
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
  setup public.connection_setups%ROWTYPE;
BEGIN
  IF requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$'
    OR requested_worker_id !~ '^cscw_[A-Za-z0-9_-]{43}$'
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup cleanup claim';
  END IF;

  SELECT *
  INTO setup
  FROM public.connection_setups
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

  UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE FUNCTION public.renew_connection_setup_cleanup_lease(
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
    UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE FUNCTION public.release_connection_setup_cleanup_lease(
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
    UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE FUNCTION public.finish_connection_setup_cleanup(
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
  setup public.connection_setups%ROWTYPE;
BEGIN
  SELECT *
  INTO setup
  FROM public.connection_setups
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

  UPDATE public.whatsapp_number_reservations
  SET released_at = coalesce(released_at, requested_observed_at)
  WHERE personal_account_id = setup.personal_account_id
    AND connection_setup_id = setup.id;

  DELETE FROM public.connection_setup_provider_sessions
  WHERE personal_account_id = setup.personal_account_id
    AND connection_setup_id = setup.id;

  DELETE FROM public.connection_setup_key_envelopes
  WHERE personal_account_id = setup.personal_account_id
    AND connection_setup_id = setup.id;

  UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE FUNCTION public.list_connection_setup_cleanup_candidates(
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
  FROM public.connection_setups AS setups
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.start_connection_setup(
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
    pg_catalog.current_setting('public.personal_account_id', true),
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
  FROM public.personal_accounts AS accounts
  JOIN public.personal_account_key_envelopes AS account_keys
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
  FROM public.connection_setups AS setups
  JOIN public.whatsapp_number_reservations AS reservations
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
      FROM public.whatsapp_connections AS connections
      WHERE connections.personal_account_id = requested_personal_account_id
    ) + (
      SELECT count(*)
      FROM public.connection_setups AS setups
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
    INSERT INTO public.connection_setups (
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

    INSERT INTO public.connection_setup_key_envelopes (
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

    INSERT INTO public.whatsapp_number_reservations (
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
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.cancel_connection_setup(text, text, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.expire_connection_setups(timestamptz, integer)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.claim_connection_setup_cleanup(text, text, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.renew_connection_setup_cleanup_lease(text, text, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.release_connection_setup_cleanup_lease(text, text, timestamptz, text)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.finish_connection_setup_cleanup(text, text, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.list_connection_setup_cleanup_candidates(timestamptz, integer)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.cancel_connection_setup(text, text, timestamptz)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.expire_connection_setups(timestamptz, integer)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.claim_connection_setup_cleanup(text, text, timestamptz)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.renew_connection_setup_cleanup_lease(text, text, timestamptz)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.release_connection_setup_cleanup_lease(text, text, timestamptz, text)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.finish_connection_setup_cleanup(text, text, timestamptz)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.list_connection_setup_cleanup_candidates(timestamptz, integer)
  TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.whatsapp_connections
  ALTER COLUMN display_name_ciphertext DROP NOT NULL,
  ADD COLUMN connection_setup_id text,
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
--> statement-breakpoint

ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_connection_setup_unique
    UNIQUE (connection_setup_id),
  ADD CONSTRAINT whatsapp_connections_connection_setup_tenant_fk
    FOREIGN KEY (personal_account_id, connection_setup_id)
    REFERENCES public.connection_setups (personal_account_id, id)
    ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE public.connection_setups
  DROP CONSTRAINT connection_setups_state_check,
  ADD CONSTRAINT connection_setups_state_check
    CHECK (
      state IN (
        'provisioning_pending',
        'provisioned',
        'provisioning_failed',
        'provisioning_quarantined',
        'cancelled',
        'expired',
        'activated'
      )
    );
--> statement-breakpoint

ALTER TABLE public.whatsapp_connection_secrets
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
--> statement-breakpoint

CREATE TABLE public.whatsapp_connection_provider_sessions (
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
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint

ALTER TABLE public.whatsapp_connection_provider_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_connection_provider_sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY whatsapp_connection_provider_sessions_tenant
ON public.whatsapp_connection_provider_sessions
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

GRANT SELECT
  ON public.whatsapp_connection_provider_sessions
  TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.start_connection_setup(
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
    pg_catalog.current_setting('public.personal_account_id', true),
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
  FROM public.personal_accounts AS accounts
  JOIN public.personal_account_key_envelopes AS account_keys
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
  FROM public.connection_setups AS setups
  JOIN public.whatsapp_number_reservations AS reservations
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
      FROM public.whatsapp_connections AS connections
      WHERE connections.personal_account_id = requested_personal_account_id
    ) + (
      SELECT count(*)
      FROM public.connection_setups AS setups
      WHERE setups.personal_account_id = requested_personal_account_id
        AND setups.state <> 'activated'
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
    INSERT INTO public.connection_setups (
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

    INSERT INTO public.connection_setup_key_envelopes (
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

    INSERT INTO public.whatsapp_number_reservations (
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
--> statement-breakpoint

CREATE FUNCTION public.load_connection_setup_for_activation(
  verified_clerk_user_id text,
  requested_setup_id text,
  requested_observed_at timestamptz
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
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  JOIN public.connection_setups AS setups
    ON setups.personal_account_id = accounts.id
   AND setups.id = requested_setup_id
  JOIN public.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = accounts.id
   AND account_keys.unavailable_at IS NULL
   AND account_keys.ciphertext IS NOT NULL
  JOIN public.connection_setup_key_envelopes AS setup_keys
    ON setup_keys.personal_account_id = setups.personal_account_id
   AND setup_keys.connection_setup_id = setups.id
  LEFT JOIN public.connection_setup_provider_sessions AS provider_sessions
    ON provider_sessions.personal_account_id = setups.personal_account_id
   AND provider_sessions.connection_setup_id = setups.id
   AND provider_sessions.ordinal = 0
  LEFT JOIN public.whatsapp_connections AS connections
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
      setups.state = 'activated'
      OR setups.expires_at > requested_observed_at
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
--> statement-breakpoint

CREATE FUNCTION public.load_whatsapp_connection_account(
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
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
$function$;
--> statement-breakpoint

CREATE FUNCTION public.activate_connection_setup(
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
  setup public.connection_setups%ROWTYPE;
  tenant_context uuid;
BEGIN
  tenant_context := nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
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
  FROM public.connection_setups
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
    FROM public.whatsapp_connections AS connections
    WHERE connections.personal_account_id = requested_personal_account_id
      AND connections.connection_setup_id = requested_setup_id;
    RETURN;
  END IF;

  IF setup.state <> 'provisioned'
    OR setup.expires_at <= requested_connected_at
    OR NOT EXISTS (
      SELECT 1
      FROM public.connection_setup_provider_sessions AS provider_sessions
      WHERE provider_sessions.personal_account_id =
        requested_personal_account_id
        AND provider_sessions.connection_setup_id = requested_setup_id
        AND provider_sessions.ordinal = 0
    )
  THEN
    RAISE data_exception
      USING MESSAGE = 'Connection Setup is not activatable';
  END IF;

  INSERT INTO public.whatsapp_connections (
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

  INSERT INTO public.whatsapp_connection_key_envelopes (
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

  INSERT INTO public.whatsapp_connection_provider_sessions (
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

  INSERT INTO public.whatsapp_connection_secrets (
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

  UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.cancel_connection_setup(
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
  setup public.connection_setups%ROWTYPE;
BEGIN
  IF requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$' THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup cancellation';
  END IF;

  SELECT setups.*
  INTO setup
  FROM public.connection_setups AS setups
  JOIN public.clerk_identities AS identities
    ON identities.personal_account_id = setups.personal_account_id
  JOIN public.personal_accounts AS accounts
    ON accounts.id = setups.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND setups.id = requested_setup_id
    AND accounts.state = 'active'
  FOR UPDATE OF setups;

  IF NOT FOUND OR setup.state = 'activated' THEN
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

  UPDATE public.connection_setups
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.expire_connection_setups(
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
    FROM public.connection_setups AS setups
    WHERE setups.state NOT IN ('cancelled', 'expired', 'activated')
      AND setups.expires_at <= requested_observed_at
    ORDER BY setups.expires_at, setups.id
    LIMIT requested_limit
    FOR UPDATE SKIP LOCKED
  ),
  expired AS (
    UPDATE public.connection_setups AS setups
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
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.load_connection_setup_for_activation(
    text,
    text,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.load_whatsapp_connection_account(text)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.activate_connection_setup(
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
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.load_connection_setup_for_activation(
    text,
    text,
    timestamptz
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.load_whatsapp_connection_account(text)
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.activate_connection_setup(
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
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.connection_setups
  ADD COLUMN webhook_ingress_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD CONSTRAINT connection_setups_webhook_ingress_unique
    UNIQUE (webhook_ingress_id),
  ADD CONSTRAINT connection_setups_activation_ingress_unique
    UNIQUE (personal_account_id, id, webhook_ingress_id);
--> statement-breakpoint

UPDATE public.connection_setups AS setups
SET webhook_ingress_id = connections.webhook_ingress_id
FROM public.whatsapp_connections AS connections
WHERE connections.personal_account_id = setups.personal_account_id
  AND connections.connection_setup_id = setups.id
  AND setups.webhook_ingress_id IS DISTINCT FROM
    connections.webhook_ingress_id;
--> statement-breakpoint

ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_setup_ingress_foreign_key
    FOREIGN KEY (
      personal_account_id,
      connection_setup_id,
      webhook_ingress_id
    )
    REFERENCES public.connection_setups (
      personal_account_id,
      id,
      webhook_ingress_id
    );
--> statement-breakpoint

CREATE FUNCTION public.load_connection_setup_webhook_ingress_for_worker(
  requested_setup_id text,
  requested_worker_id text
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT setups.webhook_ingress_id
  FROM public.connection_setups AS setups
  WHERE setups.id = requested_setup_id
    AND setups.state = 'provisioning_pending'
    AND setups.provisioning_lease_owner = requested_worker_id
$function$;
--> statement-breakpoint

CREATE FUNCTION public.load_connection_setup_webhook_ingress_for_user(
  verified_clerk_user_id text,
  requested_setup_id text
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT setups.webhook_ingress_id
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  JOIN public.connection_setups AS setups
    ON setups.personal_account_id = accounts.id
   AND setups.id = requested_setup_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.load_connection_setup_webhook_ingress_for_worker(
    text,
    text
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.load_connection_setup_webhook_ingress_for_user(
    text,
    text
  )
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.load_connection_setup_webhook_ingress_for_worker(
    text,
    text
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.load_connection_setup_webhook_ingress_for_user(
    text,
    text
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint

DROP FUNCTION public.bootstrap_whatsapp_connection_for_ingress(uuid);
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_whatsapp_connection_for_ingress(
  verified_webhook_ingress_id uuid
)
RETURNS TABLE (
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
  authority_ciphertext bytea
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    connections.personal_account_id,
    connections.id AS whatsapp_connection_id,
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
    provider_sessions.authority_ciphertext
  FROM public.whatsapp_connections AS connections
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  JOIN public.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  JOIN public.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  JOIN public.whatsapp_connection_provider_sessions AS provider_sessions
    ON provider_sessions.personal_account_id = connections.personal_account_id
   AND provider_sessions.whatsapp_connection_id = connections.id
   AND provider_sessions.authority_key_version = connection_keys.key_version
  WHERE connections.webhook_ingress_id = verified_webhook_ingress_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.bootstrap_whatsapp_connection_for_ingress(uuid)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.bootstrap_whatsapp_connection_for_ingress(uuid)
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.whatsapp_connections
  ADD COLUMN desired_state text NOT NULL DEFAULT 'connected'
    CHECK (desired_state IN ('connected', 'disconnected')),
  ADD COLUMN lifecycle_claim_id uuid,
  ADD COLUMN lifecycle_lease_expires_at timestamptz,
  ADD CONSTRAINT whatsapp_connection_lifecycle_lease_complete
    CHECK (
      (lifecycle_claim_id IS NULL AND lifecycle_lease_expires_at IS NULL)
      OR
      (lifecycle_claim_id IS NOT NULL AND lifecycle_lease_expires_at IS NOT NULL)
    );
--> statement-breakpoint

CREATE FUNCTION public.claim_whatsapp_connection_lifecycle(
  verified_clerk_user_id text,
  requested_public_id text,
  requested_action text,
  requested_claim_id uuid,
  requested_at timestamptz
)
RETURNS TABLE (
  outcome text,
  lifecycle_action text,
  setup_marker text,
  connection_public_id text,
  connection_display_name text,
  connection_number_suffix text,
  connection_state text,
  connection_state_changed_at timestamptz
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  connection public.whatsapp_connections%ROWTYPE;
  next_state text;
  target_state text;
BEGIN
  IF requested_public_id !~ '^con_[A-Za-z0-9_-]{21}$'
    OR requested_action NOT IN ('disconnect', 'reconnect')
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid WhatsApp Connection lifecycle request';
  END IF;

  SELECT connections.*
  INTO connection
  FROM public.whatsapp_connections AS connections
  JOIN public.clerk_identities AS identities
    ON identities.personal_account_id = connections.personal_account_id
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND connections.public_id = requested_public_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF connection.lifecycle_claim_id IS NOT NULL
    AND connection.lifecycle_lease_expires_at > requested_at
  THEN
    RETURN QUERY SELECT
      'in_progress'::text,
      NULL::text,
      NULL::text,
      connection.public_id,
      NULL::text,
      connection.number_suffix,
      connection.state,
      connection.state_changed_at;
    RETURN;
  END IF;

  target_state := CASE requested_action
    WHEN 'disconnect' THEN 'disconnected'
    ELSE 'connected'
  END;

  IF connection.state = target_state THEN
    UPDATE public.whatsapp_connections AS connections
    SET
      desired_state = target_state,
      lifecycle_claim_id = NULL,
      lifecycle_lease_expires_at = NULL,
      updated_at = greatest(connections.updated_at, requested_at)
    WHERE connections.id = connection.id;

    RETURN QUERY SELECT
      'complete'::text,
      NULL::text,
      NULL::text,
      connection.public_id,
      NULL::text,
      connection.number_suffix,
      connection.state,
      connection.state_changed_at;
    RETURN;
  END IF;

  next_state := CASE requested_action
    WHEN 'disconnect' THEN 'degraded'
    ELSE 'connecting'
  END;

  UPDATE public.whatsapp_connections AS connections
  SET
    desired_state = target_state,
    lifecycle_claim_id = requested_claim_id,
    lifecycle_lease_expires_at = requested_at + interval '2 minutes',
    state = next_state,
    state_changed_at = CASE
      WHEN connections.state = next_state
        THEN connections.state_changed_at
      ELSE greatest(connections.state_changed_at, requested_at)
    END,
    updated_at = greatest(connections.updated_at, requested_at)
  WHERE connections.id = connection.id
  RETURNING connections.* INTO connection;

  RETURN QUERY SELECT
    'claimed'::text,
    requested_action,
    connection.connection_setup_id,
    connection.public_id,
    NULL::text,
    connection.number_suffix,
    connection.state,
    connection.state_changed_at;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.finish_whatsapp_connection_lifecycle(
  verified_clerk_user_id text,
  requested_public_id text,
  requested_claim_id uuid,
  observed_state text,
  observed_at timestamptz
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
  connection public.whatsapp_connections%ROWTYPE;
BEGIN
  IF requested_public_id !~ '^con_[A-Za-z0-9_-]{21}$'
    OR observed_state NOT IN (
      'connected',
      'connecting',
      'disconnected',
      'reconnect_required',
      'degraded'
    )
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid WhatsApp Connection lifecycle observation';
  END IF;

  SELECT connections.*
  INTO connection
  FROM public.whatsapp_connections AS connections
  JOIN public.clerk_identities AS identities
    ON identities.personal_account_id = connections.personal_account_id
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND connections.public_id = requested_public_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;

  IF NOT FOUND
    OR connection.lifecycle_claim_id IS DISTINCT FROM requested_claim_id
    OR observed_at < connection.state_changed_at
  THEN
    RETURN;
  END IF;

  UPDATE public.whatsapp_connections AS connections
  SET
    lifecycle_claim_id = NULL,
    lifecycle_lease_expires_at = NULL,
    state = observed_state,
    state_changed_at = CASE
      WHEN connections.state = observed_state
        THEN connections.state_changed_at
      ELSE observed_at
    END,
    updated_at = greatest(connections.updated_at, observed_at)
  WHERE connections.id = connection.id
  RETURNING connections.* INTO connection;

  RETURN QUERY SELECT
    connection.public_id,
    NULL::text,
    connection.number_suffix,
    connection.state,
    connection.state_changed_at;
END
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.claim_whatsapp_connection_lifecycle(
    text,
    text,
    text,
    uuid,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.finish_whatsapp_connection_lifecycle(
    text,
    text,
    uuid,
    text,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.claim_whatsapp_connection_lifecycle(
    text,
    text,
    text,
    uuid,
    timestamptz
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.finish_whatsapp_connection_lifecycle(
    text,
    text,
    uuid,
    text,
    timestamptz
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.whatsapp_connections
  ADD COLUMN state_provider_occurred_at timestamptz,
  ADD COLUMN state_provider_version text
    CHECK (
      state_provider_version IS NULL
      OR octet_length(state_provider_version) <= 512
    ),
  ADD COLUMN state_received_at timestamptz NOT NULL
    DEFAULT transaction_timestamp(),
  ADD COLUMN state_webhook_event_id uuid,
  ADD COLUMN state_webhook_item_identity text,
  ADD CONSTRAINT whatsapp_connection_state_item_identity_format
    CHECK (
      state_webhook_item_identity IS NULL
      OR state_webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'
    );
--> statement-breakpoint

UPDATE public.whatsapp_connections
SET
  state_received_at = state_changed_at;
--> statement-breakpoint

CREATE FUNCTION public.initialize_whatsapp_connection_state_receive_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.state_received_at := NEW.state_changed_at;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER initialize_whatsapp_connection_state_receive_order
BEFORE INSERT ON public.whatsapp_connections
FOR EACH ROW
EXECUTE FUNCTION public.initialize_whatsapp_connection_state_receive_order();
--> statement-breakpoint

CREATE TABLE public.webhook_events (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  id uuid NOT NULL,
  ciphertext_sha256 text NOT NULL
    CHECK (ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  payload_bytes integer NOT NULL
    CHECK (payload_bytes BETWEEN 1 AND 1048576),
  received_at timestamptz NOT NULL,
  source_expires_at timestamptz NOT NULL,
  processing_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id, id),
  UNIQUE (id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (source_expires_at = received_at + interval '7 days'),
  CHECK (
    processing_completed_at IS NULL
    OR processing_completed_at >= received_at
  )
);
--> statement-breakpoint

CREATE TABLE public.webhook_items (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  deduplication_identity text NOT NULL
    CHECK (deduplication_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'),
  first_webhook_event_id uuid NOT NULL,
  item_index integer NOT NULL CHECK (item_index >= 0),
  item_kind text NOT NULL CHECK (item_kind ~ '^[a-z][a-z_]{0,63}$'),
  outcome text NOT NULL
    CHECK (outcome IN ('applied', 'quarantined', 'superseded')),
  provider_occurred_at timestamptz,
  provider_version text,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (
    personal_account_id,
    whatsapp_connection_id,
    deduplication_identity
  ),
  FOREIGN KEY (
    personal_account_id,
    whatsapp_connection_id,
    first_webhook_event_id
  )
    REFERENCES public.webhook_events (
      personal_account_id,
      whatsapp_connection_id,
      id
    )
    ON DELETE CASCADE,
  CHECK (provider_version IS NULL OR octet_length(provider_version) <= 512)
);
--> statement-breakpoint

CREATE TABLE public.webhook_item_quarantines (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  webhook_event_id uuid NOT NULL,
  item_index integer NOT NULL CHECK (item_index >= -1),
  item_identity text,
  item_kind text NOT NULL CHECK (item_kind ~ '^[a-z][a-z_]{0,63}$'),
  classification text NOT NULL
    CHECK (
      classification IN (
        'invalid_item_shape',
        'invalid_top_level_shape',
        'missing_required_identity',
        'unsupported_item_kind',
        'unsupported_projection'
      )
    ),
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (
    personal_account_id,
    whatsapp_connection_id,
    webhook_event_id,
    item_index
  ),
  FOREIGN KEY (
    personal_account_id,
    whatsapp_connection_id,
    webhook_event_id
  )
    REFERENCES public.webhook_events (
      personal_account_id,
      whatsapp_connection_id,
      id
    )
    ON DELETE CASCADE,
  CHECK (
    item_identity IS NULL
    OR item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'
  )
);
--> statement-breakpoint

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.webhook_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.webhook_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.webhook_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.webhook_item_quarantines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.webhook_item_quarantines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY webhook_events_tenant
ON public.webhook_events
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY webhook_items_tenant
ON public.webhook_items
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY webhook_item_quarantines_tenant
ON public.webhook_item_quarantines
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE
  ON public.webhook_events
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE
  ON public.webhook_items
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT
  ON public.webhook_item_quarantines
  TO whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE FUNCTION public.load_webhook_event_processing_material(
  requested_personal_account_id uuid,
  requested_whatsapp_connection_id uuid
)
RETURNS TABLE (
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea,
  identity_ciphertext_version smallint,
  identity_key_version integer,
  identity_nonce bytea,
  identity_ciphertext bytea
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    account_keys.key_version,
    account_keys.kms_key_id,
    account_keys.ciphertext,
    connection_keys.account_key_version,
    connection_keys.key_version,
    connection_keys.nonce,
    connection_keys.ciphertext,
    identity_keys.credential_ciphertext_version,
    identity_keys.credential_key_version,
    identity_keys.credential_nonce,
    identity_keys.credential_ciphertext
  FROM public.whatsapp_connections AS connections
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  JOIN public.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  JOIN public.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  JOIN public.whatsapp_connection_secrets AS identity_keys
    ON identity_keys.personal_account_id = connections.personal_account_id
   AND identity_keys.whatsapp_connection_id = connections.id
   AND identity_keys.credential_key_version = connection_keys.key_version
  WHERE connections.personal_account_id = requested_personal_account_id
    AND connections.id = requested_whatsapp_connection_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.load_webhook_event_processing_material(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.load_webhook_event_processing_material(uuid, uuid)
  TO whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.claim_whatsapp_connection_lifecycle(
  verified_clerk_user_id text,
  requested_public_id text,
  requested_action text,
  requested_claim_id uuid,
  requested_at timestamptz
)
RETURNS TABLE (
  outcome text,
  lifecycle_action text,
  setup_marker text,
  connection_public_id text,
  connection_display_name text,
  connection_number_suffix text,
  connection_state text,
  connection_state_changed_at timestamptz
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  connection public.whatsapp_connections%ROWTYPE;
  next_state text;
  target_state text;
BEGIN
  IF requested_public_id !~ '^con_[A-Za-z0-9_-]{21}$'
    OR requested_action NOT IN ('disconnect', 'reconnect')
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid WhatsApp Connection lifecycle request';
  END IF;

  SELECT connections.*
  INTO connection
  FROM public.whatsapp_connections AS connections
  JOIN public.clerk_identities AS identities
    ON identities.personal_account_id = connections.personal_account_id
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND connections.public_id = requested_public_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF connection.lifecycle_claim_id IS NOT NULL
    AND connection.lifecycle_lease_expires_at > requested_at
  THEN
    RETURN QUERY SELECT
      'in_progress'::text,
      NULL::text,
      NULL::text,
      connection.public_id,
      NULL::text,
      connection.number_suffix,
      connection.state,
      connection.state_changed_at;
    RETURN;
  END IF;

  target_state := CASE requested_action
    WHEN 'disconnect' THEN 'disconnected'
    ELSE 'connected'
  END;

  IF connection.state = target_state THEN
    UPDATE public.whatsapp_connections AS connections
    SET
      desired_state = target_state,
      lifecycle_claim_id = NULL,
      lifecycle_lease_expires_at = NULL,
      updated_at = greatest(connections.updated_at, requested_at)
    WHERE connections.id = connection.id;

    RETURN QUERY SELECT
      'complete'::text,
      NULL::text,
      NULL::text,
      connection.public_id,
      NULL::text,
      connection.number_suffix,
      connection.state,
      connection.state_changed_at;
    RETURN;
  END IF;

  next_state := CASE requested_action
    WHEN 'disconnect' THEN 'degraded'
    ELSE 'connecting'
  END;

  UPDATE public.whatsapp_connections AS connections
  SET
    desired_state = target_state,
    lifecycle_claim_id = requested_claim_id,
    lifecycle_lease_expires_at = requested_at + interval '2 minutes',
    state = next_state,
    state_changed_at = CASE
      WHEN connections.state = next_state
        THEN connections.state_changed_at
      ELSE greatest(connections.state_changed_at, requested_at)
    END,
    state_provider_occurred_at = NULL,
    state_provider_version = NULL,
    state_received_at = greatest(connections.state_received_at, requested_at),
    state_webhook_event_id = NULL,
    state_webhook_item_identity = NULL,
    updated_at = greatest(connections.updated_at, requested_at)
  WHERE connections.id = connection.id
  RETURNING connections.* INTO connection;

  RETURN QUERY SELECT
    'claimed'::text,
    requested_action,
    connection.connection_setup_id,
    connection.public_id,
    NULL::text,
    connection.number_suffix,
    connection.state,
    connection.state_changed_at;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.finish_whatsapp_connection_lifecycle(
  verified_clerk_user_id text,
  requested_public_id text,
  requested_claim_id uuid,
  observed_state text,
  observed_at timestamptz
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
  connection public.whatsapp_connections%ROWTYPE;
BEGIN
  IF requested_public_id !~ '^con_[A-Za-z0-9_-]{21}$'
    OR observed_state NOT IN (
      'connected',
      'connecting',
      'disconnected',
      'reconnect_required',
      'degraded'
    )
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid WhatsApp Connection lifecycle observation';
  END IF;

  SELECT connections.*
  INTO connection
  FROM public.whatsapp_connections AS connections
  JOIN public.clerk_identities AS identities
    ON identities.personal_account_id = connections.personal_account_id
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND connections.public_id = requested_public_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;

  IF NOT FOUND
    OR connection.lifecycle_claim_id IS DISTINCT FROM requested_claim_id
    OR observed_at < connection.state_changed_at
  THEN
    RETURN;
  END IF;

  UPDATE public.whatsapp_connections AS connections
  SET
    lifecycle_claim_id = NULL,
    lifecycle_lease_expires_at = NULL,
    state = observed_state,
    state_changed_at = CASE
      WHEN connections.state = observed_state
        THEN connections.state_changed_at
      ELSE observed_at
    END,
    state_provider_occurred_at = NULL,
    state_provider_version = NULL,
    state_received_at = greatest(connections.state_received_at, observed_at),
    state_webhook_event_id = NULL,
    state_webhook_item_identity = NULL,
    updated_at = greatest(connections.updated_at, observed_at)
  WHERE connections.id = connection.id
  RETURNING connections.* INTO connection;

  RETURN QUERY SELECT
    connection.public_id,
    NULL::text,
    connection.number_suffix,
    connection.state,
    connection.state_changed_at;
END
$function$;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.whatsapp_connections
  ADD COLUMN health_last_checked_at timestamptz,
  ADD COLUMN health_last_confirmed_at timestamptz,
  ADD COLUMN health_claim_id uuid,
  ADD COLUMN health_lease_expires_at timestamptz,
  ADD COLUMN state_snapshot_observed_at timestamptz,
  ADD CONSTRAINT whatsapp_connection_health_lease_complete
    CHECK (
      (health_claim_id IS NULL AND health_lease_expires_at IS NULL)
      OR
      (health_claim_id IS NOT NULL AND health_lease_expires_at IS NOT NULL)
    );
--> statement-breakpoint

UPDATE public.whatsapp_connections
SET health_last_confirmed_at = created_at
WHERE connection_setup_id IS NOT NULL;
--> statement-breakpoint

CREATE FUNCTION public.initialize_whatsapp_connection_health()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.state = 'connected' AND NEW.health_last_confirmed_at IS NULL THEN
    NEW.health_last_confirmed_at := NEW.created_at;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER initialize_whatsapp_connection_health
BEFORE INSERT ON public.whatsapp_connections
FOR EACH ROW
EXECUTE FUNCTION public.initialize_whatsapp_connection_health();
--> statement-breakpoint

CREATE FUNCTION public.track_whatsapp_connection_state_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.state_received_at > OLD.state_received_at
    AND NEW.state_provider_occurred_at IS NULL
    AND NEW.state_provider_version IS NULL
    AND NEW.state_webhook_event_id IS NULL
  THEN
    NEW.state_snapshot_observed_at := NEW.state_received_at;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER track_whatsapp_connection_state_snapshot
BEFORE UPDATE ON public.whatsapp_connections
FOR EACH ROW
EXECUTE FUNCTION public.track_whatsapp_connection_state_snapshot();
--> statement-breakpoint

CREATE TABLE public.ingestion_gaps (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cause text NOT NULL
    CHECK (
      cause IN (
        'connection_unavailable',
        'webhook_configuration',
        'ingress_failure',
        'processing_failure',
        'restore_loss'
      )
    ),
  history_window_started_at timestamptz NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  detected_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (personal_account_id, whatsapp_connection_id, id),
  UNIQUE (id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (starts_at >= history_window_started_at),
  CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CHECK (updated_at >= detected_at)
);
--> statement-breakpoint

CREATE UNIQUE INDEX ingestion_gaps_one_active_cause
ON public.ingestion_gaps (
  personal_account_id,
  whatsapp_connection_id,
  cause
)
WHERE ends_at IS NULL;
--> statement-breakpoint

CREATE INDEX ingestion_gaps_connection_interval
ON public.ingestion_gaps (
  personal_account_id,
  whatsapp_connection_id,
  starts_at,
  ends_at
);
--> statement-breakpoint

ALTER TABLE public.ingestion_gaps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ingestion_gaps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY ingestion_gaps_tenant
ON public.ingestion_gaps
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

REVOKE ALL
  ON TABLE public.ingestion_gaps
  FROM PUBLIC, whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE FUNCTION public.claim_whatsapp_connection_health(
  requested_claimed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  health_claim_id uuid,
  whatsapp_connection_id uuid,
  connection_setup_marker text,
  webhook_ingress_id uuid
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 100 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid connection health claim limit';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT connections.id
    FROM public.whatsapp_connections AS connections
    JOIN public.personal_accounts AS accounts
      ON accounts.id = connections.personal_account_id
    JOIN public.connection_setups AS setups
      ON setups.personal_account_id = connections.personal_account_id
     AND setups.id = connections.connection_setup_id
    WHERE accounts.state = 'active'
      AND setups.state = 'activated'
      AND connections.state <> 'deleting'
      AND (
        connections.lifecycle_claim_id IS NULL
        OR connections.lifecycle_lease_expires_at <= requested_claimed_at
      )
      AND (
        connections.health_claim_id IS NULL
        OR connections.health_lease_expires_at <= requested_claimed_at
      )
      AND (
        connections.health_last_checked_at IS NULL
        OR connections.health_last_checked_at
          < date_bin(
            interval '5 minutes',
            requested_claimed_at,
            timestamptz '2000-01-01 00:00:00+00'
          )
      )
    ORDER BY
      connections.health_last_checked_at NULLS FIRST,
      connections.created_at,
      connections.id
    LIMIT requested_limit
    FOR UPDATE OF connections SKIP LOCKED
  ), claimed AS (
    UPDATE public.whatsapp_connections AS connections
    SET
      health_claim_id = gen_random_uuid(),
      health_lease_expires_at = requested_claimed_at + interval '4 minutes',
      updated_at = greatest(connections.updated_at, requested_claimed_at)
    FROM candidates
    WHERE connections.id = candidates.id
    RETURNING
      connections.health_claim_id,
      connections.id,
      connections.personal_account_id,
      connections.connection_setup_id,
      connections.webhook_ingress_id
  )
  SELECT
    claimed.health_claim_id,
    claimed.id,
    claimed.connection_setup_id,
    claimed.webhook_ingress_id
  FROM claimed
  ORDER BY claimed.id;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.finish_whatsapp_connection_health(
  requested_connection_id uuid,
  requested_claim_id uuid,
  observed_state text,
  gap_evidence text,
  webhook_configuration_healthy boolean,
  started_at timestamptz,
  checked_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  connection public.whatsapp_connections%ROWTYPE;
  gap_start timestamptz;
BEGIN
  IF observed_state NOT IN (
    'connected',
    'disconnected',
    'reconnect_required',
    'degraded'
  ) OR gap_evidence NOT IN (
    'healthy',
    'connection_unavailable',
    'webhook_configuration',
    'unknown'
  ) OR (gap_evidence = 'healthy' AND observed_state <> 'connected')
    OR (gap_evidence = 'healthy' AND NOT webhook_configuration_healthy)
    OR (
      gap_evidence IN ('webhook_configuration', 'unknown')
      AND webhook_configuration_healthy
    )
    OR started_at > checked_at
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid connection health observation';
  END IF;

  SELECT connections.*
  INTO connection
  FROM public.whatsapp_connections AS connections
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE connections.id = requested_connection_id
    AND connections.health_claim_id = requested_claim_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF started_at <= connection.state_received_at
    OR (
      connection.health_last_checked_at IS NOT NULL
      AND checked_at < connection.health_last_checked_at
    )
  THEN
    UPDATE public.whatsapp_connections AS connections
    SET
      health_last_checked_at = CASE
        WHEN connections.health_last_checked_at IS NULL
          THEN checked_at
        ELSE greatest(connections.health_last_checked_at, checked_at)
      END,
      health_claim_id = NULL,
      health_lease_expires_at = NULL,
      updated_at = greatest(connections.updated_at, checked_at)
    WHERE connections.id = connection.id;
    RETURN false;
  END IF;

  gap_start := greatest(
    connection.created_at,
    coalesce(connection.health_last_confirmed_at, connection.created_at)
  );

  UPDATE public.whatsapp_connections AS connections
  SET
    health_last_checked_at = checked_at,
    health_last_confirmed_at = CASE
      WHEN gap_evidence = 'healthy' THEN checked_at
      ELSE connections.health_last_confirmed_at
    END,
    health_claim_id = NULL,
    health_lease_expires_at = NULL,
    state = observed_state,
    state_changed_at = CASE
      WHEN connections.state = observed_state
        THEN connections.state_changed_at
      ELSE checked_at
    END,
    state_provider_occurred_at = NULL,
    state_provider_version = NULL,
    state_received_at = checked_at,
    state_webhook_event_id = NULL,
    state_webhook_item_identity = NULL,
    updated_at = greatest(connections.updated_at, checked_at)
  WHERE connections.id = connection.id;

  IF webhook_configuration_healthy THEN
    UPDATE public.ingestion_gaps AS gaps
    SET
      ends_at = greatest(gaps.starts_at, checked_at),
      updated_at = greatest(gaps.updated_at, checked_at)
    WHERE gaps.personal_account_id = connection.personal_account_id
      AND gaps.whatsapp_connection_id = connection.id
      AND gaps.cause = 'webhook_configuration'
      AND gaps.ends_at IS NULL;
  END IF;

  IF gap_evidence = 'healthy' THEN
    UPDATE public.ingestion_gaps AS gaps
    SET
      ends_at = greatest(gaps.starts_at, checked_at),
      updated_at = greatest(gaps.updated_at, checked_at)
    WHERE gaps.personal_account_id = connection.personal_account_id
      AND gaps.whatsapp_connection_id = connection.id
      AND gaps.cause = 'connection_unavailable'
      AND gaps.ends_at IS NULL;
  ELSIF gap_evidence IN (
    'connection_unavailable',
    'webhook_configuration'
  ) THEN
    INSERT INTO public.ingestion_gaps (
      personal_account_id,
      whatsapp_connection_id,
      cause,
      history_window_started_at,
      starts_at,
      detected_at,
      updated_at
    )
    SELECT
      connection.personal_account_id,
      connection.id,
      gap_evidence,
      connection.created_at,
      gap_start,
      checked_at,
      checked_at
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.ingestion_gaps AS gaps
      WHERE gaps.personal_account_id = connection.personal_account_id
        AND gaps.whatsapp_connection_id = connection.id
        AND gaps.cause = gap_evidence
        AND gaps.ends_at IS NULL
    );
  END IF;

  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.record_ingestion_gap_evidence(
  requested_connection_id uuid,
  requested_cause text,
  evidence_active boolean,
  observed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  connection public.whatsapp_connections%ROWTYPE;
  gap_start timestamptz;
BEGIN
  IF requested_cause NOT IN (
    'ingress_failure',
    'processing_failure',
    'restore_loss'
  ) THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid ingestion gap evidence cause';
  END IF;

  SELECT connections.*
  INTO connection
  FROM public.whatsapp_connections AS connections
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE connections.id = requested_connection_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  gap_start := greatest(
    connection.created_at,
    coalesce(connection.health_last_confirmed_at, connection.created_at)
  );

  IF observed_at < gap_start THEN
    RETURN false;
  END IF;

  IF evidence_active THEN
    INSERT INTO public.ingestion_gaps (
      personal_account_id,
      whatsapp_connection_id,
      cause,
      history_window_started_at,
      starts_at,
      detected_at,
      updated_at
    )
    SELECT
      connection.personal_account_id,
      connection.id,
      requested_cause,
      connection.created_at,
      gap_start,
      observed_at,
      observed_at
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.ingestion_gaps AS gaps
      WHERE gaps.personal_account_id = connection.personal_account_id
        AND gaps.whatsapp_connection_id = connection.id
        AND gaps.cause = requested_cause
        AND gaps.ends_at IS NULL
    );
  ELSE
    UPDATE public.ingestion_gaps AS gaps
    SET
      ends_at = greatest(gaps.starts_at, observed_at),
      updated_at = greatest(gaps.updated_at, observed_at)
    WHERE gaps.personal_account_id = connection.personal_account_id
      AND gaps.whatsapp_connection_id = connection.id
      AND gaps.cause = requested_cause
      AND gaps.ends_at IS NULL
      AND observed_at >= gaps.starts_at;
  END IF;

  RETURN true;
END
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.claim_whatsapp_connection_health(
    timestamptz,
    integer
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.finish_whatsapp_connection_health(
    uuid,
    uuid,
    text,
    text,
    boolean,
    timestamptz,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.record_ingestion_gap_evidence(
    uuid,
    text,
    boolean,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.claim_whatsapp_connection_health(
    timestamptz,
    integer
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.finish_whatsapp_connection_health(
    uuid,
    uuid,
    text,
    text,
    boolean,
    timestamptz,
    timestamptz
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.record_ingestion_gap_evidence(
    uuid,
    text,
    boolean,
    timestamptz
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.webhook_events
  ADD COLUMN dead_lettered_at timestamptz,
  ADD CONSTRAINT webhook_event_dead_letter_order
    CHECK (
      dead_lettered_at IS NULL
      OR dead_lettered_at >= received_at
    );
--> statement-breakpoint

ALTER TABLE public.ingestion_gaps
  ADD COLUMN evidence_webhook_event_id uuid,
  ADD CONSTRAINT ingestion_gaps_evidence_webhook_event_unique
    UNIQUE (evidence_webhook_event_id),
  ADD CONSTRAINT ingestion_gaps_evidence_webhook_event
    FOREIGN KEY (
    personal_account_id,
    whatsapp_connection_id,
    evidence_webhook_event_id
  )
    REFERENCES public.webhook_events (
      personal_account_id,
      whatsapp_connection_id,
      id
    )
    ON DELETE SET NULL (evidence_webhook_event_id);
--> statement-breakpoint

CREATE FUNCTION public.classify_webhook_recovery_candidates(
  requested_candidates jsonb
)
RETURNS TABLE (
  candidate_index integer,
  status text
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH candidates AS (
    SELECT parsed.*
    FROM pg_catalog.jsonb_to_recordset(requested_candidates) AS parsed (
      candidate_index integer,
      personal_account_id uuid,
      whatsapp_connection_id uuid,
      event_id uuid,
      ciphertext_sha256 text,
      payload_bytes integer,
      received_at timestamptz
    )
  )
  SELECT
    candidates.candidate_index,
    CASE
      WHEN accounts.id IS NULL
        OR connections.id IS NULL
        OR connections.state = 'deleting'
        THEN 'source_unavailable'
      WHEN events.id IS NULL
        THEN 'unclaimed'
      WHEN events.ciphertext_sha256 = candidates.ciphertext_sha256
        AND events.payload_bytes = candidates.payload_bytes
        AND events.received_at = candidates.received_at
        THEN 'claimed'
      ELSE 'conflict'
    END
  FROM candidates
  LEFT JOIN public.personal_accounts AS accounts
    ON accounts.id = candidates.personal_account_id
   AND accounts.state = 'active'
  LEFT JOIN public.whatsapp_connections AS connections
    ON connections.personal_account_id = candidates.personal_account_id
   AND connections.id = candidates.whatsapp_connection_id
  LEFT JOIN public.webhook_events AS events
    ON events.personal_account_id = candidates.personal_account_id
   AND events.whatsapp_connection_id = candidates.whatsapp_connection_id
   AND events.id = candidates.event_id
  ORDER BY candidates.candidate_index
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.classify_webhook_recovery_candidates(jsonb)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.classify_webhook_recovery_candidates(jsonb)
  TO whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE FUNCTION public.record_webhook_dead_letter_gap(
  requested_personal_account_id uuid,
  requested_connection_id uuid,
  requested_event_id uuid,
  requested_detected_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  gap_exists boolean;
BEGIN
  INSERT INTO public.ingestion_gaps (
    personal_account_id,
    whatsapp_connection_id,
    cause,
    history_window_started_at,
    starts_at,
    detected_at,
    updated_at,
    evidence_webhook_event_id
  )
  SELECT
    connections.personal_account_id,
    connections.id,
    'processing_failure',
    connections.created_at,
    greatest(connections.created_at, events.received_at),
    requested_detected_at,
    requested_detected_at,
    events.id
  FROM public.whatsapp_connections AS connections
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
   AND accounts.state = 'active'
  JOIN public.webhook_events AS events
    ON events.personal_account_id = connections.personal_account_id
   AND events.whatsapp_connection_id = connections.id
   AND events.id = requested_event_id
   AND events.processing_completed_at IS NULL
  WHERE connections.personal_account_id = requested_personal_account_id
    AND connections.id = requested_connection_id
    AND connections.state <> 'deleting'
  ON CONFLICT DO NOTHING;

  SELECT EXISTS (
    SELECT 1
    FROM public.ingestion_gaps AS gaps
    WHERE gaps.personal_account_id = requested_personal_account_id
      AND gaps.whatsapp_connection_id = requested_connection_id
      AND gaps.cause = 'processing_failure'
      AND gaps.ends_at IS NULL
  )
  INTO gap_exists;

  RETURN gap_exists;
END
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.record_webhook_dead_letter_gap(
    uuid,
    uuid,
    uuid,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.record_webhook_dead_letter_gap(
    uuid,
    uuid,
    uuid,
    timestamptz
  )
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE public.tool_call_logs (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL
    REFERENCES public.personal_accounts (id) ON DELETE CASCADE,
  mcp_authorization_id uuid NOT NULL,
  tool_name text NOT NULL
    CHECK (tool_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome text NOT NULL
    CHECK (
      outcome IN (
        'started',
        'success',
        'execution_error',
        'rate_limited',
        'authorization_denied'
      )
    ),
  error_code text
    CHECK (
      error_code IS NULL
      OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'
    ),
  result_count integer CHECK (result_count IS NULL OR result_count >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  quota_reserved boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (personal_account_id, mcp_authorization_id)
    REFERENCES public.mcp_authorizations (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (expires_at = started_at + interval '90 days'),
  CHECK (
    (outcome = 'started' AND completed_at IS NULL)
    OR (outcome <> 'started' AND completed_at IS NOT NULL)
  ),
  CHECK (
    (outcome = 'success' AND error_code IS NULL)
    OR outcome <> 'success'
  )
);
--> statement-breakpoint

CREATE INDEX tool_call_logs_request_quota
ON public.tool_call_logs (personal_account_id, started_at, id)
WHERE quota_reserved;
--> statement-breakpoint

ALTER TABLE public.tool_call_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tool_call_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tool_call_logs_tenant
ON public.tool_call_logs
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE
ON public.tool_call_logs
TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_mcp_tool_call(
  candidate_authorization_id uuid,
  candidate_oauth_subject text,
  candidate_client_id text
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT authorizations.personal_account_id
  FROM public.mcp_authorizations AS authorizations
  WHERE authorizations.id = candidate_authorization_id
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND (
      candidate_client_id IS NULL
      OR authorizations.client_id = candidate_client_id
    )
$function$;
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_active_mcp_tool_call(
  candidate_authorization_id uuid,
  candidate_oauth_subject text,
  candidate_client_id text,
  observed_at timestamptz
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT authorizations.personal_account_id
  FROM public.mcp_authorizations AS authorizations
  JOIN public.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  WHERE authorizations.id = candidate_authorization_id
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND (
      candidate_client_id IS NULL
      OR authorizations.client_id = candidate_client_id
    )
    AND authorizations.state = 'active'
    AND authorizations.refresh_family_state = 'active'
    AND authorizations.absolute_expires_at > observed_at
    AND accounts.state = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.clerk_identities AS identities
      WHERE identities.personal_account_id =
        authorizations.personal_account_id
    )
$function$;
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_tool_call_log(
  candidate_log_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT logs.personal_account_id
  FROM public.tool_call_logs AS logs
  WHERE logs.id = candidate_log_id
$function$;
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.bootstrap_mcp_tool_call(uuid, text, text)
FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
ON FUNCTION public.bootstrap_active_mcp_tool_call(
  uuid, text, text, timestamptz
)
FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
ON FUNCTION public.bootstrap_tool_call_log(uuid)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
ON FUNCTION public.bootstrap_mcp_tool_call(uuid, text, text)
TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
ON FUNCTION public.bootstrap_active_mcp_tool_call(
  uuid, text, text, timestamptz
)
TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE
ON FUNCTION public.bootstrap_tool_call_log(uuid)
TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
CREATE DOMAIN public.group_name_blind_index AS text
CHECK (VALUE ~ '^gi1_[A-Za-z0-9_-]{43}$');
--> statement-breakpoint

CREATE TABLE public.whatsapp_group_directory_states (
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
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (
    (reconciliation_claim_id IS NULL) =
    (reconciliation_lease_expires_at IS NULL)
  )
);
--> statement-breakpoint

CREATE TABLE public.whatsapp_groups (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE
    CHECK (public_id ~ '^grp_[A-Za-z0-9_-]{21}$'),
  provider_locator text NOT NULL
    CHECK (provider_locator ~ '^wi1_[A-Za-z0-9_-]{43}$'),
  name_prefix_indexes public.group_name_blind_index[] NOT NULL
    DEFAULT ARRAY[]::public.group_name_blind_index[],
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
    REFERENCES public.whatsapp_connections (personal_account_id, id)
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
  ),
  CHECK (array_position(name_prefix_indexes, NULL) IS NULL),
  CHECK (joined OR cardinality(name_prefix_indexes) = 0)
);
--> statement-breakpoint

CREATE INDEX whatsapp_groups_joined_name_prefixes
ON public.whatsapp_groups USING gin (name_prefix_indexes)
WHERE joined;
--> statement-breakpoint

ALTER TABLE public.whatsapp_group_directory_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_group_directory_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_groups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY whatsapp_group_directory_states_tenant
ON public.whatsapp_group_directory_states
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true), ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true), ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY whatsapp_groups_tenant
ON public.whatsapp_groups
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true), ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true), ''
  )::uuid
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE
  ON public.whatsapp_group_directory_states
  TO whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE
  ON public.whatsapp_groups
  TO whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_whatsapp_group_projection(
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
  FROM public.whatsapp_connections AS connections
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE connections.personal_account_id = requested_personal_account_id
    AND connections.id = requested_whatsapp_connection_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.bootstrap_whatsapp_group_projection(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.bootstrap_whatsapp_group_projection(uuid, uuid)
  TO whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE FUNCTION public.load_mcp_group_projection_material(
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
  FROM public.mcp_authorizations AS authorizations
  JOIN public.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  JOIN public.mcp_authorization_connections AS selected
    ON selected.personal_account_id = authorizations.personal_account_id
   AND selected.mcp_authorization_id = authorizations.id
  JOIN public.whatsapp_connections AS connections
    ON connections.personal_account_id = selected.personal_account_id
   AND connections.id = selected.whatsapp_connection_id
  JOIN public.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  JOIN public.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  LEFT JOIN public.whatsapp_group_directory_states AS states
    ON states.personal_account_id = connections.personal_account_id
   AND states.whatsapp_connection_id = connections.id
  WHERE authorizations.id = requested_authorization_id
    AND authorizations.oauth_subject = requested_oauth_subject
    AND (
      requested_client_id IS NULL
      OR authorizations.client_id = requested_client_id
    )
    AND authorizations.personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true), ''
    )::uuid
    AND authorizations.state = 'active'
    AND authorizations.refresh_family_state = 'active'
    AND authorizations.absolute_expires_at > requested_at
    AND accounts.state = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.clerk_identities AS identities
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
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.load_mcp_group_projection_material(
    uuid, text, text, timestamptz, text
  )
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.load_mcp_group_projection_material(
    uuid, text, text, timestamptz, text
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.load_mcp_group_search_material(
  requested_authorization_id uuid,
  requested_oauth_subject text,
  requested_client_id text,
  requested_at timestamptz,
  requested_connection_public_id text
)
RETURNS TABLE (
  connection_id uuid,
  personal_account_id uuid,
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea,
  identity_ciphertext_version smallint,
  identity_key_version integer,
  identity_nonce bytea,
  identity_ciphertext bytea
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    material.connection_id,
    material.personal_account_id,
    material.account_key_version,
    material.account_kms_key_id,
    material.account_key_ciphertext,
    material.connection_key_account_version,
    material.connection_key_version,
    material.connection_key_nonce,
    material.connection_key_ciphertext,
    identity_keys.credential_ciphertext_version,
    identity_keys.credential_key_version,
    identity_keys.credential_nonce,
    identity_keys.credential_ciphertext
  FROM public.load_mcp_group_projection_material(
    requested_authorization_id,
    requested_oauth_subject,
    requested_client_id,
    requested_at,
    requested_connection_public_id
  ) AS material
  JOIN public.whatsapp_connection_secrets AS identity_keys
    ON identity_keys.personal_account_id = material.personal_account_id
   AND identity_keys.whatsapp_connection_id = material.connection_id
   AND identity_keys.credential_key_version = material.connection_key_version
  FOR SHARE OF identity_keys
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.load_mcp_group_search_material(
    uuid, text, text, timestamptz, text
  )
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.load_mcp_group_search_material(
    uuid, text, text, timestamptz, text
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.claim_whatsapp_group_reconciliation(
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

  INSERT INTO public.whatsapp_group_directory_states (
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
  FROM public.whatsapp_connections AS connections
  JOIN public.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE accounts.state = 'active'
    AND connections.state = 'connected'
  ON CONFLICT ON CONSTRAINT whatsapp_group_directory_states_pkey DO NOTHING;

  RETURN QUERY
  WITH candidates AS (
    SELECT states.personal_account_id, states.whatsapp_connection_id
    FROM public.whatsapp_group_directory_states AS states
    JOIN public.whatsapp_connections AS connections
      ON connections.personal_account_id = states.personal_account_id
     AND connections.id = states.whatsapp_connection_id
    JOIN public.personal_accounts AS accounts
      ON accounts.id = connections.personal_account_id
    WHERE accounts.state = 'active'
      AND connections.state = 'connected'
      AND (
        states.reconciliation_lease_expires_at IS NULL
        OR states.reconciliation_lease_expires_at <= requested_at
      )
      AND states.updated_at < requested_at
      AND (
        states.as_of IS NULL
        OR states.as_of <= requested_at - interval '55 minutes'
      )
    ORDER BY states.as_of NULLS FIRST, states.whatsapp_connection_id
    FOR UPDATE OF states SKIP LOCKED
    LIMIT requested_limit
  ), claimed AS (
    UPDATE public.whatsapp_group_directory_states AS states
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
  JOIN public.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = claimed.personal_account_id
   AND connection_keys.whatsapp_connection_id = claimed.whatsapp_connection_id
  JOIN public.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = claimed.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  JOIN public.whatsapp_connection_provider_sessions AS provider_sessions
    ON provider_sessions.personal_account_id = claimed.personal_account_id
   AND provider_sessions.whatsapp_connection_id = claimed.whatsapp_connection_id
   AND provider_sessions.authority_key_version = connection_keys.key_version
  JOIN public.whatsapp_connection_secrets AS identity_keys
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
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.claim_whatsapp_group_reconciliation(timestamptz, integer)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.claim_whatsapp_group_reconciliation(timestamptz, integer)
  TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
CREATE DOMAIN public.directory_blind_index AS text
CHECK (VALUE ~ '^di1_[A-Za-z0-9_-]{43}$');
--> statement-breakpoint

CREATE TABLE public.directory_contact_projections (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  as_of timestamptz NOT NULL,
  stale boolean NOT NULL,
  partial boolean NOT NULL,
  snapshot_observed_at timestamptz,
  reconciliation_attempted_at timestamptz,
  reconciliation_claim_id uuid,
  reconciliation_lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (
    (reconciliation_claim_id IS NULL AND reconciliation_lease_expires_at IS NULL)
    OR
    (reconciliation_claim_id IS NOT NULL AND reconciliation_lease_expires_at IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE TABLE public.directory_contacts (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  public_id text NOT NULL
    CHECK (public_id ~ '^ctc_[A-Za-z0-9_-]{21}$'),
  provider_identity_index public.directory_blind_index NOT NULL,
  provider_identity_ciphertext_version smallint NOT NULL
    CHECK (provider_identity_ciphertext_version = 1),
  provider_identity_key_version integer NOT NULL
    CHECK (provider_identity_key_version > 0),
  provider_identity_nonce bytea NOT NULL
    CHECK (octet_length(provider_identity_nonce) = 12),
  provider_identity_ciphertext bytea NOT NULL
    CHECK (octet_length(provider_identity_ciphertext) > 16),
  display_name_ciphertext_version smallint,
  display_name_key_version integer,
  display_name_nonce bytea,
  display_name_ciphertext bytea,
  display_name_sort text COLLATE "C" NOT NULL
    CHECK (octet_length(display_name_sort) <= 1024),
  phone_ciphertext_version smallint,
  phone_key_version integer,
  phone_nonce bytea,
  phone_ciphertext bytea,
  name_prefix_indexes public.directory_blind_index[] NOT NULL
    DEFAULT ARRAY[]::public.directory_blind_index[],
  phone_index public.directory_blind_index,
  active boolean NOT NULL,
  provider_occurred_at timestamptz,
  provider_version text,
  received_at timestamptz NOT NULL,
  webhook_event_id uuid,
  webhook_item_identity text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id, id),
  UNIQUE (id),
  UNIQUE (public_id),
  UNIQUE (
    personal_account_id,
    whatsapp_connection_id,
    provider_identity_index
  ),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (
    personal_account_id,
    whatsapp_connection_id,
    webhook_event_id
  ) REFERENCES public.webhook_events (
    personal_account_id,
    whatsapp_connection_id,
    id
  ) ON DELETE SET NULL (webhook_event_id),
  CHECK (
    (display_name_ciphertext IS NULL
      AND display_name_ciphertext_version IS NULL
      AND display_name_key_version IS NULL
      AND display_name_nonce IS NULL)
    OR
    (display_name_ciphertext IS NOT NULL
      AND display_name_ciphertext_version = 1
      AND display_name_key_version > 0
      AND octet_length(display_name_nonce) = 12
      AND octet_length(display_name_ciphertext) > 16)
  ),
  CHECK (
    (phone_ciphertext IS NULL
      AND phone_ciphertext_version IS NULL
      AND phone_key_version IS NULL
      AND phone_nonce IS NULL)
    OR
    (phone_ciphertext IS NOT NULL
      AND phone_ciphertext_version = 1
      AND phone_key_version > 0
      AND octet_length(phone_nonce) = 12
      AND octet_length(phone_ciphertext) > 16)
  ),
  CHECK (array_position(name_prefix_indexes, NULL) IS NULL),
  CHECK (
    active
    OR (
      display_name_ciphertext IS NULL
      AND display_name_sort = ''
      AND phone_ciphertext IS NULL
      AND cardinality(name_prefix_indexes) = 0
      AND phone_index IS NULL
    )
  ),
  CHECK (provider_version IS NULL OR octet_length(provider_version) <= 512),
  CHECK (
    webhook_item_identity IS NULL
    OR webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'
  )
);
--> statement-breakpoint

CREATE INDEX directory_contacts_active_order
ON public.directory_contacts (
  personal_account_id,
  whatsapp_connection_id,
  display_name_sort,
  public_id
)
WHERE active;
--> statement-breakpoint

CREATE INDEX directory_contacts_name_prefixes
ON public.directory_contacts USING gin (name_prefix_indexes)
WHERE active;
--> statement-breakpoint

CREATE INDEX directory_contacts_phone
ON public.directory_contacts (
  personal_account_id,
  whatsapp_connection_id,
  phone_index
)
WHERE active AND phone_index IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.directory_contact_projections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.directory_contact_projections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.directory_contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.directory_contacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY directory_contact_projections_tenant
ON public.directory_contact_projections
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY directory_contacts_tenant
ON public.directory_contacts
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

GRANT SELECT ON public.directory_contact_projections, public.directory_contacts
TO whatsapp_api_runtime;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE
ON public.directory_contact_projections, public.directory_contacts
TO whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE FUNCTION public.load_mcp_contact_read_material(
  candidate_authorization_id uuid,
  candidate_oauth_subject text,
  candidate_client_id text,
  candidate_connection_public_id text,
  observed_at timestamptz
)
RETURNS TABLE (
  personal_account_id uuid,
  whatsapp_connection_id uuid,
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea,
  identity_ciphertext_version smallint,
  identity_key_version integer,
  identity_nonce bytea,
  identity_ciphertext bytea,
  projection_as_of timestamptz,
  projection_stale boolean,
  projection_partial boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    authorizations.personal_account_id,
    connections.id,
    account_keys.key_version,
    account_keys.kms_key_id,
    account_keys.ciphertext,
    connection_keys.account_key_version,
    connection_keys.key_version,
    connection_keys.nonce,
    connection_keys.ciphertext,
    identity_keys.credential_ciphertext_version,
    identity_keys.credential_key_version,
    identity_keys.credential_nonce,
    identity_keys.credential_ciphertext,
    coalesce(projections.as_of, connections.created_at),
    coalesce(projections.stale, true),
    coalesce(projections.partial, true)
  FROM public.mcp_authorizations AS authorizations
  JOIN public.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  JOIN public.mcp_authorization_connections AS selected
    ON selected.personal_account_id = authorizations.personal_account_id
   AND selected.mcp_authorization_id = authorizations.id
  JOIN public.whatsapp_connections AS connections
    ON connections.personal_account_id = selected.personal_account_id
   AND connections.id = selected.whatsapp_connection_id
  JOIN public.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  JOIN public.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  JOIN public.whatsapp_connection_secrets AS identity_keys
    ON identity_keys.personal_account_id = connections.personal_account_id
   AND identity_keys.whatsapp_connection_id = connections.id
   AND identity_keys.credential_key_version = connection_keys.key_version
  LEFT JOIN public.directory_contact_projections AS projections
    ON projections.personal_account_id = connections.personal_account_id
   AND projections.whatsapp_connection_id = connections.id
  WHERE authorizations.id = candidate_authorization_id
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND (
      candidate_client_id IS NULL
      OR authorizations.client_id = candidate_client_id
    )
    AND authorizations.state = 'active'
    AND authorizations.refresh_family_state = 'active'
    AND authorizations.absolute_expires_at > observed_at
    AND 'directory:read' = ANY(authorizations.scopes)
    AND connections.public_id = candidate_connection_public_id
    AND connections.state <> 'deleting'
    AND accounts.state = 'active'
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.clerk_identities AS identities
      WHERE identities.personal_account_id = authorizations.personal_account_id
    )
$function$;
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.load_mcp_contact_read_material(
  uuid, text, text, text, timestamptz
)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
ON FUNCTION public.load_mcp_contact_read_material(
  uuid, text, text, text, timestamptz
)
TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.claim_contact_reconciliations(
  claimed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  reconciliation_claim_id uuid,
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
      USING MESSAGE = 'invalid contact reconciliation claim limit';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT connections.personal_account_id, connections.id
    FROM public.whatsapp_connections AS connections
    JOIN public.personal_accounts AS accounts
      ON accounts.id = connections.personal_account_id
    JOIN public.whatsapp_connection_key_envelopes AS connection_keys
      ON connection_keys.personal_account_id = connections.personal_account_id
     AND connection_keys.whatsapp_connection_id = connections.id
     AND connection_keys.unavailable_at IS NULL
     AND connection_keys.nonce IS NOT NULL
     AND connection_keys.ciphertext IS NOT NULL
    JOIN public.personal_account_key_envelopes AS account_keys
      ON account_keys.personal_account_id = connections.personal_account_id
     AND account_keys.key_version = connection_keys.account_key_version
     AND account_keys.unavailable_at IS NULL
     AND account_keys.ciphertext IS NOT NULL
    JOIN public.whatsapp_connection_provider_sessions AS provider_sessions
      ON provider_sessions.personal_account_id = connections.personal_account_id
     AND provider_sessions.whatsapp_connection_id = connections.id
     AND provider_sessions.authority_key_version = connection_keys.key_version
    JOIN public.whatsapp_connection_secrets AS identity_keys
      ON identity_keys.personal_account_id = connections.personal_account_id
     AND identity_keys.whatsapp_connection_id = connections.id
     AND identity_keys.credential_key_version = connection_keys.key_version
    LEFT JOIN public.directory_contact_projections AS projections
      ON projections.personal_account_id = connections.personal_account_id
     AND projections.whatsapp_connection_id = connections.id
    WHERE accounts.state = 'active'
      AND connections.state = 'connected'
      AND (
        projections.reconciliation_claim_id IS NULL
        OR projections.reconciliation_lease_expires_at <= claimed_at
      )
      AND (
        projections.reconciliation_attempted_at IS NULL
        OR projections.reconciliation_attempted_at
          < claimed_at - interval '5 minutes'
      )
    ORDER BY
      projections.reconciliation_attempted_at NULLS FIRST,
      connections.created_at,
      connections.id
    LIMIT requested_limit
    FOR UPDATE OF connections SKIP LOCKED
  ), claimed AS (
    INSERT INTO public.directory_contact_projections (
      personal_account_id,
      whatsapp_connection_id,
      as_of,
      stale,
      partial,
      reconciliation_attempted_at,
      reconciliation_claim_id,
      reconciliation_lease_expires_at,
      updated_at
    )
    SELECT
      candidates.personal_account_id,
      candidates.id,
      connections.created_at,
      true,
      true,
      claimed_at,
      gen_random_uuid(),
      claimed_at + interval '4 minutes',
      claimed_at
    FROM candidates
    JOIN public.whatsapp_connections AS connections
      ON connections.personal_account_id = candidates.personal_account_id
     AND connections.id = candidates.id
    ON CONFLICT ON CONSTRAINT directory_contact_projections_pkey
    DO UPDATE SET
      reconciliation_attempted_at = excluded.reconciliation_attempted_at,
      reconciliation_claim_id = excluded.reconciliation_claim_id,
      reconciliation_lease_expires_at = excluded.reconciliation_lease_expires_at,
      updated_at = greatest(
        public.directory_contact_projections.updated_at,
        excluded.updated_at
      )
    RETURNING
      public.directory_contact_projections.personal_account_id,
      public.directory_contact_projections.whatsapp_connection_id,
      public.directory_contact_projections.reconciliation_claim_id
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
  JOIN public.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = claimed.personal_account_id
   AND connection_keys.whatsapp_connection_id = claimed.whatsapp_connection_id
  JOIN public.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = claimed.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  JOIN public.whatsapp_connection_provider_sessions AS provider_sessions
    ON provider_sessions.personal_account_id = claimed.personal_account_id
   AND provider_sessions.whatsapp_connection_id = claimed.whatsapp_connection_id
   AND provider_sessions.authority_key_version = connection_keys.key_version
  JOIN public.whatsapp_connection_secrets AS identity_keys
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
--> statement-breakpoint

CREATE FUNCTION public.finish_contact_reconciliation(
  requested_connection_id uuid,
  requested_claim_id uuid,
  observed_at timestamptz,
  observation_stale boolean,
  observation_partial boolean,
  protected_contacts jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  projection public.directory_contact_projections%ROWTYPE;
  contact jsonb;
BEGIN
  SELECT projections.*
  INTO projection
  FROM public.directory_contact_projections AS projections
  JOIN public.whatsapp_connections AS connections
    ON connections.personal_account_id = projections.personal_account_id
   AND connections.id = projections.whatsapp_connection_id
  JOIN public.personal_accounts AS accounts
    ON accounts.id = projections.personal_account_id
  WHERE projections.whatsapp_connection_id = requested_connection_id
    AND projections.reconciliation_claim_id = requested_claim_id
    AND projections.reconciliation_lease_expires_at > observed_at
    AND connections.state = 'connected'
    AND accounts.state = 'active'
  FOR UPDATE OF projections;

  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(protected_contacts) <> 'array' THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid protected contact snapshot';
  END IF;
  IF projection.snapshot_observed_at IS NOT NULL
    AND observed_at < projection.snapshot_observed_at
  THEN
    UPDATE public.directory_contact_projections
    SET
      reconciliation_claim_id = NULL,
      reconciliation_lease_expires_at = NULL,
      updated_at = greatest(updated_at, transaction_timestamp())
    WHERE personal_account_id = projection.personal_account_id
      AND whatsapp_connection_id = projection.whatsapp_connection_id;
    RETURN true;
  END IF;

  FOR contact IN SELECT value FROM jsonb_array_elements(protected_contacts)
  LOOP
    INSERT INTO public.directory_contacts (
      personal_account_id,
      whatsapp_connection_id,
      public_id,
      provider_identity_index,
      provider_identity_ciphertext_version,
      provider_identity_key_version,
      provider_identity_nonce,
      provider_identity_ciphertext,
      display_name_ciphertext_version,
      display_name_key_version,
      display_name_nonce,
      display_name_ciphertext,
      display_name_sort,
      phone_ciphertext_version,
      phone_key_version,
      phone_nonce,
      phone_ciphertext,
      name_prefix_indexes,
      phone_index,
      active,
      received_at,
      updated_at
    ) VALUES (
      projection.personal_account_id,
      projection.whatsapp_connection_id,
      contact->>'public_id',
      (contact->>'provider_identity_index')::public.directory_blind_index,
      (contact->>'provider_identity_ciphertext_version')::smallint,
      (contact->>'provider_identity_key_version')::integer,
      decode(contact->>'provider_identity_nonce', 'base64'),
      decode(contact->>'provider_identity_ciphertext', 'base64'),
      (contact->>'display_name_ciphertext_version')::smallint,
      (contact->>'display_name_key_version')::integer,
      CASE WHEN contact->>'display_name_nonce' IS NULL THEN NULL
        ELSE decode(contact->>'display_name_nonce', 'base64') END,
      CASE WHEN contact->>'display_name_ciphertext' IS NULL THEN NULL
        ELSE decode(contact->>'display_name_ciphertext', 'base64') END,
      contact->>'display_name_sort',
      (contact->>'phone_ciphertext_version')::smallint,
      (contact->>'phone_key_version')::integer,
      CASE WHEN contact->>'phone_nonce' IS NULL THEN NULL
        ELSE decode(contact->>'phone_nonce', 'base64') END,
      CASE WHEN contact->>'phone_ciphertext' IS NULL THEN NULL
        ELSE decode(contact->>'phone_ciphertext', 'base64') END,
      ARRAY(
        SELECT value::public.directory_blind_index
        FROM jsonb_array_elements_text(contact->'name_prefix_indexes') AS value
      ),
      (contact->>'phone_index')::public.directory_blind_index,
      true,
      observed_at,
      observed_at
    )
    ON CONFLICT (
      personal_account_id,
      whatsapp_connection_id,
      provider_identity_index
    ) DO UPDATE SET
      provider_identity_ciphertext_version =
        excluded.provider_identity_ciphertext_version,
      provider_identity_key_version = excluded.provider_identity_key_version,
      provider_identity_nonce = excluded.provider_identity_nonce,
      provider_identity_ciphertext = excluded.provider_identity_ciphertext,
      display_name_ciphertext_version = excluded.display_name_ciphertext_version,
      display_name_key_version = excluded.display_name_key_version,
      display_name_nonce = excluded.display_name_nonce,
      display_name_ciphertext = excluded.display_name_ciphertext,
      display_name_sort = excluded.display_name_sort,
      phone_ciphertext_version = excluded.phone_ciphertext_version,
      phone_key_version = excluded.phone_key_version,
      phone_nonce = excluded.phone_nonce,
      phone_ciphertext = excluded.phone_ciphertext,
      name_prefix_indexes = excluded.name_prefix_indexes,
      phone_index = excluded.phone_index,
      active = true,
      provider_occurred_at = NULL,
      provider_version = NULL,
      received_at = excluded.received_at,
      webhook_event_id = NULL,
      webhook_item_identity = NULL,
      updated_at = excluded.updated_at
    WHERE public.directory_contacts.received_at <= observed_at;
  END LOOP;

  IF NOT observation_partial THEN
    UPDATE public.directory_contacts AS contacts
    SET
      active = false,
      display_name_ciphertext_version = NULL,
      display_name_key_version = NULL,
      display_name_nonce = NULL,
      display_name_ciphertext = NULL,
      display_name_sort = '',
      phone_ciphertext_version = NULL,
      phone_key_version = NULL,
      phone_nonce = NULL,
      phone_ciphertext = NULL,
      name_prefix_indexes = ARRAY[]::public.directory_blind_index[],
      phone_index = NULL,
      provider_occurred_at = NULL,
      provider_version = NULL,
      received_at = observed_at,
      webhook_event_id = NULL,
      webhook_item_identity = NULL,
      updated_at = observed_at
    WHERE contacts.personal_account_id = projection.personal_account_id
      AND contacts.whatsapp_connection_id = projection.whatsapp_connection_id
      AND contacts.active
      AND contacts.received_at <= observed_at
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(protected_contacts) AS candidate
        WHERE candidate->>'provider_identity_index' =
          contacts.provider_identity_index::text
      );
  END IF;

  UPDATE public.directory_contact_projections
  SET
    as_of = greatest(as_of, observed_at),
    stale = observation_stale,
    partial = observation_partial,
    snapshot_observed_at = observed_at,
    reconciliation_claim_id = NULL,
    reconciliation_lease_expires_at = NULL,
    updated_at = greatest(updated_at, observed_at)
  WHERE personal_account_id = projection.personal_account_id
    AND whatsapp_connection_id = projection.whatsapp_connection_id;
  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.fail_contact_reconciliation(
  requested_connection_id uuid,
  requested_claim_id uuid,
  failed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  UPDATE public.directory_contact_projections AS projections
  SET
    stale = true,
    partial = true,
    reconciliation_claim_id = NULL,
    reconciliation_lease_expires_at = NULL,
    updated_at = greatest(projections.updated_at, failed_at)
  WHERE projections.whatsapp_connection_id = requested_connection_id
    AND projections.reconciliation_claim_id = requested_claim_id
  RETURNING true
$function$;
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.claim_contact_reconciliations(timestamptz, integer),
  public.finish_contact_reconciliation(
    uuid, uuid, timestamptz, boolean, boolean, jsonb
  ),
  public.fail_contact_reconciliation(uuid, uuid, timestamptz)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
ON FUNCTION public.claim_contact_reconciliations(timestamptz, integer),
  public.finish_contact_reconciliation(
    uuid, uuid, timestamptz, boolean, boolean, jsonb
  ),
  public.fail_contact_reconciliation(uuid, uuid, timestamptz)
TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.directory_contacts
ADD COLUMN snapshot_observed_at timestamptz;
--> statement-breakpoint

UPDATE public.directory_contacts AS contacts
SET snapshot_observed_at = CASE
  WHEN projections.partial THEN contacts.received_at
  ELSE projections.snapshot_observed_at
END
FROM public.directory_contact_projections AS projections
WHERE projections.personal_account_id = contacts.personal_account_id
  AND projections.whatsapp_connection_id = contacts.whatsapp_connection_id
  AND projections.snapshot_observed_at IS NOT NULL
  AND (
    NOT projections.partial
    OR (
      contacts.provider_occurred_at IS NULL
      AND contacts.provider_version IS NULL
      AND contacts.webhook_event_id IS NULL
      AND contacts.webhook_item_identity IS NULL
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.finish_contact_reconciliation(
  requested_connection_id uuid,
  requested_claim_id uuid,
  observed_at timestamptz,
  observation_stale boolean,
  observation_partial boolean,
  protected_contacts jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  projection public.directory_contact_projections%ROWTYPE;
  contact jsonb;
BEGIN
  SELECT projections.*
  INTO projection
  FROM public.directory_contact_projections AS projections
  JOIN public.whatsapp_connections AS connections
    ON connections.personal_account_id = projections.personal_account_id
   AND connections.id = projections.whatsapp_connection_id
  JOIN public.personal_accounts AS accounts
    ON accounts.id = projections.personal_account_id
  WHERE projections.whatsapp_connection_id = requested_connection_id
    AND projections.reconciliation_claim_id = requested_claim_id
    AND projections.reconciliation_lease_expires_at > observed_at
    AND connections.state = 'connected'
    AND accounts.state = 'active'
  FOR UPDATE OF projections;

  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(protected_contacts) <> 'array' THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid protected contact snapshot';
  END IF;
  IF projection.snapshot_observed_at IS NOT NULL
    AND observed_at < projection.snapshot_observed_at
  THEN
    UPDATE public.directory_contact_projections
    SET
      reconciliation_claim_id = NULL,
      reconciliation_lease_expires_at = NULL,
      updated_at = greatest(updated_at, transaction_timestamp())
    WHERE personal_account_id = projection.personal_account_id
      AND whatsapp_connection_id = projection.whatsapp_connection_id;
    RETURN true;
  END IF;

  FOR contact IN SELECT value FROM jsonb_array_elements(protected_contacts)
  LOOP
    INSERT INTO public.directory_contacts (
      personal_account_id,
      whatsapp_connection_id,
      public_id,
      provider_identity_index,
      provider_identity_ciphertext_version,
      provider_identity_key_version,
      provider_identity_nonce,
      provider_identity_ciphertext,
      display_name_ciphertext_version,
      display_name_key_version,
      display_name_nonce,
      display_name_ciphertext,
      display_name_sort,
      phone_ciphertext_version,
      phone_key_version,
      phone_nonce,
      phone_ciphertext,
      name_prefix_indexes,
      phone_index,
      active,
      snapshot_observed_at,
      received_at,
      updated_at
    ) VALUES (
      projection.personal_account_id,
      projection.whatsapp_connection_id,
      contact->>'public_id',
      (contact->>'provider_identity_index')::public.directory_blind_index,
      (contact->>'provider_identity_ciphertext_version')::smallint,
      (contact->>'provider_identity_key_version')::integer,
      decode(contact->>'provider_identity_nonce', 'base64'),
      decode(contact->>'provider_identity_ciphertext', 'base64'),
      (contact->>'display_name_ciphertext_version')::smallint,
      (contact->>'display_name_key_version')::integer,
      CASE WHEN contact->>'display_name_nonce' IS NULL THEN NULL
        ELSE decode(contact->>'display_name_nonce', 'base64') END,
      CASE WHEN contact->>'display_name_ciphertext' IS NULL THEN NULL
        ELSE decode(contact->>'display_name_ciphertext', 'base64') END,
      contact->>'display_name_sort',
      (contact->>'phone_ciphertext_version')::smallint,
      (contact->>'phone_key_version')::integer,
      CASE WHEN contact->>'phone_nonce' IS NULL THEN NULL
        ELSE decode(contact->>'phone_nonce', 'base64') END,
      CASE WHEN contact->>'phone_ciphertext' IS NULL THEN NULL
        ELSE decode(contact->>'phone_ciphertext', 'base64') END,
      ARRAY(
        SELECT value::public.directory_blind_index
        FROM jsonb_array_elements_text(contact->'name_prefix_indexes') AS value
      ),
      (contact->>'phone_index')::public.directory_blind_index,
      true,
      observed_at,
      observed_at,
      observed_at
    )
    ON CONFLICT (
      personal_account_id,
      whatsapp_connection_id,
      provider_identity_index
    ) DO UPDATE SET
      provider_identity_ciphertext_version =
        excluded.provider_identity_ciphertext_version,
      provider_identity_key_version = excluded.provider_identity_key_version,
      provider_identity_nonce = excluded.provider_identity_nonce,
      provider_identity_ciphertext = excluded.provider_identity_ciphertext,
      display_name_ciphertext_version = excluded.display_name_ciphertext_version,
      display_name_key_version = excluded.display_name_key_version,
      display_name_nonce = excluded.display_name_nonce,
      display_name_ciphertext = excluded.display_name_ciphertext,
      display_name_sort = excluded.display_name_sort,
      phone_ciphertext_version = excluded.phone_ciphertext_version,
      phone_key_version = excluded.phone_key_version,
      phone_nonce = excluded.phone_nonce,
      phone_ciphertext = excluded.phone_ciphertext,
      name_prefix_indexes = excluded.name_prefix_indexes,
      phone_index = excluded.phone_index,
      active = true,
      provider_occurred_at = NULL,
      provider_version = NULL,
      snapshot_observed_at = excluded.snapshot_observed_at,
      received_at = excluded.received_at,
      webhook_event_id = NULL,
      webhook_item_identity = NULL,
      updated_at = excluded.updated_at
    WHERE public.directory_contacts.received_at <= observed_at;
  END LOOP;

  UPDATE public.directory_contacts AS contacts
  SET
    snapshot_observed_at = observed_at,
    updated_at = greatest(contacts.updated_at, observed_at)
  WHERE contacts.personal_account_id = projection.personal_account_id
    AND contacts.whatsapp_connection_id = projection.whatsapp_connection_id
    AND (
      contacts.snapshot_observed_at IS NULL
      OR contacts.snapshot_observed_at < observed_at
    )
    AND (
      NOT observation_partial
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(protected_contacts) AS candidate
        WHERE candidate->>'provider_identity_index' =
          contacts.provider_identity_index::text
      )
    );

  IF NOT observation_partial THEN
    UPDATE public.directory_contacts AS contacts
    SET
      active = false,
      display_name_ciphertext_version = NULL,
      display_name_key_version = NULL,
      display_name_nonce = NULL,
      display_name_ciphertext = NULL,
      display_name_sort = '',
      phone_ciphertext_version = NULL,
      phone_key_version = NULL,
      phone_nonce = NULL,
      phone_ciphertext = NULL,
      name_prefix_indexes = ARRAY[]::public.directory_blind_index[],
      phone_index = NULL,
      provider_occurred_at = NULL,
      provider_version = NULL,
      snapshot_observed_at = observed_at,
      received_at = observed_at,
      webhook_event_id = NULL,
      webhook_item_identity = NULL,
      updated_at = observed_at
    WHERE contacts.personal_account_id = projection.personal_account_id
      AND contacts.whatsapp_connection_id = projection.whatsapp_connection_id
      AND contacts.active
      AND contacts.received_at <= observed_at
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(protected_contacts) AS candidate
        WHERE candidate->>'provider_identity_index' =
          contacts.provider_identity_index::text
      );
  END IF;

  UPDATE public.directory_contact_projections
  SET
    as_of = greatest(as_of, observed_at),
    stale = observation_stale,
    partial = observation_partial,
    snapshot_observed_at = observed_at,
    reconciliation_claim_id = NULL,
    reconciliation_lease_expires_at = NULL,
    updated_at = greatest(updated_at, observed_at)
  WHERE personal_account_id = projection.personal_account_id
    AND whatsapp_connection_id = projection.whatsapp_connection_id;
  RETURN true;
END
$function$;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.tool_call_logs
ADD CONSTRAINT tool_call_logs_tenant_id_unique UNIQUE (personal_account_id, id);
--> statement-breakpoint

CREATE TABLE public.send_operations (
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
    REFERENCES public.mcp_authorizations (personal_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id) ON DELETE CASCADE,
  UNIQUE (personal_account_id, id),
  FOREIGN KEY (personal_account_id, tool_call_log_id)
    REFERENCES public.tool_call_logs (personal_account_id, id) ON DELETE CASCADE,
  CHECK (lease_expires_at = attempt_claimed_at + interval '30 seconds'),
  CHECK (expires_at = created_at + interval '90 days')
);
--> statement-breakpoint

CREATE TABLE public.send_idempotency_bindings (
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
    REFERENCES public.mcp_authorizations (personal_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, send_operation_id)
    REFERENCES public.send_operations (personal_account_id, id) ON DELETE CASCADE,
  CHECK (expires_at = created_at + interval '90 days')
);
--> statement-breakpoint

CREATE TABLE public.pending_send_contents (
  send_operation_id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  ciphertext_version smallint NOT NULL CHECK (ciphertext_version = 1),
  key_version integer NOT NULL CHECK (key_version > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 16),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, send_operation_id)
    REFERENCES public.send_operations (personal_account_id, id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE public.send_quota_reservations (
  send_operation_id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL REFERENCES public.personal_accounts (id) ON DELETE CASCADE,
  mcp_authorization_id uuid NOT NULL,
  reserved_at timestamptz NOT NULL,
  FOREIGN KEY (personal_account_id, mcp_authorization_id)
    REFERENCES public.mcp_authorizations (personal_account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, send_operation_id)
    REFERENCES public.send_operations (personal_account_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX send_quota_account_time ON public.send_quota_reservations (personal_account_id, reserved_at);
--> statement-breakpoint
CREATE INDEX send_quota_authorization_time ON public.send_quota_reservations (mcp_authorization_id, reserved_at);
--> statement-breakpoint

ALTER TABLE public.send_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.send_operations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.send_idempotency_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.send_idempotency_bindings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pending_send_contents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.pending_send_contents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.send_quota_reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.send_quota_reservations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY send_operations_tenant ON public.send_operations
USING (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid)
WITH CHECK (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY send_bindings_tenant ON public.send_idempotency_bindings
USING (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid)
WITH CHECK (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY pending_send_contents_tenant ON public.pending_send_contents
USING (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid)
WITH CHECK (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY send_quota_tenant ON public.send_quota_reservations
USING (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid)
WITH CHECK (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.send_operations TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.send_idempotency_bindings TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.pending_send_contents TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.send_quota_reservations TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_send_operation(candidate_send_id uuid)
RETURNS uuid LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT personal_account_id FROM public.send_operations WHERE id = candidate_send_id
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.bootstrap_send_operation(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.bootstrap_send_operation(uuid) TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.load_send_key_material(
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
  FROM public.personal_account_key_envelopes account_keys
  JOIN public.whatsapp_connection_key_envelopes connection_keys
    ON connection_keys.personal_account_id=account_keys.personal_account_id
  JOIN public.whatsapp_connection_provider_sessions sessions
    ON sessions.personal_account_id=connection_keys.personal_account_id
   AND sessions.whatsapp_connection_id=connection_keys.whatsapp_connection_id
  JOIN public.whatsapp_connection_secrets identity_keys
    ON identity_keys.personal_account_id=connection_keys.personal_account_id
   AND identity_keys.whatsapp_connection_id=connection_keys.whatsapp_connection_id
  WHERE account_keys.personal_account_id=requested_personal_account_id
    AND connection_keys.whatsapp_connection_id=requested_connection_id
    AND requested_personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid
    AND account_keys.unavailable_at IS NULL
    AND connection_keys.unavailable_at IS NULL
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.load_send_key_material(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.load_send_key_material(uuid, uuid) TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE public.whatsapp_conversations (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^cvs_[A-Za-z0-9_-]{21}$'),
  kind text NOT NULL CHECK (kind IN ('direct', 'group')),
  recipient_locator text NOT NULL CHECK (recipient_locator ~ '^(wi1|di1)_[A-Za-z0-9_-]{43}$'),
  recipient_public_id text NOT NULL CHECK (recipient_public_id ~ '^(ctc|grp)_[A-Za-z0-9_-]{21}$'),
  last_activity_at timestamptz NOT NULL,
  last_activity_direction text NOT NULL CHECK (last_activity_direction IN ('inbound', 'outbound')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (personal_account_id, whatsapp_connection_id, recipient_locator),
  UNIQUE (personal_account_id, whatsapp_connection_id, id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE public.stored_messages (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^msg_[A-Za-z0-9_-]{21}$'),
  message_identity text NOT NULL CHECK (message_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sent_at timestamptz NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('audio','document','image','sticker','text','unknown','video')),
  content_ciphertext_version smallint NOT NULL CHECK (content_ciphertext_version = 1),
  content_key_version integer NOT NULL CHECK (content_key_version > 0),
  content_nonce bytea NOT NULL CHECK (octet_length(content_nonce) = 12),
  content_ciphertext bytea NOT NULL CHECK (octet_length(content_ciphertext) > 16),
  provider_occurred_at timestamptz,
  provider_version text,
  received_at timestamptz NOT NULL,
  webhook_event_id uuid,
  webhook_item_identity text NOT NULL CHECK (webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (personal_account_id, whatsapp_connection_id, message_identity),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id, conversation_id)
    REFERENCES public.whatsapp_conversations (personal_account_id, whatsapp_connection_id, id) ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, whatsapp_connection_id, webhook_event_id)
    REFERENCES public.webhook_events (personal_account_id, whatsapp_connection_id, id) ON DELETE SET NULL (webhook_event_id),
  CHECK (provider_version IS NULL OR octet_length(provider_version) <= 512)
);
--> statement-breakpoint

CREATE INDEX whatsapp_conversations_activity_order ON public.whatsapp_conversations
  (personal_account_id, whatsapp_connection_id, last_activity_at DESC, public_id);
--> statement-breakpoint

ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_conversations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stored_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stored_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY whatsapp_conversations_tenant ON public.whatsapp_conversations
  USING (personal_account_id = nullif(pg_catalog.current_setting('public.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(pg_catalog.current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY stored_messages_tenant ON public.stored_messages
  USING (personal_account_id = nullif(pg_catalog.current_setting('public.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(pg_catalog.current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_conversations, public.stored_messages TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.directory_contact_projections
  ADD COLUMN retention_limited boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE public.whatsapp_group_directory_states
  ADD COLUMN snapshot_observed_at timestamptz,
  ADD COLUMN retention_limited boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE FUNCTION public.clear_superseded_directory_retention_limitation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.partial = false
    AND (
      TG_OP = 'INSERT'
      OR OLD.partial
      OR NEW.snapshot_observed_at IS DISTINCT FROM OLD.snapshot_observed_at
    )
  THEN
    NEW.retention_limited := false;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER directory_contact_projection_complete_snapshot
BEFORE INSERT OR UPDATE
ON public.directory_contact_projections
FOR EACH ROW
EXECUTE FUNCTION public.clear_superseded_directory_retention_limitation();
--> statement-breakpoint

CREATE TRIGGER whatsapp_group_directory_complete_snapshot
BEFORE INSERT OR UPDATE
ON public.whatsapp_group_directory_states
FOR EACH ROW
EXECUTE FUNCTION public.clear_superseded_directory_retention_limitation();
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.clear_superseded_directory_retention_limitation()
FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public.directory_projection_stale(
  requested_personal_account_id uuid,
  requested_whatsapp_connection_id uuid,
  requested_at timestamptz,
  snapshot_observed_at timestamptz,
  observation_stale boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    observation_stale
    OR snapshot_observed_at < requested_at - interval '10 minutes'
    OR connections.state <> 'connected'
    OR connections.health_last_confirmed_at IS NULL
    OR connections.health_last_confirmed_at
      < requested_at - interval '10 minutes'
  FROM public.whatsapp_connections AS connections
  WHERE connections.personal_account_id = requested_personal_account_id
    AND connections.id = requested_whatsapp_connection_id
$function$;
--> statement-breakpoint

CREATE FUNCTION public.directory_projection_partial(
  requested_personal_account_id uuid,
  requested_whatsapp_connection_id uuid,
  snapshot_observed_at timestamptz,
  observation_partial boolean,
  retention_limited boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    observation_partial
    OR retention_limited
    OR EXISTS (
      SELECT 1
      FROM public.ingestion_gaps AS gaps
      WHERE gaps.personal_account_id = requested_personal_account_id
        AND gaps.whatsapp_connection_id = requested_whatsapp_connection_id
        AND (gaps.ends_at IS NULL OR gaps.ends_at > snapshot_observed_at)
    )
$function$;
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.directory_projection_stale(
  uuid, uuid, timestamptz, timestamptz, boolean
), public.directory_projection_partial(
  uuid, uuid, timestamptz, boolean, boolean
)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
ON FUNCTION public.directory_projection_stale(
  uuid, uuid, timestamptz, timestamptz, boolean
), public.directory_projection_partial(
  uuid, uuid, timestamptz, boolean, boolean
)
TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.webhook_items
  DROP CONSTRAINT webhook_items_personal_account_id_whatsapp_connection_id_f_fkey,
  ALTER COLUMN first_webhook_event_id DROP NOT NULL,
  ADD CONSTRAINT webhook_items_first_event
    FOREIGN KEY (
      personal_account_id,
      whatsapp_connection_id,
      first_webhook_event_id
    )
    REFERENCES public.webhook_events (
      personal_account_id,
      whatsapp_connection_id,
      id
    )
    ON DELETE SET NULL (first_webhook_event_id);
--> statement-breakpoint

CREATE TABLE public.webhook_dead_letter_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  webhook_event_id uuid,
  detected_at timestamptz NOT NULL,
  source_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (webhook_event_id),
  FOREIGN KEY (
    personal_account_id,
    whatsapp_connection_id
  )
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (
    personal_account_id,
    whatsapp_connection_id,
    webhook_event_id
  )
    REFERENCES public.webhook_events (
      personal_account_id,
      whatsapp_connection_id,
      id
    )
    ON DELETE SET NULL (webhook_event_id)
);
--> statement-breakpoint

CREATE TABLE public.webhook_replay_attempts (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  incident_id uuid NOT NULL
    REFERENCES public.webhook_dead_letter_incidents (id) ON DELETE CASCADE,
  operator_reference text NOT NULL
    CHECK (operator_reference ~ '^[a-f0-9]{64}$'),
  reason_code text NOT NULL
    CHECK (
      reason_code IN (
        'dependency_recovered',
        'schema_support_deployed',
        'transient_incident_resolved'
      )
    ),
  requested_at timestamptz NOT NULL,
  status text NOT NULL
    CHECK (status IN ('pending', 'dispatched', 'source_unavailable')),
  dispatched_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (expires_at = requested_at + interval '90 days'),
  CHECK (
    (status IN ('pending', 'source_unavailable') AND dispatched_at IS NULL)
    OR
    (
      status = 'dispatched'
      AND dispatched_at IS NOT NULL
      AND dispatched_at >= requested_at
    )
  )
);
--> statement-breakpoint

CREATE INDEX webhook_replay_attempts_incident
ON public.webhook_replay_attempts (incident_id, requested_at, id);
--> statement-breakpoint

ALTER TABLE public.webhook_dead_letter_incidents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.webhook_dead_letter_incidents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.webhook_replay_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.webhook_replay_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY webhook_dead_letter_incidents_tenant
ON public.webhook_dead_letter_incidents
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

CREATE POLICY webhook_replay_attempts_tenant
ON public.webhook_replay_attempts
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid
);
--> statement-breakpoint

GRANT SELECT, INSERT
  ON public.webhook_dead_letter_incidents
  TO whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE FUNCTION public.resolve_webhook_processing_gap(
  requested_personal_account_id uuid,
  requested_connection_id uuid,
  requested_event_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  completed_at timestamptz;
BEGIN
  SELECT events.processing_completed_at
  INTO completed_at
  FROM public.webhook_events AS events
  WHERE events.personal_account_id = requested_personal_account_id
    AND events.personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true),
      ''
    )::uuid
    AND events.whatsapp_connection_id = requested_connection_id
    AND events.id = requested_event_id
    AND events.processing_completed_at IS NOT NULL;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.ingestion_gaps AS gaps
  SET
    ends_at = greatest(gaps.starts_at, completed_at),
    updated_at = greatest(gaps.updated_at, completed_at)
  WHERE gaps.personal_account_id = requested_personal_account_id
    AND gaps.whatsapp_connection_id = requested_connection_id
    AND gaps.evidence_webhook_event_id = requested_event_id
    AND gaps.cause = 'processing_failure'
    AND gaps.ends_at IS NULL;

  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.prepare_webhook_replay(
  requested_id uuid,
  requested_incident_id uuid,
  requested_operator_reference text,
  requested_reason_code text,
  requested_at timestamptz,
  observed_at timestamptz
)
RETURNS TABLE (
  outcome text,
  event_id uuid,
  personal_account_id uuid,
  whatsapp_connection_id uuid,
  ciphertext_sha256 text,
  payload_bytes integer,
  received_at timestamptz
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  existing public.webhook_replay_attempts%ROWTYPE;
  incident public.webhook_dead_letter_incidents%ROWTYPE;
  source public.webhook_events%ROWTYPE;
BEGIN
  IF requested_operator_reference !~ '^[a-f0-9]{64}$'
    OR requested_at > observed_at + interval '5 minutes'
    OR requested_reason_code NOT IN (
      'dependency_recovered',
      'schema_support_deployed',
      'transient_incident_resolved'
    )
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Webhook Event replay request';
  END IF;

  SELECT attempts.*
  INTO existing
  FROM public.webhook_replay_attempts AS attempts
  WHERE attempts.id = requested_id
  FOR UPDATE;

  IF FOUND THEN
    IF existing.incident_id <> requested_incident_id
      OR existing.operator_reference <> requested_operator_reference
      OR existing.reason_code <> requested_reason_code
      OR existing.requested_at <> requested_at
    THEN
      RAISE unique_violation
        USING MESSAGE = 'conflicting Webhook Event replay request';
    END IF;

    SELECT incidents.*
    INTO incident
    FROM public.webhook_dead_letter_incidents AS incidents
    WHERE incidents.id = existing.incident_id;

    SELECT events.*
    INTO source
    FROM public.webhook_events AS events
    WHERE events.personal_account_id = existing.personal_account_id
      AND events.whatsapp_connection_id = existing.whatsapp_connection_id
      AND events.id = incident.webhook_event_id;

    IF source.id IS NULL OR observed_at >= source.source_expires_at THEN
      UPDATE public.webhook_replay_attempts AS attempts
      SET status = 'source_unavailable'
      WHERE attempts.id = existing.id
        AND attempts.status = 'pending';

      RETURN QUERY SELECT
        'source_unavailable'::text,
        NULL::uuid,
        NULL::uuid,
        NULL::uuid,
        NULL::text,
        NULL::integer,
        NULL::timestamptz;
      RETURN;
    END IF;

    RETURN QUERY SELECT
      CASE
        WHEN existing.status = 'dispatched' THEN 'already_dispatched'::text
        ELSE 'pending'::text
      END,
      source.id,
      source.personal_account_id,
      source.whatsapp_connection_id,
      source.ciphertext_sha256,
      source.payload_bytes,
      source.received_at;
    RETURN;
  END IF;

  SELECT incidents.*
  INTO incident
  FROM public.webhook_dead_letter_incidents AS incidents
  WHERE incidents.id = requested_incident_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'source_unavailable'::text,
      NULL::uuid,
      NULL::uuid,
      NULL::uuid,
      NULL::text,
      NULL::integer,
      NULL::timestamptz;
    RETURN;
  END IF;

  IF incident.webhook_event_id IS NULL THEN
    INSERT INTO public.webhook_replay_attempts (
      id,
      personal_account_id,
      whatsapp_connection_id,
      incident_id,
      operator_reference,
      reason_code,
      requested_at,
      status,
      expires_at
    )
    VALUES (
      requested_id,
      incident.personal_account_id,
      incident.whatsapp_connection_id,
      incident.id,
      requested_operator_reference,
      requested_reason_code,
      requested_at,
      'source_unavailable',
      requested_at + interval '90 days'
    );

    RETURN QUERY SELECT
      'source_unavailable'::text,
      NULL::uuid,
      NULL::uuid,
      NULL::uuid,
      NULL::text,
      NULL::integer,
      NULL::timestamptz;
    RETURN;
  END IF;

  SELECT events.*
  INTO source
  FROM public.webhook_events AS events
  WHERE events.personal_account_id = incident.personal_account_id
    AND events.whatsapp_connection_id = incident.whatsapp_connection_id
    AND events.id = incident.webhook_event_id
    AND events.dead_lettered_at IS NOT NULL
    AND events.processing_completed_at IS NULL
    AND observed_at < events.source_expires_at
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.webhook_replay_attempts (
      id,
      personal_account_id,
      whatsapp_connection_id,
      incident_id,
      operator_reference,
      reason_code,
      requested_at,
      status,
      expires_at
    )
    VALUES (
      requested_id,
      incident.personal_account_id,
      incident.whatsapp_connection_id,
      incident.id,
      requested_operator_reference,
      requested_reason_code,
      requested_at,
      'source_unavailable',
      requested_at + interval '90 days'
    );

    RETURN QUERY SELECT
      'source_unavailable'::text,
      NULL::uuid,
      NULL::uuid,
      NULL::uuid,
      NULL::text,
      NULL::integer,
      NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO public.webhook_replay_attempts (
    id,
    personal_account_id,
    whatsapp_connection_id,
    incident_id,
    operator_reference,
    reason_code,
    requested_at,
    status,
    expires_at
  )
  VALUES (
    requested_id,
    source.personal_account_id,
    source.whatsapp_connection_id,
    incident.id,
    requested_operator_reference,
    requested_reason_code,
    requested_at,
    'pending',
    requested_at + interval '90 days'
  );

  RETURN QUERY SELECT
    'pending'::text,
    source.id,
    source.personal_account_id,
    source.whatsapp_connection_id,
    source.ciphertext_sha256,
    source.payload_bytes,
    source.received_at;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.complete_webhook_replay(
  requested_id uuid,
  requested_dispatched_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  UPDATE public.webhook_replay_attempts AS attempts
  SET
    status = 'dispatched',
    dispatched_at = coalesce(attempts.dispatched_at, requested_dispatched_at)
  WHERE attempts.id = requested_id
    AND attempts.status IN ('pending', 'dispatched')
    AND requested_dispatched_at >= attempts.requested_at;
  RETURN FOUND;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.list_expired_webhook_sources(
  observed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (event_id uuid)
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 100 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Webhook Event retention limit';
  END IF;

  RETURN QUERY
  SELECT events.id
  FROM public.webhook_events AS events
  WHERE events.source_expires_at <= observed_at
  ORDER BY events.source_expires_at, events.id
  LIMIT requested_limit;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.finalize_expired_webhook_source(
  requested_event_id uuid,
  observed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  UPDATE public.whatsapp_connections AS connections
  SET state_webhook_event_id = NULL
  FROM public.webhook_events AS events
  WHERE events.id = requested_event_id
    AND events.source_expires_at <= observed_at
    AND connections.personal_account_id = events.personal_account_id
    AND connections.id = events.whatsapp_connection_id
    AND connections.state_webhook_event_id = events.id;

  DELETE FROM public.webhook_events AS events
  WHERE events.id = requested_event_id
    AND events.source_expires_at <= observed_at;
  RETURN FOUND;
END
$function$;
--> statement-breakpoint

REVOKE ALL
  ON TABLE public.webhook_replay_attempts
  FROM PUBLIC, whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.resolve_webhook_processing_gap(uuid, uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.prepare_webhook_replay(
    uuid,
    uuid,
    text,
    text,
    timestamptz,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.complete_webhook_replay(uuid, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.list_expired_webhook_sources(timestamptz, integer)
  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL
  ON FUNCTION public.finalize_expired_webhook_source(uuid, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.resolve_webhook_processing_gap(uuid, uuid, uuid)
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.prepare_webhook_replay(
    uuid,
    uuid,
    text,
    text,
    timestamptz,
    timestamptz
  )
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.complete_webhook_replay(uuid, timestamptz)
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.list_expired_webhook_sources(timestamptz, integer)
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.finalize_expired_webhook_source(uuid, timestamptz)
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
--> statement-breakpoint
GRANT SELECT (
  id,
  personal_account_id,
  whatsapp_connection_id,
  starts_at,
  ends_at,
  cause
) ON public.ingestion_gaps TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.load_mcp_message_read_material(
  requested_authorization_id uuid,
  requested_oauth_subject text,
  requested_client_id text,
  requested_at timestamptz,
  requested_connection_public_id text,
  requested_conversation_public_id text
)
RETURNS TABLE (
  connection_id uuid,
  connection_created_at timestamptz,
  message_retention_days integer,
  personal_account_id uuid,
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea
)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    connections.id,
    connections.created_at,
    accounts.message_retention_days,
    connections.personal_account_id,
    account_keys.key_version,
    account_keys.kms_key_id,
    account_keys.ciphertext,
    connection_keys.account_key_version,
    connection_keys.key_version,
    connection_keys.nonce,
    connection_keys.ciphertext
  FROM public.mcp_authorizations AS authorizations
  JOIN public.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  JOIN public.mcp_authorization_connections AS selected
    ON selected.personal_account_id = authorizations.personal_account_id
   AND selected.mcp_authorization_id = authorizations.id
  JOIN public.whatsapp_connections AS connections
    ON connections.personal_account_id = selected.personal_account_id
   AND connections.id = selected.whatsapp_connection_id
  JOIN public.whatsapp_conversations AS conversations
    ON conversations.personal_account_id = connections.personal_account_id
   AND conversations.whatsapp_connection_id = connections.id
  JOIN public.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
  JOIN public.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = account_keys.personal_account_id
   AND connection_keys.account_key_version = account_keys.key_version
   AND connection_keys.whatsapp_connection_id = connections.id
  WHERE authorizations.id = requested_authorization_id
    AND authorizations.oauth_subject = requested_oauth_subject
    AND (
      requested_client_id IS NULL
      OR authorizations.client_id = requested_client_id
    )
    AND authorizations.personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true),
      ''
    )::uuid
    AND authorizations.state = 'active'
    AND authorizations.refresh_family_state = 'active'
    AND authorizations.absolute_expires_at > requested_at
    AND accounts.state = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.clerk_identities AS identities
      WHERE identities.personal_account_id = authorizations.personal_account_id
    )
    AND 'messages:read' = ANY(authorizations.scopes)
    AND connections.public_id = requested_connection_public_id
    AND conversations.public_id = requested_conversation_public_id
    AND connections.state <> 'deleting'
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.load_mcp_message_read_material(
    uuid, text, text, timestamptz, text, text
  )
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE
  ON FUNCTION public.load_mcp_message_read_material(
    uuid, text, text, timestamptz, text, text
  )
  TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE INDEX stored_messages_chronological_read
ON public.stored_messages (
  personal_account_id,
  whatsapp_connection_id,
  conversation_id,
  sent_at DESC,
  public_id DESC
);
--> statement-breakpoint
--> statement-breakpoint
CREATE FUNCTION public.expire_send_dispatch_leases(requested_observed_at timestamptz)
RETURNS integer
LANGUAGE plpgsql STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  expired_count integer;
BEGIN
  IF requested_observed_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'send dispatch lease sweep cutoff is in the future';
  END IF;

  WITH expired AS (
    UPDATE public.send_operations
    SET status = 'unknown', status_changed_at = lease_expires_at
    WHERE status = 'processing' AND lease_expires_at <= requested_observed_at
    RETURNING personal_account_id, tool_call_log_id
  ), completed_logs AS (
    UPDATE public.tool_call_logs AS logs
    SET completed_at = requested_observed_at,
        outcome = 'success',
        result_count = 1,
        latency_ms = greatest(
          0,
          floor(extract(epoch FROM (requested_observed_at - logs.started_at)) * 1000)::int
        )
    FROM expired
    WHERE logs.personal_account_id = expired.personal_account_id
      AND logs.id = expired.tool_call_log_id
    RETURNING 1
  )
  SELECT count(*)::integer INTO expired_count FROM expired;

  RETURN expired_count;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.expire_send_dispatch_leases(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.expire_send_dispatch_leases(timestamptz) TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.stored_messages
  ALTER COLUMN content_type DROP NOT NULL,
  ALTER COLUMN content_ciphertext_version DROP NOT NULL,
  ALTER COLUMN content_key_version DROP NOT NULL,
  ALTER COLUMN content_nonce DROP NOT NULL,
  ALTER COLUMN content_ciphertext DROP NOT NULL,
  ADD COLUMN edited_at timestamptz,
  ADD COLUMN deleted_at timestamptz;
--> statement-breakpoint

ALTER TABLE public.stored_messages
  ADD CONSTRAINT stored_messages_content_or_tombstone CHECK (
    (deleted_at IS NULL AND content_type IS NOT NULL
      AND content_ciphertext_version IS NOT NULL
      AND content_key_version IS NOT NULL
      AND content_nonce IS NOT NULL
      AND content_ciphertext IS NOT NULL)
    OR
    (deleted_at IS NOT NULL AND content_type IS NULL
      AND content_ciphertext_version IS NULL
      AND content_key_version IS NULL
      AND content_nonce IS NULL
      AND content_ciphertext IS NULL)
  );
--> statement-breakpoint

GRANT SELECT (edited_at, deleted_at)
  ON public.stored_messages TO whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT INSERT (edited_at, deleted_at), UPDATE (edited_at, deleted_at)
  ON public.stored_messages TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.stored_messages, public.whatsapp_conversations
  TO whatsapp_webhook_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.send_operations
  ADD COLUMN message_identity text;
--> statement-breakpoint

CREATE UNIQUE INDEX send_operations_message_identity
  ON public.send_operations (whatsapp_connection_id, message_identity)
  WHERE message_identity IS NOT NULL;
--> statement-breakpoint

GRANT SELECT (message_identity)
  ON public.send_operations TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT (id, public_id, personal_account_id, mcp_authorization_id,
  whatsapp_connection_id, status, created_at, status_changed_at, expires_at)
  ON public.send_operations TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT UPDATE (status, status_changed_at)
  ON public.send_operations TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT (personal_account_id, send_operation_id), DELETE
  ON public.pending_send_contents TO whatsapp_webhook_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.personal_accounts
  ADD COLUMN stored_media_used_bytes bigint NOT NULL DEFAULT 0
    CHECK (stored_media_used_bytes >= 0 AND stored_media_used_bytes <= stored_media_limit_bytes);
--> statement-breakpoint

ALTER TABLE public.stored_messages
  ADD CONSTRAINT stored_messages_tenant_identity
  UNIQUE (personal_account_id, whatsapp_connection_id, id);
--> statement-breakpoint

CREATE TABLE public.stored_media (
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
    REFERENCES public.stored_messages (personal_account_id, whatsapp_connection_id, id) ON DELETE CASCADE,
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
--> statement-breakpoint

CREATE INDEX stored_media_pending ON public.stored_media (created_at, id) WHERE state = 'pending';
--> statement-breakpoint

CREATE TABLE public.stored_media_object_deletions (
  personal_account_id uuid NOT NULL,
  object_key text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT transaction_timestamp()
  ,PRIMARY KEY (personal_account_id, object_key)
);
--> statement-breakpoint

ALTER TABLE public.stored_media ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stored_media FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stored_media_object_deletions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stored_media_object_deletions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY stored_media_tenant ON public.stored_media
  USING (personal_account_id = nullif(pg_catalog.current_setting('public.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(pg_catalog.current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY stored_media_object_deletions_tenant ON public.stored_media_object_deletions
  USING (personal_account_id = nullif(pg_catalog.current_setting('public.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(pg_catalog.current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stored_media TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stored_media TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.stored_media_object_deletions TO whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT (stored_media_used_bytes), UPDATE (stored_media_used_bytes)
  ON public.personal_accounts TO whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint

CREATE FUNCTION public.list_pending_stored_media(requested_limit integer)
RETURNS TABLE (
  id uuid, personal_account_id uuid, whatsapp_connection_id uuid, media_type text,
  source_ciphertext_version smallint, source_key_version integer, source_nonce bytea, source_ciphertext bytea,
  account_key_version integer, account_kms_key_id text, account_key_ciphertext bytea,
  connection_key_account_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea,
  authority_ciphertext_version smallint, authority_key_version integer,
  authority_nonce bytea, authority_ciphertext bytea
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, public AS $function$
  SELECT media.id, media.personal_account_id, media.whatsapp_connection_id, media.media_type,
    media.source_ciphertext_version, media.source_key_version, media.source_nonce, media.source_ciphertext,
    account_keys.key_version, account_keys.kms_key_id, account_keys.ciphertext,
    connection_keys.account_key_version, connection_keys.key_version, connection_keys.nonce, connection_keys.ciphertext,
    sessions.authority_ciphertext_version, sessions.authority_key_version, sessions.authority_nonce, sessions.authority_ciphertext
  FROM public.stored_media media
  JOIN public.whatsapp_connection_key_envelopes connection_keys
    ON connection_keys.personal_account_id=media.personal_account_id AND connection_keys.whatsapp_connection_id=media.whatsapp_connection_id
  JOIN public.personal_account_key_envelopes account_keys
    ON account_keys.personal_account_id=media.personal_account_id AND account_keys.key_version=connection_keys.account_key_version
  JOIN public.whatsapp_connection_provider_sessions sessions
    ON sessions.personal_account_id=media.personal_account_id AND sessions.whatsapp_connection_id=media.whatsapp_connection_id
      AND sessions.authority_key_version=connection_keys.key_version
  WHERE media.state='pending' AND account_keys.unavailable_at IS NULL AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL AND connection_keys.ciphertext IS NOT NULL
    AND sessions.authority_ciphertext IS NOT NULL
  ORDER BY media.created_at, media.id LIMIT requested_limit;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_pending_stored_media(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_pending_stored_media(integer) TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.list_stored_media_object_deletions(requested_limit integer)
RETURNS TABLE (personal_account_id uuid, object_key text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, public AS $function$
  SELECT deletions.personal_account_id, deletions.object_key
  FROM public.stored_media_object_deletions deletions
  ORDER BY deletions.requested_at, deletions.object_key LIMIT requested_limit;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_stored_media_object_deletions(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_stored_media_object_deletions(integer) TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.stored_messages
  ALTER COLUMN webhook_item_identity DROP NOT NULL;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE
  ON public.whatsapp_conversations, public.stored_messages
  TO whatsapp_webhook_runtime;
--> statement-breakpoint

GRANT SELECT (recipient_type, recipient_public_id)
  ON public.send_operations TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT (key_version, nonce, ciphertext, expires_at)
  ON public.pending_send_contents TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT (personal_account_id, whatsapp_connection_id, public_id, provider_identity_index)
  ON public.directory_contacts TO whatsapp_webhook_runtime;
--> statement-breakpoint
GRANT SELECT (personal_account_id, whatsapp_connection_id, public_id, provider_locator)
  ON public.whatsapp_groups TO whatsapp_webhook_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.tool_call_logs
  ADD COLUMN media_bytes_reserved bigint NOT NULL DEFAULT 0
    CHECK (media_bytes_reserved >= 0),
  ADD CONSTRAINT tool_call_logs_media_reservation
    CHECK (
      (tool_name = 'read_stored_media' AND quota_reserved)
      OR (tool_name <> 'read_stored_media' AND media_bytes_reserved = 0)
    );
--> statement-breakpoint

CREATE INDEX tool_call_logs_media_quota
ON public.tool_call_logs (personal_account_id, started_at)
INCLUDE (media_bytes_reserved)
WHERE media_bytes_reserved > 0;
--> statement-breakpoint

CREATE FUNCTION public.load_protected_stored_media(
  candidate_authorization_id uuid,
  candidate_connection_public_id text,
  candidate_message_public_id text,
  candidate_media_public_id text
)
RETURNS TABLE (
  media_id uuid, object_key text, plaintext_size_bytes bigint,
  metadata_ciphertext_version smallint, metadata_key_version integer,
  metadata_nonce bytea, metadata_ciphertext bytea,
  account_key_version integer, kms_key_id text, account_key_ciphertext bytea,
  connection_account_key_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea, connection_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, public
AS $function$
  SELECT media.id,media.object_key,media.plaintext_size_bytes,
    media.metadata_ciphertext_version,media.metadata_key_version,media.metadata_nonce,media.metadata_ciphertext,
    keys.key_version,keys.kms_key_id,keys.ciphertext,
    connection_keys.account_key_version,connection_keys.key_version,connection_keys.nonce,
    connection_keys.ciphertext,connections.id
  FROM public.stored_media media
  JOIN public.stored_messages messages ON messages.personal_account_id=media.personal_account_id
    AND messages.whatsapp_connection_id=media.whatsapp_connection_id AND messages.id=media.stored_message_id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id=media.personal_account_id
    AND connections.id=media.whatsapp_connection_id
  JOIN public.mcp_authorization_connections selected ON selected.personal_account_id=media.personal_account_id
    AND selected.whatsapp_connection_id=media.whatsapp_connection_id
    AND selected.mcp_authorization_id=candidate_authorization_id
  JOIN public.whatsapp_connection_key_envelopes connection_keys ON connection_keys.personal_account_id=media.personal_account_id
    AND connection_keys.whatsapp_connection_id=media.whatsapp_connection_id
  JOIN public.personal_account_key_envelopes keys ON keys.personal_account_id=media.personal_account_id
    AND keys.key_version=connection_keys.account_key_version
  WHERE media.personal_account_id=nullif(pg_catalog.current_setting('public.personal_account_id',true),'')::uuid
    AND connections.public_id=candidate_connection_public_id
    AND messages.public_id=candidate_message_public_id
    AND media.public_id=candidate_media_public_id AND media.state='ready'
    AND media.plaintext_size_bytes <= 16777216 AND messages.deleted_at IS NULL
    AND connections.state <> 'deleting' AND keys.unavailable_at IS NULL
    AND keys.ciphertext IS NOT NULL AND connection_keys.unavailable_at IS NULL
    AND connection_keys.ciphertext IS NOT NULL;
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.load_protected_stored_media(uuid,text,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.load_protected_stored_media(uuid,text,text,text) TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.whatsapp_connections
  ADD COLUMN message_retention_days smallint DEFAULT 30
    CHECK (message_retention_days IS NULL OR message_retention_days > 0),
  ADD COLUMN message_retention_updated_at timestamptz NOT NULL DEFAULT transaction_timestamp();
--> statement-breakpoint

ALTER TABLE public.stored_messages
  ADD COLUMN content_expired_at timestamptz;
--> statement-breakpoint

ALTER TABLE public.stored_messages DROP CONSTRAINT stored_messages_content_or_tombstone;
--> statement-breakpoint
ALTER TABLE public.stored_messages ADD CONSTRAINT stored_messages_content_lifecycle CHECK (
  (deleted_at IS NULL AND content_expired_at IS NULL AND content_type IS NOT NULL
    AND content_ciphertext_version IS NOT NULL AND content_key_version IS NOT NULL
    AND content_nonce IS NOT NULL AND content_ciphertext IS NOT NULL)
  OR
  ((deleted_at IS NOT NULL OR content_expired_at IS NOT NULL) AND content_type IS NULL
    AND content_ciphertext_version IS NULL AND content_key_version IS NULL
    AND content_nonce IS NULL AND content_ciphertext IS NULL)
);
--> statement-breakpoint

CREATE FUNCTION public.preserve_expired_message_content_state()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF OLD.content_expired_at IS NOT NULL THEN
    NEW.content_type := NULL;
    NEW.content_ciphertext_version := NULL;
    NEW.content_key_version := NULL;
    NEW.content_nonce := NULL;
    NEW.content_ciphertext := NULL;
    NEW.content_expired_at := OLD.content_expired_at;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.load_protected_stored_media(
  candidate_authorization_id uuid, candidate_connection_public_id text,
  candidate_message_public_id text, candidate_media_public_id text
)
RETURNS TABLE (
  media_id uuid, object_key text, plaintext_size_bytes bigint,
  metadata_ciphertext_version smallint, metadata_key_version integer,
  metadata_nonce bytea, metadata_ciphertext bytea,
  account_key_version integer, kms_key_id text, account_key_ciphertext bytea,
  connection_account_key_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea, connection_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, public AS $function$
  SELECT media.id,media.object_key,media.plaintext_size_bytes,
    media.metadata_ciphertext_version,media.metadata_key_version,media.metadata_nonce,media.metadata_ciphertext,
    keys.key_version,keys.kms_key_id,keys.ciphertext,
    connection_keys.account_key_version,connection_keys.key_version,connection_keys.nonce,
    connection_keys.ciphertext,connections.id
  FROM public.stored_media media
  JOIN public.stored_messages messages ON messages.personal_account_id=media.personal_account_id
    AND messages.whatsapp_connection_id=media.whatsapp_connection_id AND messages.id=media.stored_message_id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id=media.personal_account_id
    AND connections.id=media.whatsapp_connection_id
  JOIN public.mcp_authorization_connections selected ON selected.personal_account_id=media.personal_account_id
    AND selected.whatsapp_connection_id=media.whatsapp_connection_id
    AND selected.mcp_authorization_id=candidate_authorization_id
  JOIN public.whatsapp_connection_key_envelopes connection_keys ON connection_keys.personal_account_id=media.personal_account_id
    AND connection_keys.whatsapp_connection_id=media.whatsapp_connection_id
  JOIN public.personal_account_key_envelopes keys ON keys.personal_account_id=media.personal_account_id
    AND keys.key_version=connection_keys.account_key_version
  WHERE media.personal_account_id=nullif(pg_catalog.current_setting('public.personal_account_id',true),'')::uuid
    AND connections.public_id=candidate_connection_public_id
    AND messages.public_id=candidate_message_public_id
    AND media.public_id=candidate_media_public_id AND media.state='ready'
    AND media.plaintext_size_bytes<=16777216 AND messages.deleted_at IS NULL
    AND messages.content_expired_at IS NULL
    AND (connections.message_retention_days IS NULL OR
      messages.sent_at + make_interval(days => connections.message_retention_days)>transaction_timestamp())
    AND connections.state<>'deleting' AND keys.unavailable_at IS NULL
    AND keys.ciphertext IS NOT NULL AND connection_keys.unavailable_at IS NULL
    AND connection_keys.ciphertext IS NOT NULL;
$function$;
--> statement-breakpoint
CREATE TRIGGER preserve_expired_message_content_state
BEFORE UPDATE ON public.stored_messages FOR EACH ROW
EXECUTE FUNCTION public.preserve_expired_message_content_state();
--> statement-breakpoint

CREATE FUNCTION public.prevent_media_for_unavailable_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
BEGIN
  PERFORM 1 FROM public.stored_messages messages
  WHERE messages.personal_account_id=NEW.personal_account_id
    AND messages.whatsapp_connection_id=NEW.whatsapp_connection_id
    AND messages.id=NEW.stored_message_id
    AND messages.deleted_at IS NULL AND messages.content_expired_at IS NULL
  FOR KEY SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER prevent_media_for_unavailable_message
BEFORE INSERT ON public.stored_media FOR EACH ROW
EXECUTE FUNCTION public.prevent_media_for_unavailable_message();
--> statement-breakpoint

ALTER TABLE public.stored_media DROP CONSTRAINT stored_media_state_check;
--> statement-breakpoint
ALTER TABLE public.stored_media ADD CONSTRAINT stored_media_state_check
  CHECK (state IN ('pending','ready','purging','rejected','failed'));
--> statement-breakpoint
ALTER TABLE public.stored_media DROP CONSTRAINT stored_media_check;
--> statement-breakpoint
ALTER TABLE public.stored_media ADD CONSTRAINT stored_media_lifecycle_check CHECK (
  (state = 'pending' AND source_ciphertext IS NOT NULL AND source_nonce IS NOT NULL
    AND source_key_version IS NOT NULL AND source_ciphertext_version IS NOT NULL
    AND object_key IS NULL AND plaintext_size_bytes IS NULL AND sha256 IS NULL
    AND metadata_ciphertext IS NULL AND failure_code IS NULL)
  OR
  (state IN ('ready','purging') AND source_ciphertext IS NULL AND source_nonce IS NULL
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
);
--> statement-breakpoint

GRANT SELECT (message_retention_days, message_retention_updated_at),
  UPDATE (message_retention_days, message_retention_updated_at)
  ON public.whatsapp_connections TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT (content_expired_at), UPDATE (content_type, content_ciphertext_version,
  content_key_version, content_nonce, content_ciphertext, content_expired_at)
  ON public.stored_messages TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.get_message_retention_policy(
  verified_clerk_user_id text, requested_connection_public_id text
)
RETURNS TABLE (retention_days smallint, retention_updated_at timestamptz)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, public, public AS $function$
  SELECT connections.message_retention_days, connections.message_retention_updated_at
  FROM public.clerk_identities identities
  JOIN public.personal_accounts accounts ON accounts.id=identities.personal_account_id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id=accounts.id
  WHERE identities.clerk_user_id=verified_clerk_user_id AND accounts.state='active'
    AND connections.public_id=requested_connection_public_id AND connections.state<>'deleting';
$function$;
--> statement-breakpoint

CREATE FUNCTION public.update_message_retention_policy(
  verified_clerk_user_id text, requested_connection_public_id text,
  expected_days smallint, requested_days smallint, requested_updated_at timestamptz
)
RETURNS TABLE (retention_days smallint, retention_updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, public AS $function$
DECLARE selected_account_id uuid; selected_connection_id uuid;
BEGIN
  SELECT accounts.id,connections.id INTO selected_account_id,selected_connection_id
  FROM public.clerk_identities identities
  JOIN public.personal_accounts accounts ON accounts.id=identities.personal_account_id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id=accounts.id
  WHERE identities.clerk_user_id=verified_clerk_user_id AND accounts.state='active'
    AND connections.public_id=requested_connection_public_id AND connections.state<>'deleting'
    AND connections.message_retention_days IS NOT DISTINCT FROM expected_days
  FOR UPDATE OF connections;
  IF selected_connection_id IS NULL THEN RETURN; END IF;
  UPDATE public.whatsapp_connections SET message_retention_days=requested_days,
    message_retention_updated_at=requested_updated_at
  WHERE personal_account_id=selected_account_id AND id=selected_connection_id;
  UPDATE public.pending_send_contents pending SET expires_at=LEAST(
    operations.created_at + interval '7 days',
    CASE WHEN requested_days IS NULL THEN operations.created_at + interval '7 days'
      ELSE operations.created_at + make_interval(days => requested_days) END)
  FROM public.send_operations operations
  WHERE pending.personal_account_id=selected_account_id
    AND pending.whatsapp_connection_id=selected_connection_id
    AND operations.personal_account_id=pending.personal_account_id
    AND operations.id=pending.send_operation_id AND pending.expires_at>requested_updated_at;
  RETURN QUERY SELECT requested_days,requested_updated_at;
END
$function$;
--> statement-breakpoint

-- Expiry keeps identity, ordering, tombstones, gaps, replay bindings and audit rows.
-- Ready media first becomes unreadable and quota remains charged until object deletion succeeds.
CREATE FUNCTION public.purge_expired_message_content(observed_at timestamptz, requested_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, public AS $function$
DECLARE candidate record; purged integer := 0;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN RAISE EXCEPTION 'invalid retention purge limit'; END IF;
  DELETE FROM public.pending_send_contents pending USING public.whatsapp_connections connections,
    public.send_operations operations
  WHERE pending.personal_account_id=connections.personal_account_id
    AND pending.whatsapp_connection_id=connections.id
    AND operations.personal_account_id=pending.personal_account_id
    AND operations.id=pending.send_operation_id
    AND (pending.expires_at<=observed_at OR (connections.message_retention_days IS NOT NULL
      AND operations.created_at + make_interval(days => connections.message_retention_days)<=observed_at));
  FOR candidate IN
    SELECT messages.personal_account_id,messages.whatsapp_connection_id,messages.conversation_id,messages.id
    FROM public.stored_messages messages
    JOIN public.whatsapp_connections connections ON connections.personal_account_id=messages.personal_account_id
      AND connections.id=messages.whatsapp_connection_id
    WHERE messages.content_expired_at IS NULL AND messages.deleted_at IS NULL
      AND connections.message_retention_days IS NOT NULL
      AND messages.sent_at + make_interval(days => connections.message_retention_days)<=observed_at
    ORDER BY messages.sent_at,messages.id FOR UPDATE OF messages SKIP LOCKED LIMIT requested_limit
  LOOP
    DELETE FROM public.stored_media WHERE personal_account_id=candidate.personal_account_id
      AND whatsapp_connection_id=candidate.whatsapp_connection_id AND stored_message_id=candidate.id
      AND state IN ('pending','rejected','failed');
    INSERT INTO public.stored_media_object_deletions(personal_account_id,object_key,requested_at)
      SELECT personal_account_id,object_key,observed_at FROM public.stored_media
      WHERE personal_account_id=candidate.personal_account_id
        AND whatsapp_connection_id=candidate.whatsapp_connection_id
        AND stored_message_id=candidate.id AND state='ready'
      ON CONFLICT DO NOTHING;
    UPDATE public.stored_media SET state='purging',updated_at=observed_at
      WHERE personal_account_id=candidate.personal_account_id
        AND whatsapp_connection_id=candidate.whatsapp_connection_id
        AND stored_message_id=candidate.id AND state='ready';
    UPDATE public.stored_messages SET content_type=NULL,content_ciphertext_version=NULL,
      content_key_version=NULL,content_nonce=NULL,content_ciphertext=NULL,content_expired_at=observed_at,
      updated_at=observed_at WHERE personal_account_id=candidate.personal_account_id AND id=candidate.id;
    UPDATE public.whatsapp_conversations conversations SET
      last_activity_at=latest.sent_at,last_activity_direction=latest.direction,updated_at=observed_at
    FROM (SELECT sent_at,direction FROM public.stored_messages
      WHERE personal_account_id=candidate.personal_account_id
        AND whatsapp_connection_id=candidate.whatsapp_connection_id
        AND conversation_id=candidate.conversation_id AND content_expired_at IS NULL
      ORDER BY sent_at DESC,public_id DESC LIMIT 1) latest
    WHERE conversations.personal_account_id=candidate.personal_account_id
      AND conversations.whatsapp_connection_id=candidate.whatsapp_connection_id
      AND conversations.id=candidate.conversation_id;
    purged := purged + 1;
  END LOOP;
  RETURN purged;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.finish_stored_media_object_deletion(requested_account_id uuid, requested_object_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, public AS $function$
DECLARE released_bytes bigint;
BEGIN
  PERFORM 1 FROM public.personal_accounts WHERE id=requested_account_id FOR UPDATE;
  SELECT plaintext_size_bytes INTO released_bytes FROM public.stored_media
    WHERE personal_account_id=requested_account_id AND object_key=requested_object_key AND state='purging' FOR UPDATE;
  IF released_bytes IS NOT NULL THEN
    DELETE FROM public.stored_media WHERE personal_account_id=requested_account_id
      AND object_key=requested_object_key AND state='purging';
    UPDATE public.personal_accounts SET stored_media_used_bytes=stored_media_used_bytes-released_bytes
      WHERE id=requested_account_id;
  END IF;
  DELETE FROM public.stored_media_object_deletions WHERE personal_account_id=requested_account_id
    AND object_key=requested_object_key;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.get_message_retention_policy(text,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.update_message_retention_policy(text,text,smallint,smallint,timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_expired_message_content(timestamptz,integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finish_stored_media_object_deletion(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_message_retention_policy(text,text),
  public.update_message_retention_policy(text,text,smallint,smallint,timestamptz),
  public.purge_expired_message_content(timestamptz,integer),
  public.finish_stored_media_object_deletion(uuid,text) TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.load_mcp_message_read_material(
  requested_authorization_id uuid, requested_oauth_subject text, requested_client_id text,
  requested_at timestamptz, requested_connection_public_id text,
  requested_conversation_public_id text
)
RETURNS TABLE (
  connection_id uuid, connection_created_at timestamptz, message_retention_days integer,
  personal_account_id uuid,
  account_key_version integer, account_kms_key_id text, account_key_ciphertext bytea,
  connection_key_account_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea
)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
  SELECT connections.id,connections.created_at,connections.message_retention_days,
    connections.personal_account_id,
    account_keys.key_version,account_keys.kms_key_id,account_keys.ciphertext,
    connection_keys.account_key_version,connection_keys.key_version,connection_keys.nonce,connection_keys.ciphertext
  FROM public.mcp_authorizations authorizations
  JOIN public.mcp_authorization_connections selected ON selected.personal_account_id=authorizations.personal_account_id
    AND selected.mcp_authorization_id=authorizations.id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id=selected.personal_account_id
    AND connections.id=selected.whatsapp_connection_id
  JOIN public.whatsapp_conversations conversations ON conversations.personal_account_id=connections.personal_account_id
    AND conversations.whatsapp_connection_id=connections.id
  JOIN public.personal_account_key_envelopes account_keys ON account_keys.personal_account_id=connections.personal_account_id
  JOIN public.whatsapp_connection_key_envelopes connection_keys ON connection_keys.personal_account_id=connections.personal_account_id
    AND connection_keys.whatsapp_connection_id=connections.id AND connection_keys.account_key_version=account_keys.key_version
  JOIN public.personal_accounts accounts ON accounts.id=authorizations.personal_account_id
  WHERE authorizations.id=requested_authorization_id
    AND authorizations.oauth_subject=requested_oauth_subject
    AND (requested_client_id IS NULL OR authorizations.client_id=requested_client_id)
    AND authorizations.personal_account_id=nullif(pg_catalog.current_setting('public.personal_account_id',true),'')::uuid
    AND authorizations.state='active' AND authorizations.refresh_family_state='active'
    AND authorizations.absolute_expires_at>requested_at AND accounts.state='active'
    AND EXISTS (SELECT 1 FROM public.clerk_identities identities
      WHERE identities.personal_account_id=authorizations.personal_account_id)
    AND 'messages:read'=ANY(authorizations.scopes)
    AND connections.public_id=requested_connection_public_id
    AND conversations.public_id=requested_conversation_public_id AND connections.state<>'deleting'
    AND account_keys.unavailable_at IS NULL AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL AND connection_keys.ciphertext IS NOT NULL;
$function$;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.whatsapp_connections
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_marker_id text
    CHECK (deletion_marker_id ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT whatsapp_connection_deletion_metadata_complete CHECK (
    (deletion_requested_at IS NULL AND deletion_marker_id IS NULL)
    OR (state = 'deleting' AND deletion_requested_at IS NOT NULL AND deletion_marker_id IS NOT NULL)
  );
--> statement-breakpoint

CREATE FUNCTION public.prepare_whatsapp_connection_deletion(
  verified_clerk_user_id text,
  requested_public_id text
)
RETURNS TABLE (
  outcome text, public_id text, deletion_requested_at timestamptz,
  deletion_marker_id text, personal_account_id uuid, whatsapp_connection_id uuid,
  account_key_version integer, account_kms_key_id text, account_key_ciphertext bytea,
  connection_key_account_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea,
  locator_ciphertext_version smallint, locator_key_version integer,
  locator_nonce bytea, locator_ciphertext bytea
)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE WHEN connections.state = 'deleting' THEN 'complete' ELSE 'prepared' END,
    connections.public_id, connections.deletion_requested_at, connections.deletion_marker_id,
    connections.personal_account_id, connections.id,
    account_keys.key_version, account_keys.kms_key_id, account_keys.ciphertext,
    connection_keys.account_key_version, connection_keys.key_version,
    connection_keys.nonce, connection_keys.ciphertext,
    sessions.locator_ciphertext_version, sessions.locator_key_version,
    sessions.locator_nonce, sessions.locator_ciphertext
  FROM public.clerk_identities identities
  JOIN public.personal_accounts accounts ON accounts.id = identities.personal_account_id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id = accounts.id
  LEFT JOIN public.personal_account_key_envelopes account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
  LEFT JOIN public.whatsapp_connection_key_envelopes connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  LEFT JOIN public.whatsapp_connection_provider_sessions sessions
    ON sessions.personal_account_id = connections.personal_account_id
   AND sessions.whatsapp_connection_id = connections.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND connections.public_id = requested_public_id
    AND accounts.state = 'active'
    AND (connections.state = 'deleting' OR (
      account_keys.unavailable_at IS NULL AND account_keys.ciphertext IS NOT NULL
      AND connection_keys.unavailable_at IS NULL AND connection_keys.ciphertext IS NOT NULL
      AND sessions.locator_ciphertext IS NOT NULL
    ))
$function$;
--> statement-breakpoint

CREATE FUNCTION public.finish_whatsapp_connection_deletion(
  verified_clerk_user_id text, requested_public_id text,
  requested_marker_id text, requested_at timestamptz
)
RETURNS TABLE (public_id text, deletion_requested_at timestamptz, deletion_marker_id text)
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE connection public.whatsapp_connections%ROWTYPE;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$' THEN RAISE invalid_parameter_value; END IF;
  SELECT connections.* INTO connection
  FROM public.whatsapp_connections connections
  JOIN public.clerk_identities identities ON identities.personal_account_id=connections.personal_account_id
  JOIN public.personal_accounts accounts ON accounts.id=connections.personal_account_id
  WHERE identities.clerk_user_id=verified_clerk_user_id
    AND connections.public_id=requested_public_id AND accounts.state='active'
  FOR UPDATE OF connections;
  IF NOT FOUND THEN RETURN; END IF;
  IF connection.state='deleting' THEN
    IF connection.deletion_marker_id IS DISTINCT FROM requested_marker_id THEN RAISE invalid_parameter_value; END IF;
  ELSE
    DELETE FROM public.mcp_authorization_connections selected
      WHERE selected.personal_account_id=connection.personal_account_id
        AND selected.whatsapp_connection_id=connection.id;
    UPDATE public.whatsapp_connection_key_envelopes keys
      SET account_key_version=NULL, key_version=NULL, nonce=NULL, ciphertext=NULL, unavailable_at=requested_at
      WHERE keys.personal_account_id=connection.personal_account_id
        AND keys.whatsapp_connection_id=connection.id AND keys.unavailable_at IS NULL;
    UPDATE public.whatsapp_connections connections SET state='deleting', desired_state='disconnected',
      deletion_requested_at=requested_at, deletion_marker_id=requested_marker_id,
      lifecycle_claim_id=NULL, lifecycle_lease_expires_at=NULL,
      state_changed_at=greatest(connections.state_changed_at,requested_at),
      updated_at=greatest(connections.updated_at,requested_at)
      WHERE connections.id=connection.id RETURNING connections.* INTO connection;
  END IF;
  RETURN QUERY SELECT connection.public_id, connection.deletion_requested_at, connection.deletion_marker_id;
END $function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.prepare_whatsapp_connection_deletion(text,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finish_whatsapp_connection_deletion(text,text,text,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.prepare_whatsapp_connection_deletion(text,text) TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.finish_whatsapp_connection_deletion(text,text,text,timestamptz) TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'whatsapp_deletion_runtime') THEN
    CREATE ROLE whatsapp_deletion_runtime LOGIN;
  END IF;
  ALTER ROLE whatsapp_deletion_runtime
    NOREPLICATION NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'whatsapp_deletion_runtime'
      AND (rolsuper OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'deletion runtime role has prohibited privileged attributes';
  END IF;
END
$role$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO whatsapp_deletion_runtime;
--> statement-breakpoint
GRANT SELECT ON public.drizzle_migrations TO whatsapp_deletion_runtime;
--> statement-breakpoint

CREATE TABLE public.deleted_whatsapp_connection_handles (
  public_id text PRIMARY KEY CHECK (public_id ~ '^con_[A-Za-z0-9_-]{21}$'),
  deletion_marker_id text NOT NULL UNIQUE CHECK (deletion_marker_id ~ '^[a-f0-9]{64}$'),
  deleted_at timestamptz NOT NULL
);
--> statement-breakpoint

ALTER TABLE public.whatsapp_connections
  ADD COLUMN provider_absence_confirmed_at timestamptz,
  ADD CONSTRAINT whatsapp_connection_provider_absence_after_deletion CHECK (
    provider_absence_confirmed_at IS NULL
    OR (state = 'deleting' AND provider_absence_confirmed_at >= deletion_requested_at)
  );
--> statement-breakpoint

CREATE FUNCTION public.reject_deleted_whatsapp_connection_handle()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.deleted_whatsapp_connection_handles deleted
    WHERE deleted.public_id = NEW.public_id
  ) THEN
    RAISE EXCEPTION 'deleted WhatsApp Connection handle cannot be reused'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER reject_deleted_whatsapp_connection_handle
BEFORE INSERT OR UPDATE OF public_id ON public.whatsapp_connections
FOR EACH ROW EXECUTE FUNCTION public.reject_deleted_whatsapp_connection_handle();
--> statement-breakpoint

CREATE FUNCTION public.list_whatsapp_connection_deletion_candidates(
  observed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  deletion_marker_id text,
  requested_at timestamptz,
  deadline_at timestamptz,
  deadline_risk boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid Connection Deletion candidate limit';
  END IF;
  RETURN QUERY
  SELECT connections.deletion_marker_id, connections.deletion_requested_at,
    connections.deletion_requested_at + interval '24 hours',
    observed_at >= connections.deletion_requested_at + interval '23 hours'
  FROM public.whatsapp_connections connections
  WHERE connections.state = 'deleting'
  ORDER BY connections.deletion_requested_at, connections.deletion_marker_id
  LIMIT requested_limit;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.confirm_whatsapp_connection_provider_absence(
  requested_marker_id text,
  confirmed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  UPDATE public.whatsapp_connections connections
  SET provider_absence_confirmed_at = COALESCE(
    connections.provider_absence_confirmed_at,
    confirmed_at
  )
  WHERE connections.deletion_marker_id = requested_marker_id
    AND connections.state = 'deleting'
    AND confirmed_at >= connections.deletion_requested_at;
  RETURN FOUND OR EXISTS (
    SELECT 1 FROM public.deleted_whatsapp_connection_handles deleted
    WHERE deleted.deletion_marker_id = requested_marker_id
  );
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.list_whatsapp_connection_active_purge_candidates(
  observed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  deletion_marker_id text,
  requested_at timestamptz,
  deadline_at timestamptz,
  deadline_risk boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid Connection Deletion purge limit';
  END IF;
  RETURN QUERY SELECT connections.deletion_marker_id,
    connections.deletion_requested_at,
    connections.deletion_requested_at + interval '24 hours',
    observed_at >= connections.deletion_requested_at + interval '23 hours'
  FROM public.whatsapp_connections connections
  WHERE connections.state = 'deleting'
    AND connections.provider_absence_confirmed_at IS NOT NULL
  ORDER BY connections.deletion_requested_at, connections.deletion_marker_id
  LIMIT requested_limit;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.prepare_whatsapp_connection_cleanup(
  requested_marker_id text,
  requested_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  personal_account_id uuid,
  stored_media_object_keys text[],
  webhook_source_object_keys text[]
)
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_connection public.whatsapp_connections%ROWTYPE;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid Connection Deletion object limit';
  END IF;
  SELECT connections.* INTO selected_connection
  FROM public.whatsapp_connections connections
  WHERE connections.deletion_marker_id = requested_marker_id
    AND connections.state = 'deleting'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF selected_connection.provider_absence_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'provider absence is not confirmed';
  END IF;

  DELETE FROM public.stored_media media
  WHERE media.whatsapp_connection_id = selected_connection.id
    AND media.state IN ('pending','rejected','failed');
  INSERT INTO public.stored_media_object_deletions(
    personal_account_id, object_key, requested_at
  )
  SELECT media.personal_account_id, media.object_key, requested_at
  FROM public.stored_media media
  WHERE media.whatsapp_connection_id = selected_connection.id
    AND media.state = 'ready'
  ON CONFLICT DO NOTHING;
  UPDATE public.stored_media media SET state = 'purging', updated_at = requested_at
  WHERE media.whatsapp_connection_id = selected_connection.id
    AND media.state = 'ready';

  RETURN QUERY SELECT selected_connection.personal_account_id,
    COALESCE((
      SELECT array_agg(candidates.object_key ORDER BY candidates.object_key)
      FROM (
        SELECT deletions.object_key
        FROM public.stored_media_object_deletions deletions
        JOIN public.stored_media media
          ON media.personal_account_id = deletions.personal_account_id
         AND media.object_key = deletions.object_key
        WHERE media.whatsapp_connection_id = selected_connection.id
        ORDER BY deletions.object_key
        LIMIT requested_limit
      ) candidates
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(candidates.object_key ORDER BY candidates.object_key)
      FROM (
        SELECT 'webhook-events/' || events.id::text AS object_key
        FROM public.webhook_events events
        WHERE events.whatsapp_connection_id = selected_connection.id
        ORDER BY events.id
        LIMIT requested_limit
      ) candidates
    ), ARRAY[]::text[]);
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.finish_whatsapp_connection_webhook_source_deletion(
  requested_marker_id text,
  requested_object_key text
)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE requested_event_id uuid;
BEGIN
  IF requested_object_key !~ '^webhook-events/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid Webhook Event source object key';
  END IF;
  requested_event_id := substring(requested_object_key FROM 16)::uuid;
  DELETE FROM public.webhook_events events
  USING public.whatsapp_connections connections
  WHERE connections.deletion_marker_id = requested_marker_id
    AND connections.state = 'deleting'
    AND connections.provider_absence_confirmed_at IS NOT NULL
    AND events.personal_account_id = connections.personal_account_id
    AND events.whatsapp_connection_id = connections.id
    AND events.id = requested_event_id;
  RETURN FOUND OR NOT EXISTS (
    SELECT 1 FROM public.webhook_events events WHERE events.id = requested_event_id
  );
END
$function$;
--> statement-breakpoint

-- Called only after provider-control has confirmed absence and both R2 source
-- classes are unavailable. Keeping this final mutation in one definer function
-- avoids granting broad table mutation authority to the API runtime.
CREATE FUNCTION public.finish_whatsapp_connection_cleanup(
  requested_marker_id text,
  provider_absence_confirmed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_connection public.whatsapp_connections%ROWTYPE;
DECLARE selected_setup_id text;
BEGIN
  SELECT connections.* INTO selected_connection
  FROM public.whatsapp_connections connections
  WHERE connections.deletion_marker_id = requested_marker_id
    AND connections.state = 'deleting'
    AND connections.provider_absence_confirmed_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN EXISTS (
      SELECT 1 FROM public.deleted_whatsapp_connection_handles deleted
      WHERE deleted.deletion_marker_id = requested_marker_id
    );
  END IF;
  IF provider_absence_confirmed_at < selected_connection.provider_absence_confirmed_at THEN
    RAISE EXCEPTION 'cleanup observation predates provider absence';
  END IF;

  -- Ready Stored Media must first pass through object deletion so quota is
  -- released only after the object is unavailable.
  IF EXISTS (
    SELECT 1 FROM public.stored_media media
    WHERE media.whatsapp_connection_id = selected_connection.id
  ) OR EXISTS (
    SELECT 1 FROM public.webhook_events events
    WHERE events.whatsapp_connection_id = selected_connection.id
  ) THEN
    RETURN false;
  END IF;

  selected_setup_id := selected_connection.connection_setup_id;
  INSERT INTO public.deleted_whatsapp_connection_handles(
    public_id, deletion_marker_id, deleted_at
  ) VALUES (
    selected_connection.public_id, requested_marker_id,
    selected_connection.provider_absence_confirmed_at
  ) ON CONFLICT (deletion_marker_id) DO NOTHING;

  DELETE FROM public.tool_call_logs logs
  USING public.send_operations operations
  WHERE operations.tool_call_log_id = logs.id
    AND operations.whatsapp_connection_id = selected_connection.id;

  DELETE FROM public.webhook_item_quarantines quarantines
  WHERE quarantines.whatsapp_connection_id = selected_connection.id;
  DELETE FROM public.webhook_items items
  WHERE items.whatsapp_connection_id = selected_connection.id;

  UPDATE public.whatsapp_connections SET connection_setup_id = NULL
  WHERE id = selected_connection.id;
  DELETE FROM public.whatsapp_connections WHERE id = selected_connection.id;

  IF selected_setup_id IS NOT NULL THEN
    DELETE FROM public.whatsapp_number_reservations
    WHERE connection_setup_id = selected_setup_id;
    DELETE FROM public.connection_setups WHERE id = selected_setup_id;
  END IF;
  RETURN true;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON TABLE public.deleted_whatsapp_connection_handles FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_whatsapp_connection_deletion_candidates(timestamptz,integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.confirm_whatsapp_connection_provider_absence(text,timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_whatsapp_connection_active_purge_candidates(timestamptz,integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prepare_whatsapp_connection_cleanup(text,timestamptz,integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finish_whatsapp_connection_webhook_source_deletion(text,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finish_whatsapp_connection_cleanup(text,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_whatsapp_connection_deletion_candidates(timestamptz,integer) TO whatsapp_deletion_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.confirm_whatsapp_connection_provider_absence(text,timestamptz) TO whatsapp_deletion_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_whatsapp_connection_active_purge_candidates(timestamptz,integer) TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.prepare_whatsapp_connection_cleanup(text,timestamptz,integer) TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.finish_whatsapp_connection_webhook_source_deletion(text,text) TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.finish_whatsapp_connection_cleanup(text,timestamptz) TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.personal_accounts
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_marker_id text CHECK (deletion_marker_id ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT personal_account_deletion_metadata_complete CHECK (
    (deletion_requested_at IS NULL AND deletion_marker_id IS NULL)
    OR (state = 'deleting' AND deletion_requested_at IS NOT NULL AND deletion_marker_id IS NULL)
    OR (state = 'deleting' AND deletion_requested_at IS NOT NULL AND deletion_marker_id IS NOT NULL)
  );
--> statement-breakpoint

CREATE FUNCTION public.prepare_personal_account_deletion(
  verified_clerk_user_id text,
  observed_at timestamptz
)
RETURNS TABLE (
  personal_account_id uuid,
  account_state text,
  requested_at timestamptz,
  connection_public_id text
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE selected_account_id uuid;
BEGIN
  SELECT accounts.id INTO selected_account_id
  FROM public.clerk_identities identities
  JOIN public.personal_accounts accounts
    ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
  FOR UPDATE OF accounts;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.personal_accounts accounts
  SET state = 'deleting', deletion_requested_at = observed_at,
      updated_at = greatest(accounts.updated_at, observed_at)
  WHERE accounts.id = selected_account_id
    AND accounts.deletion_requested_at IS NULL;
  UPDATE public.connection_setups setups
  SET state = 'cancelled', cleanup_state = 'pending',
      cleanup_lease_owner = NULL, cleanup_lease_expires_at = NULL,
      provisioning_lease_owner = NULL, provisioning_lease_expires_at = NULL,
      updated_at = greatest(setups.updated_at, observed_at)
  WHERE setups.personal_account_id = selected_account_id
    AND setups.state NOT IN ('activated', 'cancelled', 'expired');
  DELETE FROM public.mcp_authorization_connections selected
  WHERE selected.personal_account_id = selected_account_id;
  DELETE FROM public.mcp_refresh_credentials credentials
  WHERE credentials.personal_account_id = selected_account_id;
  UPDATE public.mcp_authorizations authorizations
  SET state = 'revoked', revoked_at = coalesce(authorizations.revoked_at, observed_at),
      refresh_family_state = 'revoked',
      refresh_family_revoked_at = coalesce(authorizations.refresh_family_revoked_at, observed_at)
  WHERE authorizations.personal_account_id = selected_account_id
    AND (authorizations.state <> 'revoked' OR authorizations.refresh_family_state <> 'revoked');
  RETURN QUERY
  SELECT accounts.id, accounts.state, accounts.deletion_requested_at, connections.public_id
  FROM public.personal_accounts accounts
  LEFT JOIN public.whatsapp_connections connections
    ON connections.personal_account_id = accounts.id
   AND connections.state <> 'deleting'
  WHERE accounts.id = selected_account_id
  ORDER BY connections.public_id;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.finish_personal_account_deletion(
  verified_clerk_user_id text,
  requested_marker_id text,
  requested_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  selected_account public.personal_accounts%ROWTYPE;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$' THEN
    RAISE invalid_parameter_value;
  END IF;

  SELECT accounts.* INTO selected_account
  FROM public.personal_accounts accounts
  JOIN public.clerk_identities identities
    ON identities.personal_account_id = accounts.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
  FOR UPDATE OF accounts;

  IF NOT FOUND THEN RETURN false; END IF;
  IF selected_account.deletion_marker_id IS NOT NULL THEN
    RETURN selected_account.deletion_marker_id = requested_marker_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.whatsapp_connections connections
    WHERE connections.personal_account_id = selected_account.id
      AND connections.state <> 'deleting'
  ) THEN
    RAISE object_not_in_prerequisite_state;
  END IF;

  UPDATE public.personal_account_key_envelopes keys
  SET ciphertext = NULL, unavailable_at = coalesce(keys.unavailable_at, requested_at)
  WHERE keys.personal_account_id = selected_account.id;
  UPDATE public.personal_accounts accounts
  SET deletion_marker_id = requested_marker_id,
      updated_at = greatest(accounts.updated_at, requested_at)
  WHERE accounts.id = selected_account.id;
  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.prepare_whatsapp_connection_deletion(
  verified_clerk_user_id text, requested_public_id text
)
RETURNS TABLE (
  outcome text, public_id text, deletion_requested_at timestamptz,
  deletion_marker_id text, personal_account_id uuid, whatsapp_connection_id uuid,
  account_key_version integer, account_kms_key_id text, account_key_ciphertext bytea,
  connection_key_account_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea,
  locator_ciphertext_version smallint, locator_key_version integer,
  locator_nonce bytea, locator_ciphertext bytea
)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE WHEN connections.state = 'deleting' THEN 'complete' ELSE 'prepared' END,
    connections.public_id, connections.deletion_requested_at, connections.deletion_marker_id,
    connections.personal_account_id, connections.id,
    account_keys.key_version, account_keys.kms_key_id, account_keys.ciphertext,
    connection_keys.account_key_version, connection_keys.key_version,
    connection_keys.nonce, connection_keys.ciphertext,
    sessions.locator_ciphertext_version, sessions.locator_key_version,
    sessions.locator_nonce, sessions.locator_ciphertext
  FROM public.clerk_identities identities
  JOIN public.personal_accounts accounts ON accounts.id = identities.personal_account_id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id = accounts.id
  LEFT JOIN public.personal_account_key_envelopes account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
  LEFT JOIN public.whatsapp_connection_key_envelopes connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  LEFT JOIN public.whatsapp_connection_provider_sessions sessions
    ON sessions.personal_account_id = connections.personal_account_id
   AND sessions.whatsapp_connection_id = connections.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND connections.public_id = requested_public_id
    AND accounts.state IN ('active', 'deleting')
    AND (connections.state = 'deleting' OR (
      account_keys.unavailable_at IS NULL AND account_keys.ciphertext IS NOT NULL
      AND connection_keys.unavailable_at IS NULL AND connection_keys.ciphertext IS NOT NULL
      AND sessions.locator_ciphertext IS NOT NULL
    ))
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.finish_whatsapp_connection_deletion(
  verified_clerk_user_id text, requested_public_id text,
  requested_marker_id text, requested_at timestamptz
)
RETURNS TABLE (public_id text, deletion_requested_at timestamptz, deletion_marker_id text)
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE connection public.whatsapp_connections%ROWTYPE;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$' THEN RAISE invalid_parameter_value; END IF;
  SELECT connections.* INTO connection
  FROM public.whatsapp_connections connections
  JOIN public.clerk_identities identities ON identities.personal_account_id=connections.personal_account_id
  JOIN public.personal_accounts accounts ON accounts.id=connections.personal_account_id
  WHERE identities.clerk_user_id=verified_clerk_user_id
    AND connections.public_id=requested_public_id AND accounts.state IN ('active','deleting')
  FOR UPDATE OF connections;
  IF NOT FOUND THEN RETURN; END IF;
  IF connection.state='deleting' THEN
    IF connection.deletion_marker_id IS DISTINCT FROM requested_marker_id THEN RAISE invalid_parameter_value; END IF;
  ELSE
    DELETE FROM public.mcp_authorization_connections selected
      WHERE selected.personal_account_id=connection.personal_account_id
        AND selected.whatsapp_connection_id=connection.id;
    UPDATE public.whatsapp_connection_key_envelopes keys
      SET account_key_version=NULL, key_version=NULL, nonce=NULL, ciphertext=NULL, unavailable_at=requested_at
      WHERE keys.personal_account_id=connection.personal_account_id
        AND keys.whatsapp_connection_id=connection.id AND keys.unavailable_at IS NULL;
    UPDATE public.whatsapp_connections connections SET state='deleting', desired_state='disconnected',
      deletion_requested_at=requested_at, deletion_marker_id=requested_marker_id,
      lifecycle_claim_id=NULL, lifecycle_lease_expires_at=NULL,
      state_changed_at=greatest(connections.state_changed_at,requested_at),
      updated_at=greatest(connections.updated_at,requested_at)
      WHERE connections.id=connection.id RETURNING connections.* INTO connection;
  END IF;
  RETURN QUERY SELECT connection.public_id, connection.deletion_requested_at, connection.deletion_marker_id;
END $function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.prepare_personal_account_deletion(text,timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finish_personal_account_deletion(text,text,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.prepare_personal_account_deletion(text,timestamptz) TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.finish_personal_account_deletion(text,text,timestamptz) TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
CREATE INDEX tool_call_logs_expiry
ON public.tool_call_logs (expires_at, id);
--> statement-breakpoint

CREATE FUNCTION public.purge_expired_tool_call_logs(
  observed_at timestamptz,
  maximum_rows integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  IF maximum_rows < 1 OR maximum_rows > 1000 THEN
    RAISE EXCEPTION 'maximum_rows must be between 1 and 1000';
  END IF;

  WITH expired AS (
    SELECT logs.id
    FROM public.tool_call_logs AS logs
    WHERE logs.expires_at <= observed_at
    ORDER BY logs.expires_at, logs.id
    LIMIT maximum_rows
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.tool_call_logs AS logs
    USING expired
    WHERE logs.id = expired.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO deleted_count FROM deleted;

  RETURN deleted_count;
END
$function$;
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.purge_expired_tool_call_logs(timestamptz, integer)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
ON FUNCTION public.purge_expired_tool_call_logs(timestamptz, integer)
TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE public.tool_call_logs
ADD COLUMN public_id text,
ADD COLUMN connection_public_id text,
ADD COLUMN send_public_id text;
--> statement-breakpoint

UPDATE public.tool_call_logs
SET public_id = 'tcl_' || translate(
  substring(
    encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
    FROM 1 FOR 21
  ),
  '+/',
  '-_'
);
--> statement-breakpoint

ALTER TABLE public.tool_call_logs
ALTER COLUMN public_id SET NOT NULL,
ALTER COLUMN public_id SET DEFAULT (
  'tcl_' || translate(
    substring(
      encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
      FROM 1 FOR 21
    ),
    '+/',
    '-_'
  )
),
ADD CONSTRAINT tool_call_logs_public_id_unique UNIQUE (public_id),
ADD CONSTRAINT tool_call_logs_public_id_format CHECK (
  public_id ~ '^tcl_[A-Za-z0-9_-]{21}$'
),
ADD CONSTRAINT tool_call_logs_connection_public_id_format CHECK (
  connection_public_id IS NULL
  OR connection_public_id ~ '^con_[A-Za-z0-9_-]{21}$'
),
ADD CONSTRAINT tool_call_logs_send_public_id_format CHECK (
  send_public_id IS NULL
  OR send_public_id ~ '^snd_[A-Za-z0-9_-]{21}$'
);
--> statement-breakpoint

CREATE INDEX tool_call_logs_review_page
ON public.tool_call_logs (personal_account_id, started_at DESC, public_id DESC);
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.purge_expired_tool_call_logs(timestamptz, integer)
FROM whatsapp_api_runtime;
--> statement-breakpoint

DROP FUNCTION public.purge_expired_tool_call_logs(timestamptz, integer);
--> statement-breakpoint

CREATE FUNCTION public.purge_expired_tool_call_logs(maximum_rows integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  IF maximum_rows < 1 OR maximum_rows > 1000 THEN
    RAISE EXCEPTION 'maximum_rows must be between 1 and 1000';
  END IF;

  WITH expired AS (
    SELECT logs.id
    FROM public.tool_call_logs AS logs
    WHERE logs.expires_at <= statement_timestamp()
    ORDER BY logs.expires_at, logs.id
    LIMIT maximum_rows
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.tool_call_logs AS logs
    USING expired
    WHERE logs.id = expired.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO deleted_count FROM deleted;

  RETURN deleted_count;
END
$function$;
--> statement-breakpoint

REVOKE ALL
ON FUNCTION public.purge_expired_tool_call_logs(integer)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
ON FUNCTION public.purge_expired_tool_call_logs(integer)
TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
DO $roles$
DECLARE role_name name;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'whatsapp_break_glass_requester'::name,
    'whatsapp_break_glass_approver'::name,
    'whatsapp_break_glass_runtime'::name
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I NOREPLICATION NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
      role_name
    );
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = role_name
        AND (rolsuper OR rolreplication OR rolbypassrls)
    ) THEN
      RAISE EXCEPTION 'break-glass role % has prohibited privileged attributes', role_name;
    END IF;
  END LOOP;
END
$roles$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO
  whatsapp_break_glass_requester,
  whatsapp_break_glass_approver,
  whatsapp_break_glass_runtime;
--> statement-breakpoint

CREATE TABLE public.break_glass_requests (
  id uuid PRIMARY KEY,
  incident_reference text NOT NULL CHECK (length(incident_reference) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  requester_reference text NOT NULL CHECK (requester_reference ~ '^[A-Za-z0-9_-]{3,128}$'),
  personal_account_id uuid NOT NULL REFERENCES public.personal_accounts (id),
  capability text NOT NULL CHECK (capability IN ('message_content', 'stored_media')),
  legal_notification_prohibition text CHECK (
    legal_notification_prohibition IS NULL OR length(legal_notification_prohibition) BETWEEN 1 AND 2000
  ),
  requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  credential_sha256 text CHECK (credential_sha256 ~ '^[a-f0-9]{64}$'),
  credential_issued_at timestamptz,
  CHECK (expires_at > requested_at AND expires_at <= requested_at + interval '1 hour'),
  CHECK ((credential_sha256 IS NULL) = (credential_issued_at IS NULL))
);
--> statement-breakpoint

CREATE TABLE public.break_glass_approvals (
  request_id uuid NOT NULL REFERENCES public.break_glass_requests (id),
  approver_reference text NOT NULL CHECK (approver_reference ~ '^[A-Za-z0-9_-]{3,128}$'),
  approved_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (request_id, approver_reference)
);
--> statement-breakpoint

CREATE TABLE public.break_glass_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.break_glass_requests (id),
  event_type text NOT NULL CHECK (event_type IN (
    'requested', 'approved', 'credential_issued', 'decryption_attempt_allowed',
    'decryption_attempt_denied', 'decryption_succeeded', 'decryption_failed', 'expired'
  )),
  actor_reference text NOT NULL CHECK (actor_reference ~ '^[A-Za-z0-9_-]{3,128}$'),
  outcome text NOT NULL CHECK (outcome IN ('recorded', 'allowed', 'denied')),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
--> statement-breakpoint

CREATE TABLE public.break_glass_user_notifications (
  request_id uuid PRIMARY KEY REFERENCES public.break_glass_requests (id),
  personal_account_id uuid NOT NULL REFERENCES public.personal_accounts (id),
  queued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  delivered_at timestamptz,
  CHECK (delivered_at IS NULL OR delivered_at >= queued_at)
);
--> statement-breakpoint

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM
  whatsapp_break_glass_requester,
  whatsapp_break_glass_approver,
  whatsapp_break_glass_runtime;
--> statement-breakpoint

CREATE FUNCTION public.break_glass_audit_is_append_only()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'break-glass audit events are immutable';
END
$function$;
--> statement-breakpoint

CREATE TRIGGER break_glass_audit_is_append_only
BEFORE UPDATE OR DELETE ON public.break_glass_audit_events
FOR EACH ROW EXECUTE FUNCTION public.break_glass_audit_is_append_only();
--> statement-breakpoint

CREATE FUNCTION public.create_break_glass_request(
  request_id uuid,
  incident_reference text,
  requester_reference text,
  personal_account_id uuid,
  capability text,
  expires_at timestamptz,
  reason text DEFAULT 'Scoped incident investigation',
  legal_notification_prohibition text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  INSERT INTO public.break_glass_requests (
    id, incident_reference, reason, requester_reference, personal_account_id,
    capability, expires_at, legal_notification_prohibition
  ) VALUES (
    request_id, incident_reference, reason, requester_reference,
    personal_account_id, capability, expires_at, legal_notification_prohibition
  );
  INSERT INTO public.break_glass_audit_events
    (request_id, event_type, actor_reference, outcome)
  VALUES (request_id, 'requested', requester_reference, 'recorded');
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.approve_break_glass_request(
  request_id uuid, approver_reference text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE request public.break_glass_requests;
BEGIN
  SELECT * INTO STRICT request FROM public.break_glass_requests
  WHERE id = request_id FOR UPDATE;
  IF request.expires_at <= statement_timestamp() OR request.credential_issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'break-glass request is not approvable';
  END IF;
  IF request.requester_reference = approver_reference THEN
    RAISE EXCEPTION 'requester cannot approve own break-glass request';
  END IF;
  INSERT INTO public.break_glass_approvals VALUES
    (request_id, approver_reference, statement_timestamp());
  INSERT INTO public.break_glass_audit_events
    (request_id, event_type, actor_reference, outcome)
  VALUES (request_id, 'approved', approver_reference, 'recorded');
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.issue_break_glass_credential(
  request_id uuid, issuer_reference text, credential_sha256 text
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE request public.break_glass_requests;
DECLARE approval_count integer;
BEGIN
  SELECT * INTO STRICT request FROM public.break_glass_requests
  WHERE id = request_id FOR UPDATE;
  SELECT count(*)::integer INTO approval_count
  FROM public.break_glass_approvals AS approvals
  WHERE approvals.request_id = request.id;
  IF approval_count <> 2 OR request.expires_at <= statement_timestamp()
     OR request.credential_issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'break-glass credential requirements are not satisfied';
  END IF;
  UPDATE public.break_glass_requests SET
    credential_sha256 = issue_break_glass_credential.credential_sha256,
    credential_issued_at = statement_timestamp()
  WHERE id = request.id;
  INSERT INTO public.break_glass_audit_events
    (request_id, event_type, actor_reference, outcome)
  VALUES (request.id, 'credential_issued', issuer_reference, 'recorded');
  RETURN request.expires_at;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.authorize_break_glass_attempt(
  request_id uuid, credential_sha256 text, personal_account_id uuid, capability text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE request public.break_glass_requests;
DECLARE allowed boolean;
BEGIN
  SELECT * INTO request FROM public.break_glass_requests WHERE id = request_id FOR UPDATE;
  allowed := COALESCE(request.id IS NOT NULL
    AND request.credential_sha256 = authorize_break_glass_attempt.credential_sha256
    AND request.personal_account_id = authorize_break_glass_attempt.personal_account_id
    AND request.capability = authorize_break_glass_attempt.capability
    AND request.credential_issued_at IS NOT NULL
    AND request.expires_at > statement_timestamp(), false);
  IF request.id IS NOT NULL THEN
    INSERT INTO public.break_glass_audit_events
      (request_id, event_type, actor_reference, outcome)
    VALUES (
      request.id,
      CASE WHEN allowed THEN 'decryption_attempt_allowed' ELSE 'decryption_attempt_denied' END,
      'break-glass-runtime', CASE WHEN allowed THEN 'allowed' ELSE 'denied' END
    );
    IF allowed AND request.legal_notification_prohibition IS NULL THEN
      INSERT INTO public.break_glass_user_notifications (request_id, personal_account_id)
      VALUES (request.id, request.personal_account_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN allowed;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.record_break_glass_decryption_result(
  request_id uuid, credential_sha256 text, succeeded boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE request public.break_glass_requests;
BEGIN
  SELECT * INTO STRICT request FROM public.break_glass_requests WHERE id = request_id FOR UPDATE;
  IF request.credential_sha256 IS DISTINCT FROM record_break_glass_decryption_result.credential_sha256
     OR request.credential_issued_at IS NULL OR request.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'break-glass result credential is invalid or expired';
  END IF;
  INSERT INTO public.break_glass_audit_events
    (request_id, event_type, actor_reference, outcome)
  VALUES (
    request.id, CASE WHEN succeeded THEN 'decryption_succeeded' ELSE 'decryption_failed' END,
    'break-glass-runtime', CASE WHEN succeeded THEN 'allowed' ELSE 'denied' END
  );
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.expire_break_glass_requests(maximum_rows integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE expired_count integer;
BEGIN
  IF maximum_rows < 1 OR maximum_rows > 1000 THEN
    RAISE EXCEPTION 'maximum_rows must be between 1 and 1000';
  END IF;
  WITH candidates AS (
    SELECT requests.id
    FROM public.break_glass_requests AS requests
    WHERE requests.expires_at <= statement_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM public.break_glass_audit_events AS events
        WHERE events.request_id = requests.id AND events.event_type = 'expired'
      )
    ORDER BY requests.expires_at, requests.id
    LIMIT maximum_rows FOR UPDATE SKIP LOCKED
  ), inserted AS (
    INSERT INTO public.break_glass_audit_events
      (request_id, event_type, actor_reference, outcome)
    SELECT id, 'expired', 'break-glass-runtime', 'recorded' FROM candidates
    RETURNING 1
  ) SELECT count(*)::integer INTO expired_count FROM inserted;
  RETURN expired_count;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.create_break_glass_request(uuid,text,text,uuid,text,timestamptz,text,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.approve_break_glass_request(uuid,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.issue_break_glass_credential(uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.authorize_break_glass_attempt(uuid,text,uuid,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_break_glass_decryption_result(uuid,text,boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.expire_break_glass_requests(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.create_break_glass_request(uuid,text,text,uuid,text,timestamptz,text,text) TO whatsapp_break_glass_requester;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.approve_break_glass_request(uuid,text) TO whatsapp_break_glass_approver;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.issue_break_glass_credential(uuid,text,text) TO whatsapp_break_glass_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.authorize_break_glass_attempt(uuid,text,uuid,text) TO whatsapp_break_glass_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_break_glass_decryption_result(uuid,text,boolean) TO whatsapp_break_glass_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.expire_break_glass_requests(integer) TO whatsapp_break_glass_runtime;
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE public.security_records (
  category text NOT NULL CHECK (category IN ('tool_call', 'protected_resource')),
  client_class text NOT NULL CHECK (client_class ~ '^[a-z][a-z0-9_-]{0,63}$'),
  outcome text NOT NULL CHECK (
    outcome IN ('started','success','execution_error','rate_limited','authorization_denied')
  ),
  result_count integer CHECK (result_count IS NULL OR result_count >= 0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = started_at + interval '90 days')
);
--> statement-breakpoint

CREATE INDEX security_records_expiry
ON public.security_records (expires_at);
--> statement-breakpoint

CREATE TABLE public.personal_account_cleanup_audit (
  deletion_marker_id text PRIMARY KEY CHECK (deletion_marker_id ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = completed_at + interval '90 days')
);
--> statement-breakpoint

CREATE INDEX personal_account_cleanup_audit_expiry
ON public.personal_account_cleanup_audit (expires_at);
--> statement-breakpoint

CREATE FUNCTION public.list_personal_account_purge_candidates(
  observed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  deletion_marker_id text,
  requested_at timestamptz,
  deadline_at timestamptz,
  deadline_risk boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid Personal Account purge limit';
  END IF;
  RETURN QUERY
  SELECT accounts.deletion_marker_id, accounts.deletion_requested_at,
    accounts.deletion_requested_at + interval '24 hours',
    observed_at >= accounts.deletion_requested_at + interval '23 hours'
  FROM public.personal_accounts accounts
  WHERE accounts.state = 'deleting'
    AND accounts.deletion_marker_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.whatsapp_connections connections
      WHERE connections.personal_account_id = accounts.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.connection_setups setups
      WHERE setups.personal_account_id = accounts.id
        AND setups.cleanup_state IS DISTINCT FROM 'complete'
    )
  ORDER BY accounts.deletion_requested_at, accounts.deletion_marker_id
  LIMIT requested_limit;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.purge_personal_account(
  requested_marker_id text,
  completed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_account_id uuid;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$' THEN
    RAISE invalid_parameter_value;
  END IF;
  SELECT accounts.id INTO selected_account_id
  FROM public.personal_accounts accounts
  WHERE accounts.deletion_marker_id = requested_marker_id
    AND accounts.state = 'deleting'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN EXISTS (
      SELECT 1 FROM public.personal_account_cleanup_audit audit
      WHERE audit.deletion_marker_id = requested_marker_id
    );
  END IF;
  ALTER ROLE whatsapp_restore_runtime
    NOREPLICATION NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  IF EXISTS (
    SELECT 1 FROM public.whatsapp_connections connections
    WHERE connections.personal_account_id = selected_account_id
  ) OR EXISTS (
    SELECT 1 FROM public.connection_setups setups
    WHERE setups.personal_account_id = selected_account_id
      AND setups.cleanup_state IS DISTINCT FROM 'complete'
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.security_records(
    category, client_class, outcome, result_count, started_at,
    completed_at, latency_ms, expires_at
  )
  SELECT CASE
      WHEN logs.tool_name = 'read_stored_media' THEN 'protected_resource'
      ELSE 'tool_call'
    END,
    authorizations.client_class, logs.outcome, logs.result_count,
    logs.started_at, logs.completed_at, logs.latency_ms, logs.expires_at
  FROM public.tool_call_logs logs
  JOIN public.mcp_authorizations authorizations
    ON authorizations.personal_account_id = logs.personal_account_id
   AND authorizations.id = logs.mcp_authorization_id
  WHERE logs.personal_account_id = selected_account_id;

  INSERT INTO public.personal_account_cleanup_audit(
    deletion_marker_id, completed_at, expires_at
  ) VALUES (requested_marker_id, completed_at, completed_at + interval '90 days');

  DELETE FROM public.whatsapp_number_reservations reservations
  WHERE reservations.personal_account_id = selected_account_id;
  DELETE FROM public.connection_setups setups
  WHERE setups.personal_account_id = selected_account_id;
  DELETE FROM public.personal_accounts accounts WHERE accounts.id = selected_account_id;
  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.purge_expired_deletion_records(requested_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE purged_count integer;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid deletion record purge limit';
  END IF;
  WITH expired_security AS (
    SELECT records.ctid FROM public.security_records records
    WHERE records.expires_at <= statement_timestamp()
    ORDER BY records.expires_at LIMIT requested_limit FOR UPDATE SKIP LOCKED
  ), deleted_security AS (
    DELETE FROM public.security_records records USING expired_security
    WHERE records.ctid = expired_security.ctid RETURNING 1
  ), expired_audit AS (
    SELECT audit.deletion_marker_id FROM public.personal_account_cleanup_audit audit
    WHERE audit.expires_at <= statement_timestamp()
    ORDER BY audit.expires_at
    LIMIT GREATEST(requested_limit - (SELECT count(*) FROM deleted_security), 0)
    FOR UPDATE SKIP LOCKED
  ), deleted_audit AS (
    DELETE FROM public.personal_account_cleanup_audit audit USING expired_audit
    WHERE audit.deletion_marker_id = expired_audit.deletion_marker_id RETURNING 1
  )
  SELECT (SELECT count(*) FROM deleted_security) + (SELECT count(*) FROM deleted_audit)
  INTO purged_count;
  RETURN purged_count;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON TABLE public.security_records FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.personal_account_cleanup_audit FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_personal_account_purge_candidates(timestamptz,integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_personal_account(text,timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_expired_deletion_records(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_personal_account_purge_candidates(timestamptz,integer) TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.purge_personal_account(text,timestamptz) TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.purge_expired_deletion_records(integer) TO whatsapp_api_runtime;
--> statement-breakpoint
--> statement-breakpoint
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'whatsapp_restore_runtime') THEN
    CREATE ROLE whatsapp_restore_runtime LOGIN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'whatsapp_restore_runtime'
      AND (rolsuper OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'restore runtime role has prohibited privileged attributes';
  END IF;
END
$role$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO whatsapp_restore_runtime;
--> statement-breakpoint
GRANT SELECT ON public.drizzle_migrations TO whatsapp_restore_runtime;
--> statement-breakpoint

CREATE TABLE public.restore_readiness (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  branch_id text NOT NULL CHECK (branch_id ~ '^br-[A-Za-z0-9_-]{1,120}$'),
  state text NOT NULL CHECK (state IN ('replaying', 'ready')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  marker_count integer CHECK (marker_count IS NULL OR marker_count >= 0),
  deleted_entity_count integer CHECK (deleted_entity_count IS NULL OR deleted_entity_count >= 0),
  expired_record_count integer CHECK (expired_record_count IS NULL OR expired_record_count >= 0),
  CHECK ((state = 'replaying' AND completed_at IS NULL)
    OR (state = 'ready' AND completed_at IS NOT NULL
      AND marker_count IS NOT NULL AND deleted_entity_count IS NOT NULL
      AND expired_record_count IS NOT NULL))
);
--> statement-breakpoint

CREATE TABLE public.restore_object_deletions (
  bucket text NOT NULL CHECK (bucket IN ('stored_media', 'webhook_ingress')),
  object_key text NOT NULL CHECK (object_key <> ''),
  personal_account_id uuid,
  PRIMARY KEY (bucket, object_key)
);
--> statement-breakpoint

CREATE TABLE public.restore_replay_audit (
  branch_id text PRIMARY KEY CHECK (branch_id ~ '^br-[A-Za-z0-9_-]{1,120}$'),
  completed_at timestamptz NOT NULL,
  marker_count integer NOT NULL CHECK (marker_count >= 0),
  deleted_entity_count integer NOT NULL CHECK (deleted_entity_count >= 0),
  expired_record_count integer NOT NULL CHECK (expired_record_count >= 0)
);
--> statement-breakpoint

CREATE FUNCTION public.is_restore_ready(requested_branch_id text)
RETURNS boolean LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.restore_readiness readiness
    WHERE readiness.singleton AND readiness.branch_id = requested_branch_id
      AND readiness.state = 'ready'
  )
$function$;
--> statement-breakpoint

CREATE FUNCTION public.begin_restore_replay(
  requested_branch_id text, requested_at timestamptz
)
RETURNS TABLE (deletion_kind text, opaque_entity_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_branch_id !~ '^br-[A-Za-z0-9_-]{1,120}$' THEN
    RAISE invalid_parameter_value;
  END IF;
  INSERT INTO public.restore_readiness(singleton, branch_id, state, started_at)
  VALUES (true, requested_branch_id, 'replaying', requested_at)
  ON CONFLICT (singleton) DO UPDATE SET branch_id = excluded.branch_id,
    state = 'replaying', started_at = excluded.started_at, completed_at = NULL,
    marker_count = NULL, deleted_entity_count = NULL, expired_record_count = NULL
  WHERE restore_readiness.branch_id IS DISTINCT FROM excluded.branch_id
    OR restore_readiness.state IS DISTINCT FROM 'ready';
  RETURN QUERY
    SELECT 'personal_account'::text, accounts.id FROM public.personal_accounts accounts
    UNION ALL
    SELECT 'whatsapp_connection'::text, connections.id FROM public.whatsapp_connections connections;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.replay_restore_deletion(
  requested_kind text, requested_entity_id uuid, requested_marker_id text,
  requested_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_account_id uuid;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$'
    OR requested_kind NOT IN ('personal_account', 'whatsapp_connection') THEN
    RAISE invalid_parameter_value;
  END IF;
  IF requested_kind = 'personal_account' THEN
    selected_account_id := requested_entity_id;
  ELSE
    SELECT personal_account_id INTO selected_account_id
    FROM public.whatsapp_connections WHERE id = requested_entity_id;
  END IF;
  IF selected_account_id IS NULL THEN RETURN false; END IF;

  UPDATE public.personal_account_key_envelopes SET ciphertext = NULL,
    key_version = NULL, kms_key_id = NULL,
    unavailable_at = COALESCE(unavailable_at, requested_at)
  WHERE personal_account_id = selected_account_id;
  UPDATE public.whatsapp_connection_key_envelopes SET nonce = NULL,
    ciphertext = NULL, account_key_version = NULL, key_version = NULL,
    unavailable_at = COALESCE(unavailable_at, requested_at)
  WHERE personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account' OR whatsapp_connection_id = requested_entity_id);

  INSERT INTO public.restore_object_deletions(bucket, object_key)
  SELECT 'stored_media', media.object_key FROM public.stored_media media
  WHERE media.personal_account_id = selected_account_id AND media.object_key IS NOT NULL
    AND (requested_kind = 'personal_account' OR media.whatsapp_connection_id = requested_entity_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.restore_object_deletions(bucket, object_key)
  SELECT 'webhook_ingress', 'webhook-events/' || events.id::text
  FROM public.webhook_events events
  WHERE events.personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account' OR events.whatsapp_connection_id = requested_entity_id)
  ON CONFLICT DO NOTHING;

  IF requested_kind = 'personal_account' THEN
    DELETE FROM public.personal_accounts WHERE id = requested_entity_id;
  ELSE
    INSERT INTO public.deleted_whatsapp_connection_handles(public_id, deletion_marker_id, deleted_at)
    SELECT public_id, requested_marker_id, requested_at FROM public.whatsapp_connections
    WHERE id = requested_entity_id ON CONFLICT DO NOTHING;
    DELETE FROM public.whatsapp_connections WHERE id = requested_entity_id;
  END IF;
  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.purge_restore_expired(requested_at timestamptz, requested_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE purged integer := 0; affected integer;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN RAISE invalid_parameter_value; END IF;
  SELECT public.purge_expired_message_content(requested_at, requested_limit) INTO affected;
  purged := purged + affected;
  WITH candidates AS (
    SELECT operations.id FROM public.send_operations operations
    WHERE operations.expires_at <= requested_at ORDER BY operations.expires_at, operations.id
    LIMIT requested_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.send_operations operations USING candidates
    WHERE operations.id = candidates.id;
  GET DIAGNOSTICS affected = ROW_COUNT; purged := purged + affected;
  WITH candidates AS (
    SELECT logs.id FROM public.tool_call_logs logs WHERE logs.expires_at <= requested_at
    ORDER BY logs.expires_at, logs.id LIMIT requested_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.tool_call_logs logs USING candidates WHERE logs.id = candidates.id;
  GET DIAGNOSTICS affected = ROW_COUNT; purged := purged + affected;
  WITH candidates AS (
    SELECT records.ctid FROM public.security_records records
    WHERE records.expires_at <= requested_at ORDER BY records.expires_at
    LIMIT requested_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.security_records records USING candidates
    WHERE records.ctid = candidates.ctid;
  GET DIAGNOSTICS affected = ROW_COUNT; purged := purged + affected;
  INSERT INTO public.restore_object_deletions(
    bucket, object_key, personal_account_id
  )
  SELECT 'stored_media', deletions.object_key, deletions.personal_account_id
  FROM public.stored_media_object_deletions deletions
  ON CONFLICT (bucket, object_key) DO UPDATE SET personal_account_id =
    COALESCE(restore_object_deletions.personal_account_id,
      excluded.personal_account_id);
  RETURN purged;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.list_restore_object_deletions(requested_limit integer)
RETURNS TABLE (bucket text, object_key text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN RAISE invalid_parameter_value; END IF;
  RETURN QUERY SELECT deletions.bucket, deletions.object_key
  FROM public.restore_object_deletions deletions
  ORDER BY deletions.bucket, deletions.object_key LIMIT requested_limit;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.finish_restore_object_deletion(requested_bucket text, requested_object_key text)
RETURNS void LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_account_id uuid;
BEGIN
  SELECT personal_account_id INTO selected_account_id
  FROM public.restore_object_deletions
  WHERE bucket = requested_bucket AND object_key = requested_object_key;
  IF requested_bucket = 'stored_media' AND selected_account_id IS NOT NULL THEN
    PERFORM public.finish_stored_media_object_deletion(
      selected_account_id, requested_object_key
    );
  END IF;
  DELETE FROM public.restore_object_deletions
  WHERE bucket = requested_bucket AND object_key = requested_object_key
  ;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.complete_restore_replay(
  requested_branch_id text, requested_at timestamptz, requested_marker_count integer,
  requested_deleted_count integer, requested_expired_count integer
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.restore_readiness
    WHERE singleton AND branch_id = requested_branch_id AND state = 'ready'
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.restore_object_deletions)
    OR EXISTS (SELECT 1 FROM public.stored_media_object_deletions) THEN
    RAISE EXCEPTION 'restore object deletions remain';
  END IF;
  UPDATE public.restore_readiness SET state = 'ready', completed_at = requested_at,
    marker_count = requested_marker_count, deleted_entity_count = requested_deleted_count,
    expired_record_count = requested_expired_count
  WHERE singleton AND branch_id = requested_branch_id AND state = 'replaying';
  IF NOT FOUND THEN RAISE EXCEPTION 'restore replay is not active'; END IF;
  INSERT INTO public.restore_replay_audit
    (branch_id, completed_at, marker_count, deleted_entity_count, expired_record_count)
  VALUES (requested_branch_id, requested_at, requested_marker_count,
    requested_deleted_count, requested_expired_count)
  ON CONFLICT (branch_id) DO UPDATE SET completed_at = excluded.completed_at,
    marker_count = excluded.marker_count, deleted_entity_count = excluded.deleted_entity_count,
    expired_record_count = excluded.expired_record_count;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON TABLE public.restore_readiness, public.restore_object_deletions,
  public.restore_replay_audit FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_restore_ready(text),
  public.begin_restore_replay(text,timestamptz),
  public.replay_restore_deletion(text,uuid,text,timestamptz),
  public.purge_restore_expired(timestamptz,integer),
  public.list_restore_object_deletions(integer),
  public.finish_restore_object_deletion(text,text),
  public.complete_restore_replay(text,timestamptz,integer,integer,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_restore_ready(text) TO whatsapp_api_runtime,
  whatsapp_webhook_runtime, whatsapp_deletion_runtime, whatsapp_restore_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.begin_restore_replay(text,timestamptz),
  public.replay_restore_deletion(text,uuid,text,timestamptz),
  public.purge_restore_expired(timestamptz,integer),
  public.list_restore_object_deletions(integer),
  public.finish_restore_object_deletion(text,text),
  public.complete_restore_replay(text,timestamptz,integer,integer,integer)
  TO whatsapp_restore_runtime;
--> statement-breakpoint
--> statement-breakpoint
