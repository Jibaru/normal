-- Disposable recovery drills remain permanently non-serving. Replay completion
-- moves them to an independently verifiable state, while ordinary incident
-- restores retain the existing serving-ready transition.
ALTER TABLE public.restore_readiness
  ADD COLUMN verification_required boolean NOT NULL DEFAULT false,
  ADD COLUMN rls_probe_first_account_id uuid,
  ADD COLUMN rls_probe_second_account_id uuid,
  ADD CONSTRAINT restore_readiness_rls_probe_check CHECK (
    (rls_probe_first_account_id IS NULL AND rls_probe_second_account_id IS NULL)
    OR (
      rls_probe_first_account_id IS NOT NULL
      AND rls_probe_second_account_id IS NOT NULL
      AND rls_probe_first_account_id <> rls_probe_second_account_id
    )
  );
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
    verification_required = excluded.verification_required,
    rls_probe_first_account_id = NULL, rls_probe_second_account_id = NULL
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
  recipient_transition_ok boolean,
  recipient_cutoff_ok boolean,
  recipient_content_ok boolean,
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
      WHERE transition_id IS NOT NULL),
    NOT EXISTS (
      SELECT 1 FROM public.whatsapp_recipient_exclusions AS rules
      WHERE rules.excluded
        AND (rules.effective_at IS NULL OR rules.purge_cutoff_at IS NULL)
    ),
    NOT EXISTS (
      SELECT 1
      FROM public.whatsapp_recipient_exclusions AS rules
      JOIN public.whatsapp_conversations AS conversations
        ON conversations.personal_account_id = rules.personal_account_id
       AND conversations.whatsapp_connection_id = rules.whatsapp_connection_id
       AND conversations.recipient_locator = rules.recipient_locator
      LEFT JOIN public.stored_messages AS messages
        ON messages.personal_account_id = conversations.personal_account_id
       AND messages.whatsapp_connection_id = conversations.whatsapp_connection_id
       AND messages.conversation_id = conversations.id
       AND messages.created_at <= rules.purge_cutoff_at
      LEFT JOIN public.stored_media AS media
        ON media.personal_account_id = messages.personal_account_id
       AND media.whatsapp_connection_id = messages.whatsapp_connection_id
       AND media.stored_message_id = messages.id
      WHERE rules.purge_cutoff_at IS NOT NULL
        AND (
          (rules.excluded AND conversations.id IS NOT NULL)
          OR (messages.id IS NOT NULL AND messages.content_expired_at IS NULL)
          OR media.id IS NOT NULL
        )
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.whatsapp_recipient_exclusions AS rules
      JOIN public.send_operations AS operations
        ON operations.personal_account_id = rules.personal_account_id
       AND operations.whatsapp_connection_id = rules.whatsapp_connection_id
       AND operations.recipient_public_id = rules.recipient_public_id
       AND operations.created_at <= rules.purge_cutoff_at
      JOIN public.pending_send_contents AS contents
        ON contents.personal_account_id = operations.personal_account_id
       AND contents.send_operation_id = operations.id
      WHERE rules.purge_cutoff_at IS NOT NULL
    ),
    NOT EXISTS (SELECT 1 FROM public.restore_object_deletions)
      AND NOT EXISTS (SELECT 1 FROM public.stored_media_object_deletions),
    NOT EXISTS (SELECT 1 FROM public.api_keys
      WHERE state = 'active' OR credential_digest IS NOT NULL);
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.prepare_recovery_rls_probe(
  requested_branch_id text,
  first_account_id uuid,
  second_account_id uuid
)
RETURNS boolean LANGUAGE plpgsql STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  current_state text;
  current_first_account_id uuid;
  current_second_account_id uuid;
  existing_count integer;
