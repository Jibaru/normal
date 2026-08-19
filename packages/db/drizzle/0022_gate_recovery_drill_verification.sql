-- Disposable recovery drills remain permanently non-serving. Replay completion
-- moves them to an independently verifiable state, while ordinary incident
-- restores retain the existing serving-ready transition.
ALTER TABLE public.restore_readiness
  ADD COLUMN verification_required boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE public.restore_readiness
  DROP CONSTRAINT restore_readiness_state_check;
--> statement-breakpoint

ALTER TABLE public.restore_readiness
  ADD CONSTRAINT restore_readiness_state_check
    CHECK (state IN ('replaying', 'awaiting_verification', 'drill_verified', 'ready'));
--> statement-breakpoint

ALTER TABLE public.restore_readiness
  DROP CONSTRAINT restore_readiness_check;
--> statement-breakpoint

ALTER TABLE public.restore_readiness
  ADD CONSTRAINT restore_readiness_check CHECK (
    (state = 'replaying' AND completed_at IS NULL)
    OR (
      state IN ('awaiting_verification', 'drill_verified', 'ready')
      AND completed_at IS NOT NULL
      AND marker_count IS NOT NULL
      AND deleted_entity_count IS NOT NULL
      AND expired_record_count IS NOT NULL
      AND api_keys_revoked IS NOT NULL
      AND api_key_digests_cleared IS NOT NULL
      AND (
        (verification_required AND state IN ('awaiting_verification', 'drill_verified'))
        OR (NOT verification_required AND state = 'ready')
      )
    )
  );
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.begin_restore_replay(text,timestamptz)
  FROM PUBLIC, whatsapp_restore_runtime;
--> statement-breakpoint

DROP FUNCTION public.begin_restore_replay(text,timestamptz);
--> statement-breakpoint

