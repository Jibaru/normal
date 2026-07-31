ALTER TABLE app.mcp_authorizations
ADD COLUMN public_id text,
ADD COLUMN client_name text CHECK (
  client_name IS NULL
  OR (
    length(client_name) BETWEEN 1 AND 128
    AND client_name = btrim(client_name)
  )
);

UPDATE app.mcp_authorizations
SET public_id = 'mca_' || translate(
  substring(
    encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
    FROM 1 FOR 21
  ),
  '+/',
  '-_'
);

ALTER TABLE app.mcp_authorizations
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

ALTER TABLE app.mcp_authorizations
ADD CONSTRAINT mcp_authorizations_public_id_unique UNIQUE (public_id),
ADD CONSTRAINT mcp_authorizations_public_id_format CHECK (
  public_id ~ '^mca_[A-Za-z0-9_-]{21}$'
);

CREATE FUNCTION app_private.bootstrap_mcp_access_authorization(
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
  FROM app.mcp_authorizations AS authorizations
  JOIN app.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  WHERE authorizations.id = candidate_authorization_id
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND authorizations.state = 'active'
    AND authorizations.absolute_expires_at > observed_at
    AND accounts.state = 'active'
$function$;

REVOKE ALL
ON FUNCTION app_private.bootstrap_mcp_access_authorization(
  uuid, text, timestamptz
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app_private.bootstrap_mcp_access_authorization(
  uuid, text, timestamptz
)
TO whatsapp_api_runtime;
