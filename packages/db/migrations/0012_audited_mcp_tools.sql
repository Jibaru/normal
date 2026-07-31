CREATE TABLE app.tool_call_logs (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL
    REFERENCES app.personal_accounts (id) ON DELETE CASCADE,
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
    REFERENCES app.mcp_authorizations (personal_account_id, id)
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

CREATE INDEX tool_call_logs_request_quota
ON app.tool_call_logs (personal_account_id, started_at, id)
WHERE quota_reserved;

ALTER TABLE app.tool_call_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tool_call_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY tool_call_logs_tenant
ON app.tool_call_logs
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

GRANT SELECT, INSERT, UPDATE
ON app.tool_call_logs
TO whatsapp_api_runtime;

CREATE FUNCTION app_private.bootstrap_mcp_tool_call(
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
  FROM app.mcp_authorizations AS authorizations
  WHERE authorizations.id = candidate_authorization_id
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND (
      candidate_client_id IS NULL
      OR authorizations.client_id = candidate_client_id
    )
$function$;

CREATE FUNCTION app_private.bootstrap_active_mcp_tool_call(
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
  FROM app.mcp_authorizations AS authorizations
  JOIN app.personal_accounts AS accounts
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
      FROM app_private.clerk_identities AS identities
      WHERE identities.personal_account_id =
        authorizations.personal_account_id
    )
$function$;

CREATE FUNCTION app_private.bootstrap_tool_call_log(
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
  FROM app.tool_call_logs AS logs
  WHERE logs.id = candidate_log_id
$function$;

REVOKE ALL
ON FUNCTION app_private.bootstrap_mcp_tool_call(uuid, text, text)
FROM PUBLIC;
REVOKE ALL
ON FUNCTION app_private.bootstrap_active_mcp_tool_call(
  uuid, text, text, timestamptz
)
FROM PUBLIC;
REVOKE ALL
ON FUNCTION app_private.bootstrap_tool_call_log(uuid)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app_private.bootstrap_mcp_tool_call(uuid, text, text)
TO whatsapp_api_runtime;
GRANT EXECUTE
ON FUNCTION app_private.bootstrap_active_mcp_tool_call(
  uuid, text, text, timestamptz
)
TO whatsapp_api_runtime;
GRANT EXECUTE
ON FUNCTION app_private.bootstrap_tool_call_log(uuid)
TO whatsapp_api_runtime;
