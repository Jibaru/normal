ALTER TABLE app.tool_call_logs
ADD COLUMN public_id text,
ADD COLUMN connection_public_id text,
ADD COLUMN send_public_id text;

UPDATE app.tool_call_logs
SET public_id = 'tcl_' || translate(
  substring(
    encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
    FROM 1 FOR 21
  ),
  '+/',
  '-_'
);

ALTER TABLE app.tool_call_logs
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

CREATE INDEX tool_call_logs_review_page
ON app.tool_call_logs (personal_account_id, started_at DESC, public_id DESC);

REVOKE ALL
ON FUNCTION app_private.purge_expired_tool_call_logs(timestamptz, integer)
FROM whatsapp_api_runtime;

DROP FUNCTION app_private.purge_expired_tool_call_logs(timestamptz, integer);

CREATE FUNCTION app_private.purge_expired_tool_call_logs(maximum_rows integer)
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
    WHERE logs.expires_at <= statement_timestamp()
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
ON FUNCTION app_private.purge_expired_tool_call_logs(integer)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app_private.purge_expired_tool_call_logs(integer)
TO whatsapp_api_runtime;
