CREATE TABLE app_private.security_records (
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

CREATE INDEX security_records_expiry
ON app_private.security_records (expires_at);

CREATE TABLE app_private.personal_account_cleanup_audit (
  deletion_marker_id text PRIMARY KEY CHECK (deletion_marker_id ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at = completed_at + interval '90 days')
);

CREATE INDEX personal_account_cleanup_audit_expiry
ON app_private.personal_account_cleanup_audit (expires_at);

CREATE FUNCTION app_private.list_personal_account_purge_candidates(
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
  FROM app.personal_accounts accounts
  WHERE accounts.state = 'deleting'
    AND accounts.deletion_marker_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM app.whatsapp_connections connections
      WHERE connections.personal_account_id = accounts.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.connection_setups setups
      WHERE setups.personal_account_id = accounts.id
        AND setups.cleanup_state IS DISTINCT FROM 'complete'
    )
  ORDER BY accounts.deletion_requested_at, accounts.deletion_marker_id
  LIMIT requested_limit;
END
$function$;

CREATE FUNCTION app_private.purge_personal_account(
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
  FROM app.personal_accounts accounts
  WHERE accounts.deletion_marker_id = requested_marker_id
    AND accounts.state = 'deleting'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN EXISTS (
      SELECT 1 FROM app_private.personal_account_cleanup_audit audit
      WHERE audit.deletion_marker_id = requested_marker_id
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.whatsapp_connections connections
    WHERE connections.personal_account_id = selected_account_id
  ) OR EXISTS (
    SELECT 1 FROM app.connection_setups setups
    WHERE setups.personal_account_id = selected_account_id
      AND setups.cleanup_state IS DISTINCT FROM 'complete'
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO app_private.security_records(
    category, client_class, outcome, result_count, started_at,
    completed_at, latency_ms, expires_at
  )
  SELECT CASE
      WHEN logs.tool_name = 'read_stored_media' THEN 'protected_resource'
      ELSE 'tool_call'
    END,
    authorizations.client_class, logs.outcome, logs.result_count,
    logs.started_at, logs.completed_at, logs.latency_ms, logs.expires_at
  FROM app.tool_call_logs logs
  JOIN app.mcp_authorizations authorizations
    ON authorizations.personal_account_id = logs.personal_account_id
   AND authorizations.id = logs.mcp_authorization_id
  WHERE logs.personal_account_id = selected_account_id;

  INSERT INTO app_private.personal_account_cleanup_audit(
    deletion_marker_id, completed_at, expires_at
  ) VALUES (requested_marker_id, completed_at, completed_at + interval '90 days');

  DELETE FROM app.whatsapp_number_reservations reservations
  WHERE reservations.personal_account_id = selected_account_id;
  DELETE FROM app.connection_setups setups
  WHERE setups.personal_account_id = selected_account_id;
  DELETE FROM app.personal_accounts accounts WHERE accounts.id = selected_account_id;
  RETURN true;
END
$function$;

CREATE FUNCTION app_private.purge_expired_deletion_records(requested_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE purged_count integer;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid deletion record purge limit';
  END IF;
  WITH expired_security AS (
    SELECT records.ctid FROM app_private.security_records records
    WHERE records.expires_at <= statement_timestamp()
    ORDER BY records.expires_at LIMIT requested_limit FOR UPDATE SKIP LOCKED
  ), deleted_security AS (
    DELETE FROM app_private.security_records records USING expired_security
    WHERE records.ctid = expired_security.ctid RETURNING 1
  ), expired_audit AS (
    SELECT audit.deletion_marker_id FROM app_private.personal_account_cleanup_audit audit
    WHERE audit.expires_at <= statement_timestamp()
    ORDER BY audit.expires_at LIMIT requested_limit FOR UPDATE SKIP LOCKED
  ), deleted_audit AS (
    DELETE FROM app_private.personal_account_cleanup_audit audit USING expired_audit
    WHERE audit.deletion_marker_id = expired_audit.deletion_marker_id RETURNING 1
  )
  SELECT (SELECT count(*) FROM deleted_security) + (SELECT count(*) FROM deleted_audit)
  INTO purged_count;
  RETURN purged_count;
END
$function$;

REVOKE ALL ON TABLE app_private.security_records FROM PUBLIC;
REVOKE ALL ON TABLE app_private.personal_account_cleanup_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.list_personal_account_purge_candidates(timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.purge_personal_account(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.purge_expired_deletion_records(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.list_personal_account_purge_candidates(timestamptz,integer) TO whatsapp_api_runtime;
GRANT EXECUTE ON FUNCTION app_private.purge_personal_account(text,timestamptz) TO whatsapp_api_runtime;
GRANT EXECUTE ON FUNCTION app_private.purge_expired_deletion_records(integer) TO whatsapp_api_runtime;
