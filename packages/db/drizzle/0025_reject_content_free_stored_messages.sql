-- The webhook normalizer previously projected provider control items with no
-- readable text or supported media as active Stored Messages of type unknown.
-- Remove those content-free rows. Deleted Message Tombstones have null content
-- fields and remain intact.
DELETE FROM public.stored_messages AS messages
WHERE messages.content_type = 'unknown'
  AND messages.deleted_at IS NULL;
--> statement-breakpoint

-- A WhatsApp Conversation exists only when it has observed Stored Message
-- activity. Remove conversations that existed solely because of a content-free
-- provider item.
DELETE FROM public.whatsapp_conversations AS conversations
WHERE NOT EXISTS (
  SELECT 1
  FROM public.stored_messages AS messages
  WHERE messages.personal_account_id = conversations.personal_account_id
    AND messages.whatsapp_connection_id = conversations.whatsapp_connection_id
    AND messages.conversation_id = conversations.id
);
--> statement-breakpoint

-- Recalculate activity for conversations whose former latest row was a
-- content-free provider item.
UPDATE public.whatsapp_conversations AS conversations
SET
  last_activity_at = latest.sent_at,
  last_activity_direction = latest.direction,
  updated_at = transaction_timestamp()
FROM (
  SELECT DISTINCT ON (
    messages.personal_account_id,
    messages.whatsapp_connection_id,
    messages.conversation_id
  )
    messages.personal_account_id,
    messages.whatsapp_connection_id,
    messages.conversation_id,
    messages.sent_at,
    messages.direction
  FROM public.stored_messages AS messages
  WHERE messages.content_expired_at IS NULL
  ORDER BY
    messages.personal_account_id,
    messages.whatsapp_connection_id,
    messages.conversation_id,
    messages.sent_at DESC,
    messages.public_id DESC
) AS latest
WHERE conversations.personal_account_id = latest.personal_account_id
  AND conversations.whatsapp_connection_id = latest.whatsapp_connection_id
  AND conversations.id = latest.conversation_id
  AND (
    conversations.last_activity_at IS DISTINCT FROM latest.sent_at
    OR conversations.last_activity_direction IS DISTINCT FROM latest.direction
  );
--> statement-breakpoint

-- Keep the database boundary closed while the old Worker version is being
-- replaced during deployment. Public reads still use unknown for Deleted
-- Message Tombstones, whose persisted content type is null.
ALTER TABLE public.stored_messages
  DROP CONSTRAINT stored_messages_content_type_check;
--> statement-breakpoint

ALTER TABLE public.stored_messages
  ADD CONSTRAINT stored_messages_content_type_check
  CHECK (
    content_type = ANY (
      ARRAY[
        'audio'::text,
        'document'::text,
        'image'::text,
        'sticker'::text,
        'text'::text,
        'video'::text
      ]
    )
  );
--> statement-breakpoint

-- Recovery verification must require this migration on every recovered branch.
CREATE OR REPLACE FUNCTION public.verify_recovery_branch(
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
    COALESCE((SELECT max(migrations.created_at) = 1787242636000
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
