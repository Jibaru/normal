DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'whatsapp_deletion_runtime') THEN
    CREATE ROLE whatsapp_deletion_runtime LOGIN;
  END IF;
  ALTER ROLE whatsapp_deletion_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
END
$role$;

GRANT USAGE ON SCHEMA app_private TO whatsapp_deletion_runtime;
GRANT SELECT ON app_private.schema_migrations TO whatsapp_deletion_runtime;

CREATE TABLE app_private.deleted_whatsapp_connection_handles (
  public_id text PRIMARY KEY CHECK (public_id ~ '^con_[A-Za-z0-9_-]{21}$'),
  deletion_marker_id text NOT NULL UNIQUE CHECK (deletion_marker_id ~ '^[a-f0-9]{64}$'),
  deleted_at timestamptz NOT NULL
);

ALTER TABLE app.whatsapp_connections
  ADD COLUMN provider_absence_confirmed_at timestamptz,
  ADD CONSTRAINT whatsapp_connection_provider_absence_after_deletion CHECK (
    provider_absence_confirmed_at IS NULL
    OR (state = 'deleting' AND provider_absence_confirmed_at >= deletion_requested_at)
  );

CREATE FUNCTION app_private.reject_deleted_whatsapp_connection_handle()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_private.deleted_whatsapp_connection_handles deleted
    WHERE deleted.public_id = NEW.public_id
  ) THEN
    RAISE EXCEPTION 'deleted WhatsApp Connection handle cannot be reused'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER reject_deleted_whatsapp_connection_handle
BEFORE INSERT OR UPDATE OF public_id ON app.whatsapp_connections
FOR EACH ROW EXECUTE FUNCTION app_private.reject_deleted_whatsapp_connection_handle();

