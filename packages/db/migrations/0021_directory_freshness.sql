ALTER TABLE app.directory_contact_projections
  ADD COLUMN retention_limited boolean NOT NULL DEFAULT false;

ALTER TABLE app.whatsapp_group_directory_states
  ADD COLUMN snapshot_observed_at timestamptz,
  ADD COLUMN retention_limited boolean NOT NULL DEFAULT false;

CREATE FUNCTION app_private.clear_superseded_directory_retention_limitation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.partial = false
    AND (
      TG_OP = 'INSERT'
      OR OLD.partial
      OR NEW.snapshot_observed_at IS DISTINCT FROM OLD.snapshot_observed_at
    )
  THEN
    NEW.retention_limited := false;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER directory_contact_projection_complete_snapshot
BEFORE INSERT OR UPDATE
ON app.directory_contact_projections
FOR EACH ROW
EXECUTE FUNCTION app_private.clear_superseded_directory_retention_limitation();

CREATE TRIGGER whatsapp_group_directory_complete_snapshot
BEFORE INSERT OR UPDATE
ON app.whatsapp_group_directory_states
FOR EACH ROW
EXECUTE FUNCTION app_private.clear_superseded_directory_retention_limitation();

REVOKE ALL
ON FUNCTION app_private.clear_superseded_directory_retention_limitation()
FROM PUBLIC;

CREATE FUNCTION app_private.directory_projection_stale(
  requested_personal_account_id uuid,
  requested_whatsapp_connection_id uuid,
  requested_at timestamptz,
  snapshot_observed_at timestamptz,
  observation_stale boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    observation_stale
    OR snapshot_observed_at < requested_at - interval '10 minutes'
    OR connections.state <> 'connected'
    OR connections.health_last_confirmed_at IS NULL
    OR connections.health_last_confirmed_at
      < requested_at - interval '10 minutes'
  FROM app.whatsapp_connections AS connections
  WHERE connections.personal_account_id = requested_personal_account_id
    AND connections.id = requested_whatsapp_connection_id
$function$;

CREATE FUNCTION app_private.directory_projection_partial(
  requested_personal_account_id uuid,
  requested_whatsapp_connection_id uuid,
  snapshot_observed_at timestamptz,
  observation_partial boolean,
  retention_limited boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    observation_partial
    OR retention_limited
    OR EXISTS (
      SELECT 1
      FROM app.ingestion_gaps AS gaps
      WHERE gaps.personal_account_id = requested_personal_account_id
        AND gaps.whatsapp_connection_id = requested_whatsapp_connection_id
        AND (gaps.ends_at IS NULL OR gaps.ends_at > snapshot_observed_at)
    )
$function$;

REVOKE ALL
ON FUNCTION app_private.directory_projection_stale(
  uuid, uuid, timestamptz, timestamptz, boolean
), app_private.directory_projection_partial(
  uuid, uuid, timestamptz, boolean, boolean
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app_private.directory_projection_stale(
  uuid, uuid, timestamptz, timestamptz, boolean
), app_private.directory_projection_partial(
  uuid, uuid, timestamptz, boolean, boolean
)
TO whatsapp_api_runtime;
