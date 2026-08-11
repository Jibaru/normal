CREATE DOMAIN public.message_search_token AS text
  CHECK (VALUE ~ '^msi1_[A-Za-z0-9_-]{43}$');
--> statement-breakpoint

ALTER TABLE public.whatsapp_connection_secrets
  ADD COLUMN message_search_key_ciphertext_version smallint,
  ADD COLUMN message_search_key_version integer,
  ADD COLUMN message_search_key_nonce bytea,
  ADD COLUMN message_search_key_ciphertext bytea,
  ADD CONSTRAINT whatsapp_connection_secrets_message_search_key_complete CHECK (
    (message_search_key_ciphertext_version IS NULL
      AND message_search_key_version IS NULL
      AND message_search_key_nonce IS NULL
      AND message_search_key_ciphertext IS NULL)
    OR
    (message_search_key_ciphertext_version = 1
      AND message_search_key_version > 0
      AND octet_length(message_search_key_nonce) = 12
      AND octet_length(message_search_key_ciphertext) > 16)
  );
--> statement-breakpoint

ALTER TABLE public.stored_messages
  ADD COLUMN message_search_index_version smallint,
  ADD COLUMN message_search_tokens public.message_search_token[],
  ADD CONSTRAINT stored_messages_message_search_tuple CHECK (
    (message_search_index_version IS NULL AND message_search_tokens IS NULL)
    OR
    (message_search_index_version = 1 AND message_search_tokens IS NOT NULL
      AND array_position(message_search_tokens, NULL) IS NULL)
  ),
  ADD CONSTRAINT stored_messages_message_search_lifecycle CHECK (
    (deleted_at IS NULL AND content_expired_at IS NULL)
    OR
    (message_search_index_version IS NULL AND message_search_tokens IS NULL)
  );
--> statement-breakpoint

CREATE INDEX stored_messages_message_search_v1
  ON public.stored_messages USING gin (message_search_tokens)
  WHERE message_search_index_version = 1
    AND deleted_at IS NULL
    AND content_expired_at IS NULL;
--> statement-breakpoint

CREATE TABLE public.message_search_backfill_coverage (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  index_version smallint NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'pending',
  searchable_from timestamptz,
  cursor_sent_at timestamptz,
  cursor_message_id uuid,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT message_search_backfill_coverage_pkey PRIMARY KEY
    (personal_account_id, whatsapp_connection_id, index_version),
  CONSTRAINT message_search_backfill_coverage_connection_fk FOREIGN KEY
    (whatsapp_connection_id, personal_account_id)
    REFERENCES public.whatsapp_connections (id, personal_account_id)
    ON DELETE CASCADE,
  CONSTRAINT message_search_backfill_coverage_version CHECK (index_version = 1),
  CONSTRAINT message_search_backfill_coverage_state CHECK (state IN ('pending', 'complete')),
  CONSTRAINT message_search_backfill_coverage_cursor CHECK (
    (cursor_sent_at IS NULL) = (cursor_message_id IS NULL)
  ),
  CONSTRAINT message_search_backfill_coverage_complete CHECK (
    state <> 'complete' OR (cursor_sent_at IS NULL AND cursor_message_id IS NULL)
  )
);
--> statement-breakpoint

INSERT INTO public.message_search_backfill_coverage (
  personal_account_id, whatsapp_connection_id, index_version, state
)
SELECT personal_account_id, id, 1, 'pending'
FROM public.whatsapp_connections;
--> statement-breakpoint