CREATE FUNCTION app_private.list_whatsapp_connection_deletion_candidates(
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
    RAISE EXCEPTION 'invalid Connection Deletion candidate limit';
  END IF;
  RETURN QUERY
  SELECT connections.deletion_marker_id, connections.deletion_requested_at,
    connections.deletion_requested_at + interval '24 hours',
    observed_at >= connections.deletion_requested_at + interval '23 hours'
  FROM app.whatsapp_connections connections
  WHERE connections.state = 'deleting'
  ORDER BY connections.deletion_requested_at, connections.deletion_marker_id
  LIMIT requested_limit;
END
$function$;

CREATE FUNCTION app_private.confirm_whatsapp_connection_provider_absence(
  requested_marker_id text,
  confirmed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  UPDATE app.whatsapp_connections connections
  SET provider_absence_confirmed_at = COALESCE(
    connections.provider_absence_confirmed_at,
    confirmed_at
  )
  WHERE connections.deletion_marker_id = requested_marker_id
    AND connections.state = 'deleting'
    AND confirmed_at >= connections.deletion_requested_at;
  RETURN FOUND OR EXISTS (
    SELECT 1 FROM app_private.deleted_whatsapp_connection_handles deleted
    WHERE deleted.deletion_marker_id = requested_marker_id
  );
END
$function$;

CREATE FUNCTION app_private.list_whatsapp_connection_active_purge_candidates(
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
    RAISE EXCEPTION 'invalid Connection Deletion purge limit';
  END IF;
  RETURN QUERY SELECT connections.deletion_marker_id,
    connections.deletion_requested_at,
    connections.deletion_requested_at + interval '24 hours',
    observed_at >= connections.deletion_requested_at + interval '23 hours'
  FROM app.whatsapp_connections connections
  WHERE connections.state = 'deleting'
    AND connections.provider_absence_confirmed_at IS NOT NULL
  ORDER BY connections.deletion_requested_at, connections.deletion_marker_id
  LIMIT requested_limit;
END
$function$;

CREATE FUNCTION app_private.prepare_whatsapp_connection_cleanup(
  requested_marker_id text,
  requested_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  personal_account_id uuid,
  stored_media_object_keys text[],
  webhook_source_object_keys text[]
)
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_connection app.whatsapp_connections%ROWTYPE;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid Connection Deletion object limit';
  END IF;
  SELECT connections.* INTO selected_connection
  FROM app.whatsapp_connections connections
  WHERE connections.deletion_marker_id = requested_marker_id
    AND connections.state = 'deleting'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF selected_connection.provider_absence_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'provider absence is not confirmed';
  END IF;

  DELETE FROM app.stored_media media
  WHERE media.whatsapp_connection_id = selected_connection.id
    AND media.state IN ('pending','rejected','failed');
  INSERT INTO app.stored_media_object_deletions(
    personal_account_id, object_key, requested_at
  )
  SELECT media.personal_account_id, media.object_key, requested_at
  FROM app.stored_media media
  WHERE media.whatsapp_connection_id = selected_connection.id
    AND media.state = 'ready'
  ON CONFLICT DO NOTHING;
  UPDATE app.stored_media media SET state = 'purging', updated_at = requested_at
  WHERE media.whatsapp_connection_id = selected_connection.id
    AND media.state = 'ready';

  RETURN QUERY SELECT selected_connection.personal_account_id,
    COALESCE((
      SELECT array_agg(candidates.object_key ORDER BY candidates.object_key)
      FROM (
        SELECT deletions.object_key
        FROM app.stored_media_object_deletions deletions
        JOIN app.stored_media media
          ON media.personal_account_id = deletions.personal_account_id
         AND media.object_key = deletions.object_key
        WHERE media.whatsapp_connection_id = selected_connection.id
        ORDER BY deletions.object_key
        LIMIT requested_limit
      ) candidates
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(candidates.object_key ORDER BY candidates.object_key)
      FROM (
        SELECT 'webhook-events/' || events.id::text AS object_key
        FROM app.webhook_events events
        WHERE events.whatsapp_connection_id = selected_connection.id
        ORDER BY events.id
        LIMIT requested_limit
      ) candidates
    ), ARRAY[]::text[]);
END
$function$;

CREATE FUNCTION app_private.finish_whatsapp_connection_webhook_source_deletion(
  requested_marker_id text,
  requested_object_key text
)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE requested_event_id uuid;
BEGIN
  IF requested_object_key !~ '^webhook-events/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid Webhook Event source object key';
  END IF;
  requested_event_id := substring(requested_object_key FROM 16)::uuid;
  DELETE FROM app.webhook_events events
  USING app.whatsapp_connections connections
  WHERE connections.deletion_marker_id = requested_marker_id
    AND connections.state = 'deleting'
    AND connections.provider_absence_confirmed_at IS NOT NULL
    AND events.personal_account_id = connections.personal_account_id
    AND events.whatsapp_connection_id = connections.id
    AND events.id = requested_event_id;
  RETURN FOUND OR NOT EXISTS (
    SELECT 1 FROM app.webhook_events events WHERE events.id = requested_event_id
  );
END
$function$;

-- Called only after provider-control has confirmed absence and both R2 source
-- classes are unavailable. Keeping this final mutation in one definer function
-- avoids granting broad table mutation authority to the API runtime.
CREATE FUNCTION app_private.finish_whatsapp_connection_cleanup(
  requested_marker_id text,
  provider_absence_confirmed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_connection app.whatsapp_connections%ROWTYPE;
DECLARE selected_setup_id text;
BEGIN
  SELECT connections.* INTO selected_connection
  FROM app.whatsapp_connections connections
  WHERE connections.deletion_marker_id = requested_marker_id
    AND connections.state = 'deleting'
    AND connections.provider_absence_confirmed_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN EXISTS (
      SELECT 1 FROM app_private.deleted_whatsapp_connection_handles deleted
      WHERE deleted.deletion_marker_id = requested_marker_id
    );
  END IF;
  IF provider_absence_confirmed_at < selected_connection.provider_absence_confirmed_at THEN
    RAISE EXCEPTION 'cleanup observation predates provider absence';
  END IF;

  -- Ready Stored Media must first pass through object deletion so quota is
  -- released only after the object is unavailable.
  IF EXISTS (
    SELECT 1 FROM app.stored_media media
    WHERE media.whatsapp_connection_id = selected_connection.id
  ) OR EXISTS (
    SELECT 1 FROM app.webhook_events events
    WHERE events.whatsapp_connection_id = selected_connection.id
  ) THEN
    RETURN false;
  END IF;

  selected_setup_id := selected_connection.connection_setup_id;
  INSERT INTO app_private.deleted_whatsapp_connection_handles(
    public_id, deletion_marker_id, deleted_at
  ) VALUES (
    selected_connection.public_id, requested_marker_id,
    selected_connection.provider_absence_confirmed_at
  ) ON CONFLICT (deletion_marker_id) DO NOTHING;

  DELETE FROM app.tool_call_logs logs
  USING app.send_operations operations
  WHERE operations.tool_call_log_id = logs.id
    AND operations.whatsapp_connection_id = selected_connection.id;

  DELETE FROM app.webhook_item_quarantines quarantines
  WHERE quarantines.whatsapp_connection_id = selected_connection.id;
  DELETE FROM app.webhook_items items
  WHERE items.whatsapp_connection_id = selected_connection.id;

  UPDATE app.whatsapp_connections SET connection_setup_id = NULL
  WHERE id = selected_connection.id;
  DELETE FROM app.whatsapp_connections WHERE id = selected_connection.id;

  IF selected_setup_id IS NOT NULL THEN
    DELETE FROM app.whatsapp_number_reservations
    WHERE connection_setup_id = selected_setup_id;
    DELETE FROM app.connection_setups WHERE id = selected_setup_id;
  END IF;
  RETURN true;
END
$function$;

REVOKE ALL ON TABLE app_private.deleted_whatsapp_connection_handles FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.list_whatsapp_connection_deletion_candidates(timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.confirm_whatsapp_connection_provider_absence(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.list_whatsapp_connection_active_purge_candidates(timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.prepare_whatsapp_connection_cleanup(text,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.finish_whatsapp_connection_webhook_source_deletion(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.finish_whatsapp_connection_cleanup(text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.list_whatsapp_connection_deletion_candidates(timestamptz,integer) TO whatsapp_deletion_runtime;
GRANT EXECUTE ON FUNCTION app_private.confirm_whatsapp_connection_provider_absence(text,timestamptz) TO whatsapp_deletion_runtime;
GRANT EXECUTE ON FUNCTION app_private.list_whatsapp_connection_active_purge_candidates(timestamptz,integer) TO whatsapp_api_runtime;
GRANT EXECUTE ON FUNCTION app_private.prepare_whatsapp_connection_cleanup(text,timestamptz,integer) TO whatsapp_api_runtime;
GRANT EXECUTE ON FUNCTION app_private.finish_whatsapp_connection_webhook_source_deletion(text,text) TO whatsapp_api_runtime;
GRANT EXECUTE ON FUNCTION app_private.finish_whatsapp_connection_cleanup(text,timestamptz) TO whatsapp_api_runtime;