BEGIN
  IF first_account_id = second_account_id THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'recovery verifier branch mismatch';
  END IF;
  SELECT state, rls_probe_first_account_id, rls_probe_second_account_id
    INTO current_state, current_first_account_id, current_second_account_id
  FROM public.restore_readiness
  WHERE singleton AND branch_id = requested_branch_id
    AND verification_required
    AND state IN ('awaiting_verification', 'drill_verified')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'recovery verifier branch mismatch';
  END IF;
  IF current_state = 'drill_verified'
    AND current_first_account_id IS NULL
    AND current_second_account_id IS NULL THEN
    RETURN false;
  END IF;
  IF current_state <> 'awaiting_verification' THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'recovery verifier branch mismatch';
  END IF;
  IF current_first_account_id = first_account_id
    AND current_second_account_id = second_account_id THEN
    SELECT count(*) INTO existing_count
    FROM public.personal_accounts
    WHERE id IN (first_account_id, second_account_id);
    IF existing_count <> 2 THEN
      RAISE integrity_constraint_violation
        USING MESSAGE = 'recovery RLS probe state is incomplete';
    END IF;
    RETURN true;
  END IF;
  IF current_first_account_id IS NOT NULL
    OR current_second_account_id IS NOT NULL THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'recovery verifier branch mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.personal_accounts
    WHERE id IN (first_account_id, second_account_id)
  ) THEN
    RAISE integrity_constraint_violation
      USING MESSAGE = 'recovery RLS probe identity already exists';
  END IF;
  UPDATE public.restore_readiness SET
    rls_probe_first_account_id = first_account_id,
    rls_probe_second_account_id = second_account_id
  WHERE singleton AND branch_id = requested_branch_id;
  INSERT INTO public.personal_accounts (id, state)
  VALUES (first_account_id, 'active'), (second_account_id, 'active');
  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.complete_recovery_rls_probe(
  requested_branch_id text,
  first_account_id uuid,
  second_account_id uuid
)
RETURNS void LANGUAGE plpgsql STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  deleted_count integer;
BEGIN
  IF first_account_id = second_account_id THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'recovery verifier branch mismatch';
  END IF;
  DELETE FROM public.stored_media_object_deletions AS deletions
  USING public.restore_readiness AS readiness
  WHERE readiness.singleton AND readiness.branch_id = requested_branch_id
    AND readiness.state = 'awaiting_verification'
    AND readiness.verification_required
    AND readiness.rls_probe_first_account_id = first_account_id
    AND readiness.rls_probe_second_account_id = second_account_id
    AND deletions.personal_account_id IN (first_account_id, second_account_id);
  DELETE FROM public.personal_accounts AS accounts
  USING public.restore_readiness AS readiness
  WHERE readiness.singleton AND readiness.branch_id = requested_branch_id
    AND readiness.state = 'awaiting_verification'
    AND readiness.verification_required
    AND readiness.rls_probe_first_account_id = first_account_id
    AND readiness.rls_probe_second_account_id = second_account_id
    AND accounts.id IN (first_account_id, second_account_id);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  IF deleted_count <> 2 THEN
    RAISE integrity_constraint_violation
      USING MESSAGE = 'recovery RLS probe cleanup failed';
  END IF;
  UPDATE public.restore_readiness SET
    rls_probe_first_account_id = NULL,
    rls_probe_second_account_id = NULL
  WHERE singleton AND branch_id = requested_branch_id
    AND state = 'awaiting_verification' AND verification_required
    AND rls_probe_first_account_id = first_account_id
    AND rls_probe_second_account_id = second_account_id;
  IF NOT FOUND THEN
    RAISE integrity_constraint_violation
      USING MESSAGE = 'recovery RLS probe cleanup failed';
  END IF;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.prepare_recovery_media_loss_probe(
  requested_branch_id text,
  account_id uuid,
  connection_id uuid,
  conversation_id uuid,
  message_id uuid,
  media_id uuid,
  authorization_id uuid,
  audit_log_id uuid
)
RETURNS boolean LANGUAGE plpgsql STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  probe_at timestamptz := statement_timestamp();
  existing_state text;
  existing_failure_code text;
  existing_log_outcome text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.restore_readiness
    WHERE singleton AND branch_id = requested_branch_id
      AND state = 'awaiting_verification' AND verification_required
      AND rls_probe_first_account_id = account_id
      AND rls_probe_second_account_id IS NOT NULL
  ) THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'recovery verifier branch mismatch';
  END IF;
  SELECT media.state, media.failure_code, logs.outcome
    INTO existing_state, existing_failure_code, existing_log_outcome
  FROM public.stored_media AS media
  JOIN public.tool_call_logs AS logs
    ON logs.id = audit_log_id
    AND logs.personal_account_id = media.personal_account_id
  WHERE media.id = media_id AND media.personal_account_id = account_id;
  IF FOUND THEN
    IF existing_state = 'ready' AND existing_failure_code IS NULL
      AND existing_log_outcome = 'started' THEN
      RETURN true;
    END IF;
    IF existing_state = 'failed' AND existing_failure_code = 'object_missing'
      AND existing_log_outcome = 'execution_error' THEN
      RETURN false;
    END IF;
    RAISE integrity_constraint_violation
      USING MESSAGE = 'recovery Stored Media probe state is invalid';
  END IF;
  INSERT INTO public.whatsapp_connections(
    id, personal_account_id, webhook_ingress_id, display_name_fallback,
    public_id, state, state_changed_at
  ) VALUES (
    connection_id, account_id, conversation_id, 'Calm Otter',
    'con_' || substr(md5(connection_id::text), 1, 21),
    'connected', probe_at
  );
  INSERT INTO public.whatsapp_conversations(
    id, personal_account_id, whatsapp_connection_id, public_id, kind,
    recipient_locator, recipient_public_id, last_activity_at,
    last_activity_direction
  ) VALUES (
    conversation_id, account_id, connection_id,
    'cvs_' || substr(md5(conversation_id::text), 1, 21), 'direct',
    'di1_' || substr(md5(conversation_id::text) || md5(requested_branch_id), 1, 43),
    'ctc_' || substr(md5(conversation_id::text), 1, 21), probe_at, 'inbound'
  );
  INSERT INTO public.stored_messages(
    id, personal_account_id, whatsapp_connection_id, conversation_id,
    public_id, message_identity, direction, sent_at, content_type,
    content_ciphertext_version, content_key_version, content_nonce,
    content_ciphertext, received_at
  ) VALUES (
    message_id, account_id, connection_id, conversation_id,
    'msg_' || substr(md5(message_id::text), 1, 21),
    'wi1_' || substr(md5(message_id::text) || md5(requested_branch_id), 1, 43),
    'inbound', probe_at, 'image', 1, 1,
    decode(repeat('11', 12), 'hex'), decode(repeat('12', 32), 'hex'), probe_at
  );
  INSERT INTO public.stored_media(
    id, personal_account_id, whatsapp_connection_id, stored_message_id,
    public_id, state, media_type, object_key, plaintext_size_bytes, sha256,
    metadata_ciphertext_version, metadata_key_version, metadata_nonce,
    metadata_ciphertext
  ) VALUES (
    media_id, account_id, connection_id, message_id,
    'med_' || substr(md5(media_id::text), 1, 21), 'ready', 'image',
    'production-recovery/media-loss/' || media_id::text, 1, repeat('a', 64),
    1, 1, decode(repeat('13', 12), 'hex'), decode(repeat('14', 32), 'hex')
  );
  UPDATE public.personal_accounts
  SET stored_media_used_bytes = stored_media_used_bytes + 1
  WHERE id = account_id;
  INSERT INTO public.mcp_authorizations(
    id, personal_account_id, oauth_subject, client_id, client_class, scopes,
    reverified_at, authorized_at, absolute_expires_at
  ) VALUES (
    authorization_id, account_id,
    substr(replace(authorization_id::text, '-', '') || md5(authorization_id::text), 1, 43),
    'recovery-verifier', 'recovery', ARRAY['messages:read']::text[],
    probe_at, probe_at, probe_at + interval '1 day'
  );
  INSERT INTO public.tool_call_logs(
    id, personal_account_id, mcp_authorization_id, channel, tool_name,
    started_at, outcome, quota_reserved, expires_at, media_bytes_reserved,
    connection_public_id
  ) VALUES (
    audit_log_id, account_id, authorization_id, 'mcp', 'read_stored_media',
    probe_at, 'started', true, probe_at + interval '90 days', 1,
    'con_' || substr(md5(connection_id::text), 1, 21)
  );
  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.verify_recovery_media_loss_probe(
  requested_branch_id text,
  account_id uuid,
  media_id uuid,
  audit_log_id uuid
)
RETURNS boolean LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.restore_readiness AS readiness
    JOIN public.stored_media AS media
      ON media.personal_account_id = readiness.rls_probe_first_account_id
    JOIN public.tool_call_logs AS logs
      ON logs.personal_account_id = media.personal_account_id
    WHERE readiness.singleton AND readiness.branch_id = requested_branch_id
      AND readiness.state = 'awaiting_verification'
      AND readiness.verification_required
      AND readiness.rls_probe_first_account_id = account_id
      AND media.id = media_id AND media.state = 'failed'
      AND media.failure_code = 'object_missing' AND media.object_key IS NULL
      AND media.plaintext_size_bytes IS NULL
      AND logs.id = audit_log_id AND logs.outcome = 'execution_error'
      AND logs.error_code = 'resource_unavailable'
      AND logs.media_bytes_reserved = 0
  )
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
    AND rls_probe_first_account_id IS NULL
    AND rls_probe_second_account_id IS NULL
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
  public.prepare_recovery_rls_probe(text,uuid,uuid),
  public.complete_recovery_rls_probe(text,uuid,uuid),
  public.prepare_recovery_media_loss_probe(text,uuid,uuid,uuid,uuid,uuid,uuid,uuid),
  public.verify_recovery_media_loss_probe(text,uuid,uuid,uuid),
  public.is_restore_ready(text),
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
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.prepare_recovery_rls_probe(text,uuid,uuid)
  TO whatsapp_recovery_verifier;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.complete_recovery_rls_probe(text,uuid,uuid)
  TO whatsapp_recovery_verifier;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  public.prepare_recovery_media_loss_probe(text,uuid,uuid,uuid,uuid,uuid,uuid,uuid),
  public.verify_recovery_media_loss_probe(text,uuid,uuid,uuid)
  TO whatsapp_recovery_verifier;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.is_restore_ready(text)
  TO whatsapp_recovery_verifier;