CREATE FUNCTION public.begin_restore_replay(
  requested_branch_id text,
  requested_at timestamptz,
  require_verification boolean DEFAULT false
)
RETURNS TABLE (deletion_kind text, opaque_entity_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_branch_id !~ '^br-[A-Za-z0-9_-]{1,120}$' THEN
    RAISE invalid_parameter_value;
  END IF;
  INSERT INTO public.restore_readiness(
    singleton, branch_id, state, started_at, verification_required,
    api_keys_revoked, api_key_digests_cleared
  )
  VALUES (
    true, requested_branch_id, 'replaying', requested_at,
    require_verification, 0, 0
  )
  ON CONFLICT (singleton) DO UPDATE SET branch_id = excluded.branch_id,
    state = 'replaying', started_at = excluded.started_at, completed_at = NULL,
    marker_count = NULL, deleted_entity_count = NULL, expired_record_count = NULL,
    api_keys_revoked = 0, api_key_digests_cleared = 0,
    verification_required = excluded.verification_required
  WHERE restore_readiness.branch_id IS DISTINCT FROM excluded.branch_id
    OR restore_readiness.state NOT IN ('ready', 'drill_verified');
  RETURN QUERY
    SELECT 'personal_account'::text, accounts.id FROM public.personal_accounts accounts
    UNION ALL
    SELECT 'whatsapp_connection'::text, connections.id FROM public.whatsapp_connections connections;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.complete_restore_replay(
  requested_branch_id text, requested_at timestamptz, requested_marker_count integer,
  requested_deleted_count integer, requested_expired_count integer
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  revoked_count integer;
  digest_count integer;
  require_verification boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.restore_readiness
    WHERE singleton AND branch_id = requested_branch_id
      AND state IN ('ready', 'awaiting_verification', 'drill_verified')
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.restore_object_deletions)
    OR EXISTS (SELECT 1 FROM public.stored_media_object_deletions) THEN
    RAISE EXCEPTION 'restore object deletions remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.whatsapp_recipient_exclusions
    WHERE transition_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'recipient exclusion transitions remain unresolved';
  END IF;
  SELECT readiness.api_keys_revoked, readiness.api_key_digests_cleared,
      readiness.verification_required
    INTO revoked_count, digest_count, require_verification
  FROM public.restore_readiness readiness
  WHERE readiness.singleton AND readiness.branch_id = requested_branch_id
    AND readiness.state = 'replaying';
  IF NOT FOUND THEN RAISE EXCEPTION 'restore replay is not active'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.api_keys
    WHERE state = 'active' OR credential_digest IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'restored api keys remain authenticable';
  END IF;
  IF revoked_count IS NULL OR digest_count IS NULL THEN
    RAISE EXCEPTION 'restore api key invalidation evidence is incomplete';
  END IF;
  UPDATE public.restore_readiness SET
    state = CASE WHEN require_verification
      THEN 'awaiting_verification' ELSE 'ready' END,
    completed_at = requested_at,
    marker_count = requested_marker_count,
    deleted_entity_count = requested_deleted_count,
    expired_record_count = requested_expired_count,
    api_keys_revoked = revoked_count,
    api_key_digests_cleared = digest_count
  WHERE singleton AND branch_id = requested_branch_id AND state = 'replaying';
  IF NOT FOUND THEN RAISE EXCEPTION 'restore replay is not active'; END IF;
  INSERT INTO public.restore_replay_audit
    (branch_id, completed_at, marker_count, deleted_entity_count, expired_record_count,
     api_keys_revoked, api_key_digests_cleared)
  VALUES (requested_branch_id, requested_at, requested_marker_count,
    requested_deleted_count, requested_expired_count, revoked_count, digest_count)
  ON CONFLICT (branch_id) DO UPDATE SET completed_at = excluded.completed_at,
    marker_count = excluded.marker_count, deleted_entity_count = excluded.deleted_entity_count,
    expired_record_count = excluded.expired_record_count,
    api_keys_revoked = excluded.api_keys_revoked,
    api_key_digests_cleared = excluded.api_key_digests_cleared;
END
$function$;
--> statement-breakpoint

DROP FUNCTION public.verify_recovery_branch(text,timestamptz);
--> statement-breakpoint

CREATE FUNCTION public.verify_recovery_branch(
  requested_branch_id text,
  observed_at timestamptz
)
RETURNS TABLE (
  schema_ok boolean,
  rls_ok boolean,
  invariants_ok boolean,
  quota_ok boolean,
  audit_ok boolean,
  expiry_ok boolean,
  deletion_ok boolean,
  recipient_ok boolean,
  object_intent_ok boolean,
  api_key_ok boolean
)
LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  readiness public.restore_readiness%ROWTYPE;
BEGIN
  IF requested_branch_id !~ '^br-[A-Za-z0-9_-]{1,120}$' THEN
    RAISE invalid_parameter_value;
  END IF;
  SELECT candidate.* INTO readiness FROM public.restore_readiness AS candidate
  WHERE candidate.singleton;
  IF NOT FOUND OR readiness.branch_id IS DISTINCT FROM requested_branch_id
    OR readiness.state NOT IN ('awaiting_verification', 'drill_verified')
    OR NOT readiness.verification_required THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'recovery verifier branch mismatch';
  END IF;
  RETURN QUERY SELECT
    COALESCE((SELECT max(migrations.created_at) = 1787130000000
      FROM public.drizzle_migrations AS migrations), false),
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS roles
      WHERE roles.rolname IN ('whatsapp_api_runtime', 'whatsapp_webhook_runtime')
        AND (roles.rolsuper OR roles.rolbypassrls)
    ) AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relations
      JOIN pg_catalog.pg_namespace AS namespaces
        ON namespaces.oid = relations.relnamespace
      JOIN pg_catalog.pg_attribute AS attributes
        ON attributes.attrelid = relations.oid
      CROSS JOIN pg_catalog.pg_roles AS runtime_roles
      WHERE namespaces.nspname = 'public'
        AND relations.relkind = 'r'
        AND attributes.attname = 'personal_account_id'
        AND NOT attributes.attisdropped
        AND runtime_roles.rolname IN (
          'whatsapp_api_runtime', 'whatsapp_webhook_runtime'
        )
        AND pg_catalog.has_table_privilege(
          runtime_roles.rolname, relations.oid,
          'SELECT,INSERT,UPDATE,DELETE'
        )
        AND (NOT relations.relrowsecurity OR NOT relations.relforcerowsecurity)
    ),
    readiness.started_at <= readiness.completed_at
      AND readiness.completed_at <= observed_at
      AND readiness.marker_count >= readiness.deleted_entity_count,
    NOT EXISTS (
      SELECT 1 FROM public.personal_accounts AS accounts
      WHERE accounts.stored_media_used_bytes > accounts.stored_media_limit_bytes
        OR accounts.stored_media_used_bytes <> (
          SELECT COALESCE(sum(media.plaintext_size_bytes), 0)
          FROM public.stored_media AS media
          WHERE media.personal_account_id = accounts.id
            AND media.state IN ('ready', 'purging')
        )
        OR (SELECT count(*) FROM public.whatsapp_connections AS connections
          WHERE connections.personal_account_id = accounts.id
            AND connections.state <> 'deleted') > accounts.whatsapp_connection_limit
        OR (SELECT count(*) FROM public.api_keys AS keys
          WHERE keys.personal_account_id = accounts.id
            AND keys.state = 'active') > 10
    ),
    COALESCE(EXISTS (
      SELECT 1 FROM public.restore_replay_audit AS audit
      WHERE audit.branch_id = requested_branch_id
        AND audit.completed_at = readiness.completed_at
        AND audit.marker_count = readiness.marker_count
        AND audit.deleted_entity_count = readiness.deleted_entity_count
        AND audit.expired_record_count = readiness.expired_record_count
        AND audit.api_keys_revoked = readiness.api_keys_revoked
        AND audit.api_key_digests_cleared = readiness.api_key_digests_cleared
    ), false),
    NOT EXISTS (SELECT 1 FROM public.pending_send_contents WHERE expires_at <= observed_at)
      AND NOT EXISTS (SELECT 1 FROM public.send_operations WHERE expires_at <= observed_at)
      AND NOT EXISTS (SELECT 1 FROM public.tool_call_logs WHERE expires_at <= observed_at)
      AND NOT EXISTS (SELECT 1 FROM public.security_records WHERE expires_at <= observed_at)
      AND NOT EXISTS (
        SELECT 1 FROM public.stored_messages AS messages
        JOIN public.whatsapp_connections AS connections
          ON connections.personal_account_id = messages.personal_account_id
         AND connections.id = messages.whatsapp_connection_id
        WHERE messages.content_expired_at IS NULL AND messages.deleted_at IS NULL
          AND connections.message_retention_days IS NOT NULL
          AND messages.sent_at + pg_catalog.make_interval(
            days => connections.message_retention_days) <= observed_at
      ),
    readiness.marker_count >= readiness.deleted_entity_count,
    NOT EXISTS (SELECT 1 FROM public.whatsapp_recipient_exclusions
      WHERE transition_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM public.whatsapp_recipient_transition_prefixes),
    NOT EXISTS (SELECT 1 FROM public.restore_object_deletions)
      AND NOT EXISTS (SELECT 1 FROM public.stored_media_object_deletions),
    NOT EXISTS (SELECT 1 FROM public.api_keys
      WHERE state = 'active' OR credential_digest IS NOT NULL);
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.complete_recovery_drill_verification(
  requested_branch_id text,
  verified_at timestamptz
)
RETURNS void LANGUAGE plpgsql STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.restore_readiness
    WHERE singleton AND branch_id = requested_branch_id
      AND state = 'drill_verified' AND verification_required
  ) THEN
    RETURN;
  END IF;
  UPDATE public.restore_readiness SET state = 'drill_verified'
  WHERE singleton AND branch_id = requested_branch_id
    AND state = 'awaiting_verification' AND verification_required
    AND completed_at <= verified_at;
  IF NOT FOUND THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'recovery verifier branch mismatch';
  END IF;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
  public.begin_restore_replay(text,timestamptz,boolean),
  public.verify_recovery_branch(text,timestamptz),
  public.complete_recovery_drill_verification(text,timestamptz)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.begin_restore_replay(text,timestamptz,boolean)
  TO whatsapp_restore_runtime;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.complete_recovery_drill_verification(text,timestamptz)
  TO whatsapp_recovery_verifier;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.verify_recovery_branch(text,timestamptz)
  TO whatsapp_recovery_verifier;
