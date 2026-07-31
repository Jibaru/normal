ALTER TABLE app.whatsapp_connections
ADD COLUMN public_id text;

UPDATE app.whatsapp_connections
SET public_id = 'con_' || translate(
  substring(
    encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
    FROM 1 FOR 21
  ),
  '+/',
  '-_'
);

ALTER TABLE app.whatsapp_connections
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

ALTER TABLE app.whatsapp_connections
ADD CONSTRAINT whatsapp_connections_public_id_unique UNIQUE (public_id),
ADD CONSTRAINT whatsapp_connections_public_id_format CHECK (
  public_id ~ '^con_[A-Za-z0-9_-]{21}$'
);

CREATE TABLE app.mcp_authorizations (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL
    REFERENCES app.personal_accounts (id) ON DELETE CASCADE,
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

CREATE TABLE app.mcp_authorization_connections (
  personal_account_id uuid NOT NULL,
  mcp_authorization_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (mcp_authorization_id, whatsapp_connection_id),
  FOREIGN KEY (personal_account_id, mcp_authorization_id)
    REFERENCES app.mcp_authorizations (personal_account_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE
);

ALTER TABLE app.mcp_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mcp_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.mcp_authorization_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mcp_authorization_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY mcp_authorizations_tenant
ON app.mcp_authorizations
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

CREATE POLICY mcp_authorization_connections_tenant
ON app.mcp_authorization_connections
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

GRANT SELECT, INSERT, UPDATE ON app.mcp_authorizations
TO whatsapp_api_runtime;
GRANT SELECT, INSERT, DELETE ON app.mcp_authorization_connections
TO whatsapp_api_runtime;

CREATE FUNCTION app_private.bootstrap_mcp_authorization(
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
    AND authorizations.absolute_expires_at > observed_at
    AND accounts.state = 'active'
$function$;

REVOKE ALL
ON FUNCTION app_private.bootstrap_mcp_authorization(uuid, text, text, timestamptz)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app_private.bootstrap_mcp_authorization(uuid, text, text, timestamptz)
TO whatsapp_api_runtime;