ALTER TABLE public.message_search_backfill_coverage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.message_search_backfill_coverage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY message_search_backfill_coverage_tenant
  ON public.message_search_backfill_coverage
  USING (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.preserve_expired_message_content_state()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF OLD.content_expired_at IS NOT NULL THEN
    NEW.content_type := NULL;
    NEW.content_ciphertext_version := NULL;
    NEW.content_key_version := NULL;
    NEW.content_nonce := NULL;
    NEW.content_ciphertext := NULL;
    NEW.content_expired_at := OLD.content_expired_at;
  END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.content_expired_at IS NOT NULL THEN
    NEW.message_search_index_version := NULL;
    NEW.message_search_tokens := NULL;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

DROP FUNCTION public.load_webhook_event_processing_material(uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION public.load_webhook_event_processing_material(
  requested_personal_account_id uuid,
  requested_whatsapp_connection_id uuid
)
RETURNS TABLE (
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea,
  identity_ciphertext_version smallint,
  identity_key_version integer,
  identity_nonce bytea,
  identity_ciphertext bytea,
  message_search_key_ciphertext_version smallint,
  message_search_key_version integer,
  message_search_key_nonce bytea,
  message_search_key_ciphertext bytea
)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT account_keys.key_version, account_keys.kms_key_id, account_keys.ciphertext,
    connection_keys.account_key_version, connection_keys.key_version,
    connection_keys.nonce, connection_keys.ciphertext,
    secrets.credential_ciphertext_version, secrets.credential_key_version,
    secrets.credential_nonce, secrets.credential_ciphertext,
    secrets.message_search_key_ciphertext_version, secrets.message_search_key_version,
    secrets.message_search_key_nonce, secrets.message_search_key_ciphertext
  FROM public.whatsapp_connections connections
  JOIN public.personal_accounts accounts ON accounts.id = connections.personal_account_id
  JOIN public.whatsapp_connection_key_envelopes connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
    AND connection_keys.whatsapp_connection_id = connections.id
  JOIN public.personal_account_key_envelopes account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
    AND account_keys.key_version = connection_keys.account_key_version
  JOIN public.whatsapp_connection_secrets secrets
    ON secrets.personal_account_id = connections.personal_account_id
    AND secrets.whatsapp_connection_id = connections.id
    AND secrets.credential_key_version = connection_keys.key_version
    AND secrets.message_search_key_version = connection_keys.key_version
  WHERE connections.personal_account_id = requested_personal_account_id
    AND connections.id = requested_whatsapp_connection_id
    AND accounts.state = 'active' AND connections.state <> 'deleting'
    AND account_keys.unavailable_at IS NULL AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.load_webhook_event_processing_material(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.load_webhook_event_processing_material(uuid, uuid)
  TO whatsapp_webhook_runtime;
--> statement-breakpoint

GRANT SELECT, UPDATE (
  message_search_key_ciphertext_version, message_search_key_version,
  message_search_key_nonce, message_search_key_ciphertext, updated_at
) ON public.whatsapp_connection_secrets TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.message_search_backfill_coverage TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT, UPDATE (message_search_index_version, message_search_tokens)
  ON public.stored_messages TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.list_message_search_backfill_connections(requested_limit integer)
RETURNS TABLE (personal_account_id uuid, whatsapp_connection_id uuid)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT coverage.personal_account_id, coverage.whatsapp_connection_id
  FROM public.message_search_backfill_coverage coverage
  JOIN public.whatsapp_connections connections
    ON connections.personal_account_id=coverage.personal_account_id
    AND connections.id=coverage.whatsapp_connection_id
  JOIN public.personal_accounts accounts ON accounts.id=coverage.personal_account_id
  WHERE requested_limit BETWEEN 1 AND 100
    AND coverage.index_version=1 AND coverage.state='pending'
    AND accounts.state='active' AND connections.state<>'deleting'
  ORDER BY coverage.updated_at, coverage.whatsapp_connection_id
  LIMIT requested_limit;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_message_search_backfill_connections(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_message_search_backfill_connections(integer) TO whatsapp_api_runtime;
--> statement-breakpoint

DROP FUNCTION public.load_send_key_material(uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION public.load_send_key_material(
  requested_personal_account_id uuid, requested_connection_id uuid
)
RETURNS TABLE (
  account_key_version integer, kms_key_id text, account_key_ciphertext bytea,
  connection_account_key_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea,
  authority_key_version integer, authority_nonce bytea, authority_ciphertext bytea,
  identity_key_version integer, identity_nonce bytea, identity_ciphertext bytea,
  message_search_key_version integer, message_search_key_nonce bytea,
  message_search_key_ciphertext bytea
)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT account_keys.key_version, account_keys.kms_key_id, account_keys.ciphertext,
    connection_keys.account_key_version, connection_keys.key_version,
    connection_keys.nonce, connection_keys.ciphertext,
    sessions.authority_key_version, sessions.authority_nonce, sessions.authority_ciphertext,
    secrets.credential_key_version, secrets.credential_nonce, secrets.credential_ciphertext,
    secrets.message_search_key_version, secrets.message_search_key_nonce,
    secrets.message_search_key_ciphertext
  FROM public.personal_account_key_envelopes account_keys
  JOIN public.whatsapp_connection_key_envelopes connection_keys
    ON connection_keys.personal_account_id = account_keys.personal_account_id
  JOIN public.whatsapp_connection_provider_sessions sessions
    ON sessions.personal_account_id = connection_keys.personal_account_id
    AND sessions.whatsapp_connection_id = connection_keys.whatsapp_connection_id
  JOIN public.whatsapp_connection_secrets secrets
    ON secrets.personal_account_id = connection_keys.personal_account_id
    AND secrets.whatsapp_connection_id = connection_keys.whatsapp_connection_id
    AND secrets.message_search_key_version = connection_keys.key_version
  WHERE account_keys.personal_account_id = requested_personal_account_id
    AND connection_keys.whatsapp_connection_id = requested_connection_id
    AND requested_personal_account_id = nullif(current_setting('public.personal_account_id', true), '')::uuid
    AND account_keys.unavailable_at IS NULL AND connection_keys.unavailable_at IS NULL;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.load_send_key_material(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.load_send_key_material(uuid, uuid) TO whatsapp_api_runtime;
