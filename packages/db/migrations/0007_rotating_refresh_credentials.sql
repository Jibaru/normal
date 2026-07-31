ALTER TABLE app.mcp_authorizations
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

CREATE TABLE app.mcp_refresh_credentials (
  credential_hash bytea PRIMARY KEY
    CHECK (octet_length(credential_hash) = 32),
  personal_account_id uuid NOT NULL,
  mcp_authorization_id uuid NOT NULL,
  issued_at timestamptz NOT NULL,
  inactive_expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (personal_account_id, mcp_authorization_id)
    REFERENCES app.mcp_authorizations (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (
    inactive_expires_at > issued_at
    AND inactive_expires_at <= issued_at + interval '30 days'
  ),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);

CREATE UNIQUE INDEX mcp_refresh_credentials_one_current
ON app.mcp_refresh_credentials (mcp_authorization_id)
WHERE consumed_at IS NULL;

ALTER TABLE app.mcp_refresh_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mcp_refresh_credentials FORCE ROW LEVEL SECURITY;

CREATE POLICY mcp_refresh_credentials_tenant
ON app.mcp_refresh_credentials
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

GRANT SELECT, INSERT, UPDATE ON app.mcp_refresh_credentials
TO whatsapp_api_runtime;

CREATE FUNCTION app_private.bootstrap_mcp_refresh_authorization(
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
  FROM app.mcp_authorizations AS authorizations
  JOIN app.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  WHERE authorizations.oauth_subject = candidate_oauth_subject
    AND authorizations.client_id = candidate_client_id
    AND authorizations.state = 'active'
    AND authorizations.refresh_family_state = 'active'
    AND authorizations.absolute_expires_at > observed_at
    AND accounts.state = 'active'
    AND EXISTS (
      SELECT 1
      FROM app_private.clerk_identities AS identities
      WHERE identities.personal_account_id =
        authorizations.personal_account_id
    )
    AND EXISTS (
      SELECT 1
      FROM app.mcp_authorization_connections AS selected
      JOIN app.whatsapp_connections AS connections
        ON connections.personal_account_id = selected.personal_account_id
        AND connections.id = selected.whatsapp_connection_id
      WHERE selected.personal_account_id =
          authorizations.personal_account_id
        AND selected.mcp_authorization_id = authorizations.id
    )
$function$;

CREATE FUNCTION app_private.bootstrap_mcp_refresh_credential(
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
  FROM app.mcp_refresh_credentials AS credentials
  JOIN app.mcp_authorizations AS authorizations
    ON authorizations.personal_account_id = credentials.personal_account_id
    AND authorizations.id = credentials.mcp_authorization_id
  WHERE credentials.credential_hash = candidate_credential_hash
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND authorizations.client_id = candidate_client_id
$function$;

REVOKE ALL
ON FUNCTION app_private.bootstrap_mcp_refresh_authorization(
  text,
  text,
  timestamptz
)
FROM PUBLIC;

REVOKE ALL
ON FUNCTION app_private.bootstrap_mcp_refresh_credential(bytea, text, text)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app_private.bootstrap_mcp_refresh_authorization(
  text,
  text,
  timestamptz
)
TO whatsapp_api_runtime;

GRANT EXECUTE
ON FUNCTION app_private.bootstrap_mcp_refresh_credential(bytea, text, text)
TO whatsapp_api_runtime;

CREATE OR REPLACE FUNCTION app_private.bootstrap_mcp_authorization(
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
  FROM app.mcp_authorizations AS authorizations
  JOIN app.personal_accounts AS accounts
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
      FROM app_private.clerk_identities AS identities
      WHERE identities.personal_account_id =
        authorizations.personal_account_id
    )
    AND EXISTS (
      SELECT 1
      FROM app.mcp_authorization_connections AS selected
      JOIN app.whatsapp_connections AS connections
        ON connections.personal_account_id = selected.personal_account_id
        AND connections.id = selected.whatsapp_connection_id
      WHERE selected.personal_account_id =
          authorizations.personal_account_id
        AND selected.mcp_authorization_id = authorizations.id
    )
$function$;
