CREATE TABLE public.send_operation_objects (
  send_operation_id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'purging')),
  object_key text NOT NULL UNIQUE CHECK (object_key <> ''),
  plaintext_size_bytes bigint NOT NULL
    CHECK (plaintext_size_bytes > 0 AND plaintext_size_bytes <= 16777216),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT send_operation_objects_send_operation_fkey FOREIGN KEY (
    send_operation_id, personal_account_id
  ) REFERENCES public.send_operations(id, personal_account_id),
  CONSTRAINT send_operation_objects_connection_fkey FOREIGN KEY (
    personal_account_id, whatsapp_connection_id
  ) REFERENCES public.whatsapp_connections(personal_account_id, id)
);
--> statement-breakpoint

ALTER TABLE public.send_operation_objects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.send_operation_objects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY send_operation_objects_tenant ON public.send_operation_objects
  USING (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.send_operation_objects
  TO whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint

-- Pending content and its encrypted outbound object have the same readability
-- lifetime. The object row remains quota-bearing until R2 confirms deletion.
CREATE FUNCTION public.purge_send_operation_object_with_pending_content()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
BEGIN
  INSERT INTO public.stored_media_object_deletions(
    personal_account_id, object_key, requested_at
  )
  SELECT objects.personal_account_id, objects.object_key, statement_timestamp()
  FROM public.send_operation_objects objects
  WHERE objects.personal_account_id = OLD.personal_account_id
    AND objects.send_operation_id = OLD.send_operation_id
    AND objects.state = 'ready'
  ON CONFLICT DO NOTHING;

  UPDATE public.send_operation_objects objects
  SET state = 'purging'
  WHERE objects.personal_account_id = OLD.personal_account_id
    AND objects.send_operation_id = OLD.send_operation_id
    AND objects.state = 'ready';
  RETURN OLD;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER purge_send_operation_object_with_pending_content
BEFORE DELETE ON public.pending_send_contents
FOR EACH ROW EXECUTE FUNCTION public.purge_send_operation_object_with_pending_content();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_send_operation_object_with_pending_content() FROM PUBLIC;
--> statement-breakpoint

-- Connection and Personal Account Deletion remove readable Pending Send
-- Content immediately; the normal pending-content trigger creates the object
-- deletion intent before content keys become unusable.
CREATE FUNCTION public.purge_pending_send_content_on_connection_deletion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
BEGIN
  IF OLD.state <> 'deleting' AND NEW.state = 'deleting' THEN
    DELETE FROM public.pending_send_contents pending
    WHERE pending.personal_account_id = NEW.personal_account_id
      AND pending.whatsapp_connection_id = NEW.id;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER purge_pending_send_content_on_connection_deletion
AFTER UPDATE OF state ON public.whatsapp_connections
FOR EACH ROW EXECUTE FUNCTION public.purge_pending_send_content_on_connection_deletion();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_pending_send_content_on_connection_deletion() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.finish_stored_media_object_deletion(
  requested_account_id uuid, requested_object_key text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
DECLARE released_bytes bigint;
BEGIN
  PERFORM 1 FROM public.personal_accounts
  WHERE id = requested_account_id FOR UPDATE;

  SELECT plaintext_size_bytes INTO released_bytes
  FROM public.stored_media
  WHERE personal_account_id = requested_account_id
    AND object_key = requested_object_key AND state = 'purging'
  FOR UPDATE;
  IF released_bytes IS NOT NULL THEN
    DELETE FROM public.stored_media
    WHERE personal_account_id = requested_account_id
      AND object_key = requested_object_key AND state = 'purging';
  ELSE
    SELECT plaintext_size_bytes INTO released_bytes
    FROM public.send_operation_objects
    WHERE personal_account_id = requested_account_id
      AND object_key = requested_object_key AND state = 'purging'
    FOR UPDATE;
    IF released_bytes IS NOT NULL THEN
      DELETE FROM public.send_operation_objects
      WHERE personal_account_id = requested_account_id
        AND object_key = requested_object_key AND state = 'purging';
    END IF;
  END IF;

  IF released_bytes IS NOT NULL THEN
    UPDATE public.personal_accounts
    SET stored_media_used_bytes = stored_media_used_bytes - released_bytes
    WHERE id = requested_account_id;
  END IF;
  DELETE FROM public.stored_media_object_deletions
  WHERE personal_account_id = requested_account_id
    AND object_key = requested_object_key;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.prepare_whatsapp_connection_cleanup(
  requested_marker_id text, requested_at timestamptz, requested_limit integer
)
RETURNS TABLE (
  personal_account_id uuid,
  stored_media_object_keys text[],
  webhook_source_object_keys text[]
)
LANGUAGE plpgsql STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_connection public.whatsapp_connections%ROWTYPE;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid Connection Deletion object limit';
  END IF;
  SELECT connections.* INTO selected_connection
  FROM public.whatsapp_connections connections
  WHERE connections.deletion_marker_id = requested_marker_id
    AND connections.state = 'deleting'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF selected_connection.provider_absence_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'provider absence is not confirmed';
  END IF;

  DELETE FROM public.stored_media media
  WHERE media.whatsapp_connection_id = selected_connection.id
    AND media.state IN ('pending','rejected','failed');
  INSERT INTO public.stored_media_object_deletions(
    personal_account_id, object_key, requested_at
  )
  SELECT media.personal_account_id, media.object_key, requested_at
  FROM public.stored_media media
  WHERE media.whatsapp_connection_id = selected_connection.id
    AND media.state = 'ready'
  UNION ALL
  SELECT objects.personal_account_id, objects.object_key, requested_at
  FROM public.send_operation_objects objects
  WHERE objects.whatsapp_connection_id = selected_connection.id
    AND objects.state = 'ready'
  ON CONFLICT DO NOTHING;
  UPDATE public.stored_media media SET state = 'purging', updated_at = requested_at
  WHERE media.whatsapp_connection_id = selected_connection.id
    AND media.state = 'ready';
  UPDATE public.send_operation_objects objects SET state = 'purging'
  WHERE objects.whatsapp_connection_id = selected_connection.id
    AND objects.state = 'ready';

  RETURN QUERY SELECT selected_connection.personal_account_id,
    COALESCE((
      SELECT array_agg(candidates.object_key ORDER BY candidates.object_key)
      FROM (
        SELECT deletions.object_key
        FROM public.stored_media_object_deletions deletions
        WHERE deletions.personal_account_id = selected_connection.personal_account_id
          AND (
            EXISTS (SELECT 1 FROM public.stored_media media
              WHERE media.personal_account_id = deletions.personal_account_id
                AND media.object_key = deletions.object_key
                AND media.whatsapp_connection_id = selected_connection.id)
            OR EXISTS (SELECT 1 FROM public.send_operation_objects objects
              WHERE objects.personal_account_id = deletions.personal_account_id
                AND objects.object_key = deletions.object_key
                AND objects.whatsapp_connection_id = selected_connection.id)
          )
        ORDER BY deletions.object_key LIMIT requested_limit
      ) candidates
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(candidates.object_key ORDER BY candidates.object_key)
      FROM (
        SELECT 'webhook-events/' || events.id::text AS object_key
        FROM public.webhook_events events
        WHERE events.whatsapp_connection_id = selected_connection.id
        ORDER BY events.id LIMIT requested_limit
      ) candidates
    ), ARRAY[]::text[]);
END
$function$;
--> statement-breakpoint

-- Final connection removal is blocked until both retained object classes have
-- passed through confirmed R2 deletion.
DO $migration$
DECLARE function_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.finish_whatsapp_connection_cleanup(text,timestamptz)'::regprocedure
  ) INTO function_definition;
  IF pg_catalog.strpos(function_definition,
    'SELECT 1 FROM public.webhook_events events') = 0 THEN
    RAISE EXCEPTION 'finish_whatsapp_connection_cleanup definition is unexpected';
  END IF;
  EXECUTE pg_catalog.replace(function_definition,
    'SELECT 1 FROM public.webhook_events events',
    'SELECT 1 FROM public.send_operation_objects objects
    WHERE objects.whatsapp_connection_id = selected_connection.id
  ) OR EXISTS (
    SELECT 1 FROM public.webhook_events events');
END
$migration$;
--> statement-breakpoint

-- Restore deletion intents retain the charge when entity rows must be removed
-- before R2 is contacted. Ordinary restore retention intents leave it null and
-- continue to release through the live object row.
ALTER TABLE public.restore_object_deletions
  ADD COLUMN retained_bytes bigint CHECK (retained_bytes > 0);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.replay_restore_deletion(
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
    FROM public.whatsapp_connections WHERE id = requested_entity_id;
  END IF;
  IF selected_account_id IS NULL THEN RETURN false; END IF;

  UPDATE public.personal_account_key_envelopes SET ciphertext = NULL,
    key_version = NULL, kms_key_id = NULL,
    unavailable_at = COALESCE(unavailable_at, requested_at)
  WHERE personal_account_id = selected_account_id;
  UPDATE public.whatsapp_connection_key_envelopes SET nonce = NULL,
    ciphertext = NULL, account_key_version = NULL, key_version = NULL,
    unavailable_at = COALESCE(unavailable_at, requested_at)
  WHERE personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account' OR whatsapp_connection_id = requested_entity_id);

  INSERT INTO public.restore_object_deletions(
    bucket, object_key, personal_account_id, retained_bytes
  )
  SELECT 'stored_media', objects.object_key, objects.personal_account_id,
    objects.plaintext_size_bytes
  FROM public.send_operation_objects objects
  WHERE objects.personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account'
      OR objects.whatsapp_connection_id = requested_entity_id)
  ON CONFLICT (bucket, object_key) DO UPDATE SET
    personal_account_id = excluded.personal_account_id,
    retained_bytes = excluded.retained_bytes;
  DELETE FROM public.stored_media_object_deletions deletions
  USING public.send_operation_objects objects
  WHERE objects.personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account'
      OR objects.whatsapp_connection_id = requested_entity_id)
    AND deletions.personal_account_id = objects.personal_account_id
    AND deletions.object_key = objects.object_key;
  DELETE FROM public.send_operation_objects objects
  WHERE objects.personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account'
      OR objects.whatsapp_connection_id = requested_entity_id);

  INSERT INTO public.restore_object_deletions(bucket, object_key)
  SELECT 'stored_media', media.object_key FROM public.stored_media media
  WHERE media.personal_account_id = selected_account_id AND media.object_key IS NOT NULL
    AND (requested_kind = 'personal_account' OR media.whatsapp_connection_id = requested_entity_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.restore_object_deletions(bucket, object_key)
  SELECT 'webhook_ingress', 'webhook-events/' || events.id::text
  FROM public.webhook_events events
  WHERE events.personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account' OR events.whatsapp_connection_id = requested_entity_id)
  ON CONFLICT DO NOTHING;

  IF requested_kind = 'personal_account' THEN
    DELETE FROM public.personal_accounts WHERE id = requested_entity_id;
  ELSE
    INSERT INTO public.deleted_whatsapp_connection_handles(public_id, deletion_marker_id, deleted_at)
    SELECT public_id, requested_marker_id, requested_at FROM public.whatsapp_connections
    WHERE id = requested_entity_id ON CONFLICT DO NOTHING;
    DELETE FROM public.whatsapp_connections WHERE id = requested_entity_id;
  END IF;
  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.finish_restore_object_deletion(
  requested_bucket text, requested_object_key text
)
RETURNS void LANGUAGE plpgsql STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_account_id uuid; selected_retained_bytes bigint;
BEGIN
  SELECT personal_account_id, retained_bytes
  INTO selected_account_id, selected_retained_bytes
  FROM public.restore_object_deletions
  WHERE bucket = requested_bucket AND object_key = requested_object_key;
  IF requested_bucket = 'stored_media' AND selected_account_id IS NOT NULL THEN
    IF selected_retained_bytes IS NULL THEN
      PERFORM public.finish_stored_media_object_deletion(
        selected_account_id, requested_object_key
      );
    ELSE
      UPDATE public.personal_accounts
      SET stored_media_used_bytes = stored_media_used_bytes - selected_retained_bytes
      WHERE id = selected_account_id;
    END IF;
  END IF;
  DELETE FROM public.restore_object_deletions
  WHERE bucket = requested_bucket AND object_key = requested_object_key;
END
$function$;
--> statement-breakpoint

-- Extend quota, expiry, object-intent, and schema-version recovery checks.
DO $migration$
DECLARE function_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.verify_recovery_branch(text,timestamptz)'::regprocedure
  ) INTO function_definition;
  IF pg_catalog.strpos(function_definition, '1787250000000') = 0 THEN
    RAISE EXCEPTION 'verify_recovery_branch schema version is unexpected';
  END IF;
  function_definition := pg_catalog.replace(
    function_definition, '1787250000000', '1787253600000');
  function_definition := pg_catalog.replace(function_definition,
    'FROM public.stored_media AS media
          WHERE media.personal_account_id = accounts.id
            AND media.state IN (''ready'', ''purging'')',
    'FROM (
            SELECT media.personal_account_id, media.plaintext_size_bytes
            FROM public.stored_media AS media
            WHERE media.state IN (''ready'', ''purging'')
            UNION ALL
            SELECT objects.personal_account_id, objects.plaintext_size_bytes
            FROM public.send_operation_objects AS objects
            WHERE objects.state IN (''ready'', ''purging'')
          ) AS media
          WHERE media.personal_account_id = accounts.id');
  function_definition := pg_catalog.replace(function_definition,
    'AND NOT EXISTS (SELECT 1 FROM public.stored_media_object_deletions)',
    'AND NOT EXISTS (SELECT 1 FROM public.stored_media_object_deletions)
      AND NOT EXISTS (
        SELECT 1 FROM public.send_operation_objects objects
        WHERE objects.state = ''ready'' AND NOT EXISTS (
          SELECT 1 FROM public.pending_send_contents pending
          WHERE pending.personal_account_id = objects.personal_account_id
            AND pending.send_operation_id = objects.send_operation_id
        )
      )');
  IF pg_catalog.strpos(function_definition, 'public.send_operation_objects') = 0 THEN
    RAISE EXCEPTION 'verify_recovery_branch object checks were not extended';
  END IF;
  EXECUTE function_definition;
END
$migration$;
