CREATE INDEX tool_call_logs_expiry
ON app.tool_call_logs (expires_at, id);

CREATE FUNCTION app_private.purge_expired_tool_call_logs(
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
    FROM app.tool_call_logs AS logs
    WHERE logs.expires_at <= observed_at
    ORDER BY logs.expires_at, logs.id
    LIMIT maximum_rows
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM app.tool_call_logs AS logs
    USING expired
    WHERE logs.id = expired.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO deleted_count FROM deleted;

  RETURN deleted_count;
END
$function$;

REVOKE ALL
ON FUNCTION app_private.purge_expired_tool_call_logs(timestamptz, integer)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app_private.purge_expired_tool_call_logs(timestamptz, integer)
TO whatsapp_api_runtime;
