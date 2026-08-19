-- Recovery verification gets a dedicated login that can observe only the
-- migration ledger and closed aggregate checks. Tenant rows remain available
-- solely to this owner-executed, metadata-only function.
DO $role$
DECLARE
  granted_role name;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'whatsapp_recovery_verifier'
  ) THEN
    CREATE ROLE whatsapp_recovery_verifier LOGIN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'whatsapp_recovery_verifier'
      AND (rolsuper OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'recovery verifier role has prohibited privileged attributes';
  END IF;
  ALTER ROLE whatsapp_recovery_verifier
    NOREPLICATION NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT LOGIN;
  FOR granted_role IN
    SELECT parent.rolname
    FROM pg_catalog.pg_auth_members AS memberships
    JOIN pg_catalog.pg_roles AS parent
      ON parent.oid = memberships.roleid
    JOIN pg_catalog.pg_roles AS member
      ON member.oid = memberships.member
    WHERE member.rolname = 'whatsapp_recovery_verifier'
  LOOP
    EXECUTE format(
      'REVOKE %I FROM whatsapp_recovery_verifier',
      granted_role
    );
  END LOOP;
END
$role$;
--> statement-breakpoint

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM whatsapp_recovery_verifier;
--> statement-breakpoint

REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM whatsapp_recovery_verifier;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO whatsapp_recovery_verifier;
--> statement-breakpoint

GRANT SELECT ON public.drizzle_migrations TO whatsapp_recovery_verifier;
--> statement-breakpoint

CREATE FUNCTION public.verify_recovery_branch(
  requested_branch_id text,
  observed_at timestamptz
)
RETURNS TABLE (
  schema_ok boolean,
  invariants_ok boolean,
  quota_ok boolean,
  audit_ok boolean,
  expiry_ok boolean,
  deletion_ok boolean,
  recipient_ok boolean,
  object_intent_ok boolean,
  api_key_ok boolean
)
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  readiness public.restore_readiness%ROWTYPE;
BEGIN
  IF requested_branch_id !~ '^br-[A-Za-z0-9_-]{1,120}$' THEN
    RAISE invalid_parameter_value;
  END IF;

  SELECT candidate.* INTO readiness
  FROM public.restore_readiness AS candidate
  WHERE candidate.singleton;

  IF FOUND AND readiness.branch_id IS DISTINCT FROM requested_branch_id THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'recovery verifier branch mismatch';
  END IF;

  RETURN QUERY SELECT
    COALESCE((
      SELECT max(migrations.created_at) = 1787126400000
      FROM public.drizzle_migrations AS migrations
    ), false),
    COALESCE(
      readiness.state = 'ready'
      AND readiness.started_at <= readiness.completed_at
      AND readiness.completed_at <= observed_at
      AND readiness.marker_count >= readiness.deleted_entity_count,
      false
    ),
    NOT EXISTS (
      SELECT 1
      FROM public.personal_accounts AS accounts
      WHERE accounts.stored_media_used_bytes > accounts.stored_media_limit_bytes
        OR accounts.stored_media_used_bytes <> (
          SELECT COALESCE(sum(media.plaintext_size_bytes), 0)
          FROM public.stored_media AS media
          WHERE media.personal_account_id = accounts.id
            AND media.state IN ('ready', 'purging')
        )
        OR (
          SELECT count(*)
          FROM public.whatsapp_connections AS connections
          WHERE connections.personal_account_id = accounts.id
            AND connections.state <> 'deleted'
        ) > accounts.whatsapp_connection_limit
        OR (
          SELECT count(*)
          FROM public.api_keys AS keys
          WHERE keys.personal_account_id = accounts.id
            AND keys.state = 'active'
        ) > 10
    ),
    COALESCE(EXISTS (
      SELECT 1
      FROM public.restore_replay_audit AS audit
      WHERE audit.branch_id = requested_branch_id
        AND audit.completed_at = readiness.completed_at
        AND audit.marker_count = readiness.marker_count
        AND audit.deleted_entity_count = readiness.deleted_entity_count
        AND audit.expired_record_count = readiness.expired_record_count
        AND audit.api_keys_revoked = readiness.api_keys_revoked
        AND audit.api_key_digests_cleared = readiness.api_key_digests_cleared
    ), false),
    NOT EXISTS (
      SELECT 1 FROM public.pending_send_contents AS pending
      WHERE pending.expires_at <= observed_at
    ) AND NOT EXISTS (
      SELECT 1 FROM public.send_operations AS operations
      WHERE operations.expires_at <= observed_at
    ) AND NOT EXISTS (
      SELECT 1 FROM public.tool_call_logs AS logs
      WHERE logs.expires_at <= observed_at
    ) AND NOT EXISTS (
      SELECT 1 FROM public.security_records AS records
      WHERE records.expires_at <= observed_at
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.stored_messages AS messages
      JOIN public.whatsapp_connections AS connections
        ON connections.personal_account_id = messages.personal_account_id
       AND connections.id = messages.whatsapp_connection_id
      WHERE messages.content_expired_at IS NULL
        AND messages.deleted_at IS NULL
        AND connections.message_retention_days IS NOT NULL
        AND messages.sent_at
          + pg_catalog.make_interval(days => connections.message_retention_days)
          <= observed_at
    ),
    COALESCE(
      readiness.state = 'ready'
      AND readiness.marker_count >= readiness.deleted_entity_count,
      false
    ),
    NOT EXISTS (
      SELECT 1 FROM public.whatsapp_recipient_exclusions AS exclusions
      WHERE exclusions.transition_id IS NOT NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM public.whatsapp_recipient_transition_prefixes
    ),
    NOT EXISTS (SELECT 1 FROM public.restore_object_deletions)
      AND NOT EXISTS (SELECT 1 FROM public.stored_media_object_deletions),
    NOT EXISTS (
      SELECT 1 FROM public.api_keys AS keys
      WHERE keys.state = 'active' OR keys.credential_digest IS NOT NULL
    );
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.verify_recovery_branch(text,timestamptz)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.verify_recovery_branch(text,timestamptz)
  TO whatsapp_recovery_verifier;
