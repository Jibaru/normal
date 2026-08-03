CREATE FUNCTION app_private.expire_send_dispatch_leases(requested_observed_at timestamptz)
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
    UPDATE app.send_operations
    SET status = 'unknown', status_changed_at = lease_expires_at
    WHERE status = 'processing' AND lease_expires_at <= requested_observed_at
    RETURNING personal_account_id, tool_call_log_id
  ), completed_logs AS (
    UPDATE app.tool_call_logs AS logs
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

REVOKE ALL ON FUNCTION app_private.expire_send_dispatch_leases(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.expire_send_dispatch_leases(timestamptz) TO whatsapp_api_runtime;
