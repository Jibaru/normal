CREATE TABLE app.personal_account_key_envelopes (
  personal_account_id uuid PRIMARY KEY
    REFERENCES app.personal_accounts (id) ON DELETE CASCADE,
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

CREATE TABLE app.whatsapp_connection_key_envelopes (
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
    REFERENCES app.whatsapp_connections (personal_account_id, id)
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

ALTER TABLE app.personal_account_key_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.personal_account_key_envelopes FORCE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_connection_key_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_connection_key_envelopes FORCE ROW LEVEL SECURITY;

CREATE POLICY personal_account_key_envelopes_tenant
ON app.personal_account_key_envelopes
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

CREATE POLICY whatsapp_connection_key_envelopes_tenant
ON app.whatsapp_connection_key_envelopes
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

GRANT INSERT
  ON app.personal_account_key_envelopes
  TO whatsapp_api_runtime;
GRANT INSERT
  ON app.whatsapp_connection_key_envelopes
  TO whatsapp_api_runtime;

CREATE FUNCTION app_private.load_available_personal_account_key(
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
  FROM app.personal_account_key_envelopes AS envelopes
  JOIN app.personal_accounts AS accounts
    ON accounts.id = envelopes.personal_account_id
  WHERE envelopes.personal_account_id = requested_personal_account_id
    AND requested_personal_account_id = nullif(
      pg_catalog.current_setting('app.personal_account_id', true),
      ''
    )::uuid
    AND accounts.state = 'active'
    AND envelopes.unavailable_at IS NULL
    AND envelopes.ciphertext IS NOT NULL
$function$;

CREATE FUNCTION app_private.load_available_whatsapp_connection_key(
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
  FROM app.whatsapp_connection_key_envelopes AS connection_envelopes
  JOIN app.personal_account_key_envelopes AS account_envelopes
    ON account_envelopes.personal_account_id =
      connection_envelopes.personal_account_id
  JOIN app.personal_accounts AS accounts
    ON accounts.id = connection_envelopes.personal_account_id
  WHERE connection_envelopes.personal_account_id =
      requested_personal_account_id
    AND connection_envelopes.whatsapp_connection_id =
      requested_whatsapp_connection_id
    AND requested_personal_account_id = nullif(
      pg_catalog.current_setting('app.personal_account_id', true),
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

CREATE FUNCTION app_private.make_personal_account_key_unavailable(
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
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid;
  IF tenant_context IS NULL
    OR tenant_context IS DISTINCT FROM requested_personal_account_id
  THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'Personal Account context does not match';
  END IF;

  INSERT INTO app.personal_account_key_envelopes (
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

CREATE FUNCTION app_private.make_whatsapp_connection_key_unavailable(
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
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid;
  IF tenant_context IS NULL
    OR tenant_context IS DISTINCT FROM requested_personal_account_id
  THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'Personal Account context does not match';
  END IF;

  INSERT INTO app.whatsapp_connection_key_envelopes (
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

REVOKE ALL
  ON FUNCTION app_private.load_available_personal_account_key(uuid)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.load_available_whatsapp_connection_key(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.make_personal_account_key_unavailable(
    uuid,
    timestamptz
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.make_whatsapp_connection_key_unavailable(
    uuid,
    uuid,
    timestamptz
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.load_available_personal_account_key(uuid)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.load_available_whatsapp_connection_key(uuid, uuid)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.make_personal_account_key_unavailable(
    uuid,
    timestamptz
  )
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.make_whatsapp_connection_key_unavailable(
    uuid,
    uuid,
    timestamptz
  )
  TO whatsapp_api_runtime;
