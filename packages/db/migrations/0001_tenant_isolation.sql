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
      'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
      runtime_role
    );

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

CREATE SCHEMA app;
CREATE SCHEMA IF NOT EXISTS app_private;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;

GRANT USAGE ON SCHEMA app TO whatsapp_api_runtime;
GRANT USAGE ON SCHEMA app TO whatsapp_webhook_runtime;
GRANT USAGE ON SCHEMA app_private TO whatsapp_api_runtime;
GRANT USAGE ON SCHEMA app_private TO whatsapp_webhook_runtime;
GRANT SELECT
  ON app_private.schema_migrations
  TO whatsapp_api_runtime, whatsapp_webhook_runtime;

CREATE TABLE app.personal_accounts (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('active', 'deleting')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE app_private.clerk_identities (
  clerk_user_id text PRIMARY KEY,
  personal_account_id uuid NOT NULL UNIQUE
    REFERENCES app.personal_accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE app.whatsapp_connections (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL
    REFERENCES app.personal_accounts (id) ON DELETE CASCADE,
  webhook_ingress_id uuid NOT NULL UNIQUE,
  display_name_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (personal_account_id, id)
);

CREATE TABLE app.whatsapp_connection_secrets (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  credential_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE
);

ALTER TABLE app.personal_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.personal_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_connection_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_connection_secrets FORCE ROW LEVEL SECURITY;

CREATE POLICY personal_accounts_tenant
ON app.personal_accounts
USING (
  id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid
);

CREATE POLICY whatsapp_connections_tenant
ON app.whatsapp_connections
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

CREATE POLICY whatsapp_connection_secrets_tenant
ON app.whatsapp_connection_secrets
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

GRANT SELECT, UPDATE ON app.personal_accounts TO whatsapp_api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON app.whatsapp_connections
  TO whatsapp_api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON app.whatsapp_connection_secrets
  TO whatsapp_api_runtime;

GRANT SELECT ON app.personal_accounts TO whatsapp_webhook_runtime;
GRANT SELECT, UPDATE ON app.whatsapp_connections TO whatsapp_webhook_runtime;

CREATE FUNCTION app_private.bootstrap_personal_account_for_clerk(
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
  WHERE identities.clerk_user_id = verified_clerk_user_id
$function$;

CREATE FUNCTION app_private.bootstrap_whatsapp_connection_for_ingress(
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
  FROM app.whatsapp_connections AS connections
  WHERE connections.webhook_ingress_id = verified_webhook_ingress_id
$function$;

REVOKE ALL
  ON FUNCTION app_private.bootstrap_personal_account_for_clerk(text)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.bootstrap_whatsapp_connection_for_ingress(uuid)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.bootstrap_personal_account_for_clerk(text)
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.bootstrap_whatsapp_connection_for_ingress(uuid)
  TO whatsapp_webhook_runtime;
