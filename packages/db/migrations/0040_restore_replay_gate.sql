DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'whatsapp_restore_runtime') THEN
    CREATE ROLE whatsapp_restore_runtime LOGIN;
  END IF;
  ALTER ROLE whatsapp_restore_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS NOINHERIT;
END
$role$;

GRANT USAGE ON SCHEMA app_private TO whatsapp_restore_runtime;
GRANT SELECT ON app_private.schema_migrations TO whatsapp_restore_runtime;

CREATE TABLE app_private.restore_readiness (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  branch_id text NOT NULL CHECK (branch_id ~ '^br-[A-Za-z0-9_-]{1,120}$'),
  state text NOT NULL CHECK (state IN ('replaying', 'ready')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  marker_count integer CHECK (marker_count IS NULL OR marker_count >= 0),
  deleted_entity_count integer CHECK (deleted_entity_count IS NULL OR deleted_entity_count >= 0),
  expired_record_count integer CHECK (expired_record_count IS NULL OR expired_record_count >= 0),
  CHECK ((state = 'replaying' AND completed_at IS NULL)
    OR (state = 'ready' AND completed_at IS NOT NULL
      AND marker_count IS NOT NULL AND deleted_entity_count IS NOT NULL
      AND expired_record_count IS NOT NULL))
);

CREATE TABLE app_private.restore_object_deletions (
  bucket text NOT NULL CHECK (bucket IN ('stored_media', 'webhook_ingress')),
  object_key text NOT NULL CHECK (object_key <> ''),
  PRIMARY KEY (bucket, object_key)
);

CREATE TABLE app_private.restore_replay_audit (
  branch_id text PRIMARY KEY CHECK (branch_id ~ '^br-[A-Za-z0-9_-]{1,120}$'),
  completed_at timestamptz NOT NULL,
  marker_count integer NOT NULL CHECK (marker_count >= 0),
  deleted_entity_count integer NOT NULL CHECK (deleted_entity_count >= 0),
  expired_record_count integer NOT NULL CHECK (expired_record_count >= 0)
);

CREATE FUNCTION app_private.is_restore_ready(requested_branch_id text)
RETURNS boolean LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT EXISTS (
    SELECT 1 FROM app_private.restore_readiness readiness
    WHERE readiness.singleton AND readiness.branch_id = requested_branch_id
      AND readiness.state = 'ready'
  )
$function$;

CREATE FUNCTION app_private.begin_restore_replay(
  requested_branch_id text, requested_at timestamptz
)
RETURNS TABLE (deletion_kind text, opaque_entity_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_branch_id !~ '^br-[A-Za-z0-9_-]{1,120}$' THEN
    RAISE invalid_parameter_value;
  END IF;
  INSERT INTO app_private.restore_readiness(singleton, branch_id, state, started_at)
  VALUES (true, requested_branch_id, 'replaying', requested_at)
  ON CONFLICT (singleton) DO UPDATE SET branch_id = excluded.branch_id,
    state = 'replaying', started_at = excluded.started_at, completed_at = NULL,
    marker_count = NULL, deleted_entity_count = NULL, expired_record_count = NULL
  WHERE restore_readiness.branch_id IS DISTINCT FROM excluded.branch_id
    OR restore_readiness.state IS DISTINCT FROM 'ready';
  RETURN QUERY
    SELECT 'personal_account'::text, accounts.id FROM app.personal_accounts accounts
    UNION ALL
    SELECT 'whatsapp_connection'::text, connections.id FROM app.whatsapp_connections connections;
END
$function$;

CREATE FUNCTION app_private.replay_restore_deletion(
  requested_kind text, requested_entity_id uuid, requested_marker_id text,
  requested_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_account_id uuid;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$'
    OR requested_kind NOT IN ('personal_account', 'whatsapp_connection') THEN
    RAISE invalid_parameter_value;
  END IF;
  IF requested_kind = 'personal_account' THEN
    selected_account_id := requested_entity_id;
  ELSE
    SELECT personal_account_id INTO selected_account_id
    FROM app.whatsapp_connections WHERE id = requested_entity_id;
  END IF;
  IF selected_account_id IS NULL THEN RETURN false; END IF;

  UPDATE app.personal_account_key_envelopes SET ciphertext = NULL,
    key_version = NULL, kms_key_id = NULL,
    unavailable_at = COALESCE(unavailable_at, requested_at)
  WHERE personal_account_id = selected_account_id;
  UPDATE app.whatsapp_connection_key_envelopes SET nonce = NULL,
    ciphertext = NULL, account_key_version = NULL, key_version = NULL,
    unavailable_at = COALESCE(unavailable_at, requested_at)
  WHERE personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account' OR whatsapp_connection_id = requested_entity_id);

  INSERT INTO app_private.restore_object_deletions(bucket, object_key)
  SELECT 'stored_media', media.object_key FROM app.stored_media media
  WHERE media.personal_account_id = selected_account_id AND media.object_key IS NOT NULL
    AND (requested_kind = 'personal_account' OR media.whatsapp_connection_id = requested_entity_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO app_private.restore_object_deletions(bucket, object_key)
  SELECT 'webhook_ingress', 'webhook-events/' || events.id::text
  FROM app.webhook_events events
  WHERE events.personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account' OR events.whatsapp_connection_id = requested_entity_id)
  ON CONFLICT DO NOTHING;

  IF requested_kind = 'personal_account' THEN
    DELETE FROM app.personal_accounts WHERE id = requested_entity_id;
  ELSE
    INSERT INTO app_private.deleted_whatsapp_connection_handles(public_id, deletion_marker_id, deleted_at)
    SELECT public_id, requested_marker_id, requested_at FROM app.whatsapp_connections
    WHERE id = requested_entity_id ON CONFLICT DO NOTHING;
    DELETE FROM app.whatsapp_connections WHERE id = requested_entity_id;
  END IF;
  RETURN true;
END
$function$;

CREATE FUNCTION app_private.purge_restore_expired(requested_at timestamptz, requested_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE purged integer := 0; affected integer;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN RAISE invalid_parameter_value; END IF;
  SELECT app_private.purge_expired_message_content(requested_at, requested_limit) INTO affected;
  purged := purged + affected;
  WITH candidates AS (
    SELECT operations.id FROM app.send_operations operations
    WHERE operations.expires_at <= requested_at ORDER BY operations.expires_at, operations.id
    LIMIT requested_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM app.send_operations operations USING candidates
    WHERE operations.id = candidates.id;
  GET DIAGNOSTICS affected = ROW_COUNT; purged := purged + affected;
  WITH candidates AS (
    SELECT logs.id FROM app.tool_call_logs logs WHERE logs.expires_at <= requested_at
    ORDER BY logs.expires_at, logs.id LIMIT requested_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM app.tool_call_logs logs USING candidates WHERE logs.id = candidates.id;
  GET DIAGNOSTICS affected = ROW_COUNT; purged := purged + affected;
  WITH candidates AS (
    SELECT records.ctid FROM app_private.security_records records
    WHERE records.expires_at <= requested_at ORDER BY records.expires_at
    LIMIT requested_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM app_private.security_records records USING candidates
    WHERE records.ctid = candidates.ctid;
  GET DIAGNOSTICS affected = ROW_COUNT; purged := purged + affected;
  RETURN purged;
END
$function$;

CREATE FUNCTION app_private.list_restore_object_deletions(requested_limit integer)
RETURNS TABLE (bucket text, object_key text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN RAISE invalid_parameter_value; END IF;
  RETURN QUERY SELECT deletions.bucket, deletions.object_key
  FROM app_private.restore_object_deletions deletions
  ORDER BY deletions.bucket, deletions.object_key LIMIT requested_limit;
END
$function$;

CREATE FUNCTION app_private.finish_restore_object_deletion(requested_bucket text, requested_object_key text)
RETURNS void LANGUAGE sql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
  DELETE FROM app_private.restore_object_deletions
  WHERE bucket = requested_bucket AND object_key = requested_object_key
$function$;

CREATE FUNCTION app_private.complete_restore_replay(
  requested_branch_id text, requested_at timestamptz, requested_marker_count integer,
  requested_deleted_count integer, requested_expired_count integer
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_private.restore_readiness
    WHERE singleton AND branch_id = requested_branch_id AND state = 'ready'
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.restore_object_deletions) THEN
    RAISE EXCEPTION 'restore object deletions remain';
  END IF;
  UPDATE app_private.restore_readiness SET state = 'ready', completed_at = requested_at,
    marker_count = requested_marker_count, deleted_entity_count = requested_deleted_count,
    expired_record_count = requested_expired_count
  WHERE singleton AND branch_id = requested_branch_id AND state = 'replaying';
  IF NOT FOUND THEN RAISE EXCEPTION 'restore replay is not active'; END IF;
  INSERT INTO app_private.restore_replay_audit
    (branch_id, completed_at, marker_count, deleted_entity_count, expired_record_count)
  VALUES (requested_branch_id, requested_at, requested_marker_count,
    requested_deleted_count, requested_expired_count)
  ON CONFLICT (branch_id) DO UPDATE SET completed_at = excluded.completed_at,
    marker_count = excluded.marker_count, deleted_entity_count = excluded.deleted_entity_count,
    expired_record_count = excluded.expired_record_count;
END
$function$;

REVOKE ALL ON TABLE app_private.restore_readiness, app_private.restore_object_deletions,
  app_private.restore_replay_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.is_restore_ready(text),
  app_private.begin_restore_replay(text,timestamptz),
  app_private.replay_restore_deletion(text,uuid,text,timestamptz),
  app_private.purge_restore_expired(timestamptz,integer),
  app_private.list_restore_object_deletions(integer),
  app_private.finish_restore_object_deletion(text,text),
  app_private.complete_restore_replay(text,timestamptz,integer,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.is_restore_ready(text) TO whatsapp_api_runtime,
  whatsapp_webhook_runtime, whatsapp_deletion_runtime, whatsapp_restore_runtime;
GRANT EXECUTE ON FUNCTION app_private.begin_restore_replay(text,timestamptz),
  app_private.replay_restore_deletion(text,uuid,text,timestamptz),
  app_private.purge_restore_expired(timestamptz,integer),
  app_private.list_restore_object_deletions(integer),
  app_private.finish_restore_object_deletion(text,text),
  app_private.complete_restore_replay(text,timestamptz,integer,integer,integer)
  TO whatsapp_restore_runtime;
