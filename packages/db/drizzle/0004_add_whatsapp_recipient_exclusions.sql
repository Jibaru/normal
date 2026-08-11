-- WhatsApp Recipient Exclusion is a User-owned, WhatsApp Connection scoped rule
-- that stops Normal from tracking one active contact or joined group. The rule
-- is the authority for MCP discovery, message and media reads, new sends, and
-- Message Store projection. Setting it records a permanent purge cutoff that
-- must survive a database restore, so an acknowledged transition is prepared
-- here, journalled outside the database, and only then finalized.
CREATE TABLE public.whatsapp_recipient_exclusions (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('contact', 'group')),
  recipient_locator text NOT NULL CHECK (recipient_locator ~ '^(wi1|di1)_[A-Za-z0-9_-]{43}$'),
  recipient_public_id text NOT NULL CHECK (recipient_public_id ~ '^(ctc|grp)_[A-Za-z0-9_-]{21}$'),
  excluded boolean NOT NULL,
  -- NULL until the first transition is acknowledged. A non-NULL value is the
  -- database time of the latest acknowledged transition and, while the rule is
  -- not excluded, the re-enable cutoff for provider observations.
  effective_at timestamptz,
  -- Greatest permanent purge cutoff. Never lowered and never cleared.
  purge_cutoff_at timestamptz,
  last_transition_id uuid,
  transition_id uuid,
  transition_excluded boolean,
  transition_effective_at timestamptz,
  transition_purge_cutoff_at timestamptz,
  transition_idempotency_key text
    CHECK (transition_idempotency_key IS NULL
      OR transition_idempotency_key ~ '^[A-Za-z0-9._~-]{16,255}$'),
  transition_prepared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id, recipient_kind, recipient_locator),
  UNIQUE (personal_account_id, whatsapp_connection_id, recipient_public_id),
  CHECK (
    (recipient_kind = 'contact' AND recipient_locator LIKE 'di1|_%' ESCAPE '|'
      AND recipient_public_id LIKE 'ctc|_%' ESCAPE '|')
    OR (recipient_kind = 'group' AND recipient_locator LIKE 'wi1|_%' ESCAPE '|'
      AND recipient_public_id LIKE 'grp|_%' ESCAPE '|')
  ),
  CHECK (NOT excluded OR effective_at IS NOT NULL),
  CHECK (purge_cutoff_at IS NULL OR effective_at IS NOT NULL),
  CHECK (
    (transition_id IS NULL AND transition_excluded IS NULL
      AND transition_effective_at IS NULL AND transition_idempotency_key IS NULL
      AND transition_prepared_at IS NULL AND transition_purge_cutoff_at IS NULL)
    OR (transition_id IS NOT NULL AND transition_excluded IS NOT NULL
      AND transition_effective_at IS NOT NULL AND transition_idempotency_key IS NOT NULL
      AND transition_prepared_at IS NOT NULL)
  ),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX whatsapp_recipient_exclusions_pending ON public.whatsapp_recipient_exclusions
  (transition_prepared_at, transition_id)
  WHERE transition_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX whatsapp_recipient_exclusions_purge_cutoff ON public.whatsapp_recipient_exclusions
  (personal_account_id, whatsapp_connection_id, recipient_locator)
  WHERE purge_cutoff_at IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.whatsapp_recipient_exclusions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.whatsapp_recipient_exclusions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY whatsapp_recipient_exclusions_tenant ON public.whatsapp_recipient_exclusions
  USING (personal_account_id = nullif(pg_catalog.current_setting('public.personal_account_id', true), '')::uuid)
  WITH CHECK (personal_account_id = nullif(pg_catalog.current_setting('public.personal_account_id', true), '')::uuid);
--> statement-breakpoint
REVOKE ALL ON TABLE public.whatsapp_recipient_exclusions FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.whatsapp_recipient_exclusions TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT ON public.whatsapp_recipient_exclusions TO whatsapp_webhook_runtime;
--> statement-breakpoint

-- Read enforcement predicate. Invoker rights keep row level security in force
-- for the runtime roles that select through it.
CREATE FUNCTION public.whatsapp_recipient_excluded(
  requested_account_id uuid, requested_connection_id uuid,
  requested_kind text, requested_locator text
)
RETURNS boolean LANGUAGE sql STABLE STRICT
SET search_path = pg_catalog, public, public AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.whatsapp_recipient_exclusions rules
    WHERE rules.personal_account_id = requested_account_id
      AND rules.whatsapp_connection_id = requested_connection_id
      AND rules.recipient_kind = requested_kind
      AND rules.recipient_locator = requested_locator
      AND rules.excluded
  );
$function$;
--> statement-breakpoint

-- Ingestion enforcement predicate. A re-enabled recipient admits only provider
-- observations whose immutable ingress receipt time is after the re-enable.
CREATE FUNCTION public.whatsapp_recipient_observation_suppressed(
  requested_account_id uuid, requested_connection_id uuid,
  requested_kind text, requested_locator text, requested_received_at timestamptz
)
RETURNS boolean LANGUAGE sql STABLE STRICT
SET search_path = pg_catalog, public, public AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.whatsapp_recipient_exclusions rules
    WHERE rules.personal_account_id = requested_account_id
      AND rules.whatsapp_connection_id = requested_connection_id
      AND rules.recipient_kind = requested_kind
      AND rules.recipient_locator = requested_locator
      AND (
        rules.excluded
        OR (rules.effective_at IS NOT NULL AND requested_received_at <= rules.effective_at)
      )
  );
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.whatsapp_recipient_excluded(uuid,uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.whatsapp_recipient_observation_suppressed(uuid,uuid,text,text,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.whatsapp_recipient_excluded(uuid,uuid,text,text),
  public.whatsapp_recipient_observation_suppressed(uuid,uuid,text,text,timestamptz)
  TO whatsapp_api_runtime, whatsapp_webhook_runtime;
--> statement-breakpoint

-- Immediate access removal for everything a purge cutoff covers. Content and
-- non-ready media go now; ready media becomes unreadable, stays quota bearing,
-- and receives an idempotent object deletion intent.
CREATE FUNCTION public.apply_whatsapp_recipient_exclusion_purge(
  requested_account_id uuid, requested_connection_id uuid,
  requested_locator text, requested_recipient_public_id text,
  cutoff_at timestamptz, observed_at timestamptz
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
DECLARE purged integer := 0; affected integer;
BEGIN
  IF cutoff_at IS NULL THEN RETURN 0; END IF;
  DELETE FROM public.pending_send_contents pending
  USING public.send_operations operations
  WHERE pending.personal_account_id = requested_account_id
    AND pending.whatsapp_connection_id = requested_connection_id
    AND operations.personal_account_id = pending.personal_account_id
    AND operations.id = pending.send_operation_id
    AND operations.recipient_public_id = requested_recipient_public_id
    AND operations.created_at <= cutoff_at;
  GET DIAGNOSTICS affected = ROW_COUNT; purged := purged + affected;

  DELETE FROM public.stored_media media
  USING public.stored_messages messages, public.whatsapp_conversations conversations
  WHERE conversations.personal_account_id = requested_account_id
    AND conversations.whatsapp_connection_id = requested_connection_id
    AND conversations.recipient_locator = requested_locator
    AND messages.personal_account_id = conversations.personal_account_id
    AND messages.whatsapp_connection_id = conversations.whatsapp_connection_id
    AND messages.conversation_id = conversations.id
    AND messages.created_at <= cutoff_at
    AND media.personal_account_id = messages.personal_account_id
    AND media.whatsapp_connection_id = messages.whatsapp_connection_id
    AND media.stored_message_id = messages.id
    AND media.state IN ('pending', 'rejected', 'failed');

  INSERT INTO public.stored_media_object_deletions(personal_account_id, object_key, requested_at)
  SELECT media.personal_account_id, media.object_key, observed_at
  FROM public.stored_media media
  JOIN public.stored_messages messages
    ON messages.personal_account_id = media.personal_account_id
   AND messages.whatsapp_connection_id = media.whatsapp_connection_id
   AND messages.id = media.stored_message_id
  JOIN public.whatsapp_conversations conversations
    ON conversations.personal_account_id = messages.personal_account_id
   AND conversations.whatsapp_connection_id = messages.whatsapp_connection_id
   AND conversations.id = messages.conversation_id
  WHERE conversations.personal_account_id = requested_account_id
    AND conversations.whatsapp_connection_id = requested_connection_id
    AND conversations.recipient_locator = requested_locator
    AND messages.created_at <= cutoff_at
    AND media.state = 'ready' AND media.object_key IS NOT NULL
  ON CONFLICT DO NOTHING;

  UPDATE public.stored_media media SET state = 'purging', updated_at = observed_at
  FROM public.stored_messages messages, public.whatsapp_conversations conversations
  WHERE conversations.personal_account_id = requested_account_id
    AND conversations.whatsapp_connection_id = requested_connection_id
    AND conversations.recipient_locator = requested_locator
    AND messages.personal_account_id = conversations.personal_account_id
    AND messages.whatsapp_connection_id = conversations.whatsapp_connection_id
    AND messages.conversation_id = conversations.id
    AND messages.created_at <= cutoff_at
    AND media.personal_account_id = messages.personal_account_id
    AND media.whatsapp_connection_id = messages.whatsapp_connection_id
    AND media.stored_message_id = messages.id
    AND media.state = 'ready';

  UPDATE public.stored_messages messages SET content_type = NULL,
    content_ciphertext_version = NULL, content_key_version = NULL,
    content_nonce = NULL, content_ciphertext = NULL,
    content_expired_at = COALESCE(messages.content_expired_at, observed_at),
    updated_at = observed_at
  FROM public.whatsapp_conversations conversations
  WHERE conversations.personal_account_id = requested_account_id
    AND conversations.whatsapp_connection_id = requested_connection_id
    AND conversations.recipient_locator = requested_locator
    AND messages.personal_account_id = conversations.personal_account_id
    AND messages.whatsapp_connection_id = conversations.whatsapp_connection_id
    AND messages.conversation_id = conversations.id
    AND messages.created_at <= cutoff_at
    AND messages.content_expired_at IS NULL
    AND messages.deleted_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT; purged := purged + affected;
  RETURN purged;
END
$function$;
--> statement-breakpoint

-- Removes the record shells once every object for an inaccessible message is
-- gone. Quota is released by the existing object deletion completion boundary.
CREATE FUNCTION public.purge_excluded_recipient_history(
  observed_at timestamptz, requested_limit integer
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
DECLARE removed integer := 0; affected integer;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid recipient exclusion purge limit';
  END IF;
  WITH candidates AS (
    SELECT messages.id AS message_id, messages.personal_account_id AS account_id
    FROM public.stored_messages messages
    JOIN public.whatsapp_conversations conversations
      ON conversations.personal_account_id = messages.personal_account_id
     AND conversations.whatsapp_connection_id = messages.whatsapp_connection_id
     AND conversations.id = messages.conversation_id
    JOIN public.whatsapp_recipient_exclusions rules
      ON rules.personal_account_id = conversations.personal_account_id
     AND rules.whatsapp_connection_id = conversations.whatsapp_connection_id
     AND rules.recipient_locator = conversations.recipient_locator
    WHERE rules.purge_cutoff_at IS NOT NULL
      AND messages.created_at <= rules.purge_cutoff_at
      AND messages.content_expired_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.stored_media media
        WHERE media.personal_account_id = messages.personal_account_id
          AND media.whatsapp_connection_id = messages.whatsapp_connection_id
          AND media.stored_message_id = messages.id
      )
    ORDER BY messages.created_at, messages.id
    LIMIT requested_limit FOR UPDATE OF messages SKIP LOCKED
  )
  DELETE FROM public.stored_messages messages USING candidates
  WHERE messages.id = candidates.message_id
    AND messages.personal_account_id = candidates.account_id;
  GET DIAGNOSTICS affected = ROW_COUNT; removed := removed + affected;

  DELETE FROM public.whatsapp_conversations conversations
  USING public.whatsapp_recipient_exclusions rules
  WHERE rules.personal_account_id = conversations.personal_account_id
    AND rules.whatsapp_connection_id = conversations.whatsapp_connection_id
    AND rules.recipient_locator = conversations.recipient_locator
    AND rules.purge_cutoff_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.stored_messages messages
      WHERE messages.personal_account_id = conversations.personal_account_id
        AND messages.whatsapp_connection_id = conversations.whatsapp_connection_id
        AND messages.conversation_id = conversations.id
    );
  GET DIAGNOSTICS affected = ROW_COUNT; removed := removed + affected;
  RETURN removed;
END
$function$;
--> statement-breakpoint

-- Product Settings needs the same connection scoped key material the MCP
-- Directory reads use, plus the Directory freshness qualifiers.
CREATE FUNCTION public.load_recipient_directory_material(
  verified_clerk_user_id text, requested_connection_public_id text,
  requested_at timestamptz
)
RETURNS TABLE (
  personal_account_id uuid, whatsapp_connection_id uuid,
  account_key_version integer, account_kms_key_id text, account_key_ciphertext bytea,
  connection_key_account_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea,
  identity_ciphertext_version smallint, identity_key_version integer,
  identity_nonce bytea, identity_ciphertext bytea,
  contacts_as_of timestamptz, contacts_stale boolean, contacts_partial boolean,
  groups_as_of timestamptz, groups_stale boolean, groups_partial boolean
)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
  SELECT connections.personal_account_id, connections.id,
    account_keys.key_version, account_keys.kms_key_id, account_keys.ciphertext,
    connection_keys.account_key_version, connection_keys.key_version,
    connection_keys.nonce, connection_keys.ciphertext,
    identity_keys.credential_ciphertext_version, identity_keys.credential_key_version,
    identity_keys.credential_nonce, identity_keys.credential_ciphertext,
    COALESCE(contacts.as_of, connections.created_at),
    CASE WHEN contacts.snapshot_observed_at IS NULL THEN true
      ELSE public.directory_projection_stale(connections.personal_account_id,
        connections.id, requested_at, contacts.snapshot_observed_at, contacts.stale) END,
    CASE WHEN contacts.snapshot_observed_at IS NULL THEN true
      ELSE public.directory_projection_partial(connections.personal_account_id,
        connections.id, contacts.snapshot_observed_at, contacts.partial,
        contacts.retention_limited) END,
    COALESCE(groups.as_of, connections.created_at),
    CASE WHEN groups.snapshot_observed_at IS NULL THEN true
      ELSE public.directory_projection_stale(connections.personal_account_id,
        connections.id, requested_at, groups.snapshot_observed_at, groups.stale) END,
    CASE WHEN groups.snapshot_observed_at IS NULL THEN true
      ELSE public.directory_projection_partial(connections.personal_account_id,
        connections.id, groups.snapshot_observed_at, groups.partial,
        groups.retention_limited) END
  FROM public.clerk_identities identities
  JOIN public.personal_accounts accounts ON accounts.id = identities.personal_account_id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id = accounts.id
  JOIN public.whatsapp_connection_key_envelopes connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  JOIN public.personal_account_key_envelopes account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  JOIN public.whatsapp_connection_secrets identity_keys
    ON identity_keys.personal_account_id = connections.personal_account_id
   AND identity_keys.whatsapp_connection_id = connections.id
   AND identity_keys.credential_key_version = connection_keys.key_version
  LEFT JOIN public.directory_contact_projections contacts
    ON contacts.personal_account_id = connections.personal_account_id
   AND contacts.whatsapp_connection_id = connections.id
  LEFT JOIN public.whatsapp_group_directory_states groups
    ON groups.personal_account_id = connections.personal_account_id
   AND groups.whatsapp_connection_id = connections.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
    AND connections.public_id = requested_connection_public_id
    AND connections.state <> 'deleting'
    AND account_keys.unavailable_at IS NULL AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL;
$function$;
--> statement-breakpoint

-- One page of manageable recipients. Excluded recipients stay visible in
-- product Settings so the User can re-enable them; MCP Directory results
-- enforce exclusion separately.
CREATE FUNCTION public.list_whatsapp_recipient_directory(
  verified_clerk_user_id text, requested_connection_public_id text,
  requested_kind text, requested_search_index text, cursor_sort_key text,
  cursor_public_id text, requested_limit integer
)
RETURNS TABLE (
  recipient_public_id text, sort_key text, record_id text,
  display_name_ciphertext_version smallint, display_name_key_version integer,
  display_name_nonce bytea, display_name_ciphertext bytea,
  phone_ciphertext_version smallint, phone_key_version integer,
  phone_nonce bytea, phone_ciphertext bytea, recipient_excluded boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
#variable_conflict use_column
DECLARE selected_account_id uuid; selected_connection_id uuid;
BEGIN
  IF requested_kind NOT IN ('contact', 'group')
    OR requested_limit < 1 OR requested_limit > 101
    OR (cursor_sort_key IS NULL) <> (cursor_public_id IS NULL) THEN
    RAISE EXCEPTION 'invalid recipient directory query';
  END IF;
  SELECT accounts.id, connections.id INTO selected_account_id, selected_connection_id
  FROM public.clerk_identities identities
  JOIN public.personal_accounts accounts ON accounts.id = identities.personal_account_id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id = accounts.id
  WHERE identities.clerk_user_id = verified_clerk_user_id AND accounts.state = 'active'
    AND connections.public_id = requested_connection_public_id
    AND connections.state <> 'deleting';
  IF selected_connection_id IS NULL THEN RETURN; END IF;
  IF requested_kind = 'contact' THEN
    IF requested_search_index IS NOT NULL
      AND requested_search_index !~ '^di1_[A-Za-z0-9_-]{43}$' THEN
      RAISE EXCEPTION 'invalid recipient directory search index';
    END IF;
    RETURN QUERY
      SELECT contacts.public_id, contacts.display_name_sort,
        contacts.provider_identity_index::text,
        contacts.display_name_ciphertext_version, contacts.display_name_key_version,
        contacts.display_name_nonce, contacts.display_name_ciphertext,
        contacts.phone_ciphertext_version, contacts.phone_key_version,
        contacts.phone_nonce, contacts.phone_ciphertext,
        COALESCE(rules.excluded, false)
      FROM public.directory_contacts contacts
      LEFT JOIN public.whatsapp_recipient_exclusions rules
        ON rules.personal_account_id = contacts.personal_account_id
       AND rules.whatsapp_connection_id = contacts.whatsapp_connection_id
       AND rules.recipient_kind = 'contact'
       AND rules.recipient_locator = contacts.provider_identity_index
      WHERE contacts.personal_account_id = selected_account_id
        AND contacts.whatsapp_connection_id = selected_connection_id
        AND contacts.active
        AND (cursor_sort_key IS NULL
          OR (contacts.display_name_sort, contacts.public_id)
            > (cursor_sort_key COLLATE "C", cursor_public_id))
        AND (requested_search_index IS NULL
          OR contacts.name_prefix_indexes
            @> ARRAY[requested_search_index::public.directory_blind_index])
      ORDER BY contacts.display_name_sort, contacts.public_id
      LIMIT requested_limit;
    RETURN;
  END IF;
  IF requested_search_index IS NOT NULL
    AND requested_search_index !~ '^gi1_[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'invalid recipient directory search index';
  END IF;
  RETURN QUERY
    SELECT groups.public_id, ''::text, groups.id::text,
      groups.display_name_ciphertext_version, groups.display_name_key_version,
      groups.display_name_nonce, groups.display_name_ciphertext,
      NULL::smallint, NULL::integer, NULL::bytea, NULL::bytea,
      COALESCE(rules.excluded, false)
    FROM public.whatsapp_groups groups
    LEFT JOIN public.whatsapp_recipient_exclusions rules
      ON rules.personal_account_id = groups.personal_account_id
     AND rules.whatsapp_connection_id = groups.whatsapp_connection_id
     AND rules.recipient_kind = 'group'
     AND rules.recipient_locator = groups.provider_locator
    WHERE groups.personal_account_id = selected_account_id
      AND groups.whatsapp_connection_id = selected_connection_id
      AND groups.joined
      AND (cursor_public_id IS NULL OR groups.public_id > cursor_public_id)
      AND (requested_search_index IS NULL
        OR groups.name_prefix_indexes
          @> ARRAY[requested_search_index::public.group_name_blind_index])
    ORDER BY groups.public_id
    LIMIT requested_limit;
END
$function$;
--> statement-breakpoint

-- Step one of prepare, append, finalize. The WhatsApp Connection row lock is
-- the shared serialization point with send preflight, message projection, and
-- Stored Media finalization; the Personal Account row is locked first.
CREATE FUNCTION public.prepare_whatsapp_recipient_exclusion(
  verified_clerk_user_id text, requested_connection_public_id text,
  requested_recipient_public_id text, requested_excluded boolean,
  requested_expected_excluded boolean, requested_idempotency_key text
)
RETURNS TABLE (
  outcome text, transition_id uuid, personal_account_id uuid,
  whatsapp_connection_id uuid, recipient_kind text, recipient_locator text,
  recipient_excluded boolean, effective_at timestamptz, purge_cutoff_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
#variable_conflict use_column
DECLARE
  selected_account_id uuid; selected_connection_id uuid;
  selected_kind text; selected_locator text;
  current_rule public.whatsapp_recipient_exclusions%ROWTYPE;
  prepared_at timestamptz := transaction_timestamp();
  new_transition_id uuid; new_cutoff timestamptz;
BEGIN
  IF requested_idempotency_key !~ '^[A-Za-z0-9._~-]{16,255}$' THEN
    RAISE EXCEPTION 'invalid recipient exclusion idempotency key';
  END IF;
  SELECT accounts.id INTO selected_account_id
  FROM public.clerk_identities identities
  JOIN public.personal_accounts accounts ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id AND accounts.state = 'active'
  FOR UPDATE OF accounts;
  IF selected_account_id IS NULL THEN RETURN; END IF;
  SELECT connections.id INTO selected_connection_id
  FROM public.whatsapp_connections connections
  WHERE connections.personal_account_id = selected_account_id
    AND connections.public_id = requested_connection_public_id
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;
  IF selected_connection_id IS NULL THEN RETURN; END IF;

  SELECT 'contact', contacts.provider_identity_index::text
  INTO selected_kind, selected_locator
  FROM public.directory_contacts contacts
  WHERE contacts.personal_account_id = selected_account_id
    AND contacts.whatsapp_connection_id = selected_connection_id
    AND contacts.public_id = requested_recipient_public_id;
  IF selected_locator IS NULL THEN
    SELECT 'group', groups.provider_locator INTO selected_kind, selected_locator
    FROM public.whatsapp_groups groups
    WHERE groups.personal_account_id = selected_account_id
      AND groups.whatsapp_connection_id = selected_connection_id
      AND groups.public_id = requested_recipient_public_id;
  END IF;
  IF selected_locator IS NULL THEN RETURN; END IF;

  SELECT * INTO current_rule FROM public.whatsapp_recipient_exclusions rules
  WHERE rules.personal_account_id = selected_account_id
    AND rules.whatsapp_connection_id = selected_connection_id
    AND rules.recipient_kind = selected_kind
    AND rules.recipient_locator = selected_locator
  FOR UPDATE;

  IF current_rule.transition_id IS NOT NULL THEN
    IF current_rule.transition_idempotency_key = requested_idempotency_key THEN
      RETURN QUERY SELECT 'prepared'::text, current_rule.transition_id,
        selected_account_id, selected_connection_id, selected_kind, selected_locator,
        current_rule.transition_excluded, current_rule.transition_effective_at,
        current_rule.transition_purge_cutoff_at;
    ELSE
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, selected_account_id,
        selected_connection_id, selected_kind, selected_locator,
        current_rule.excluded, current_rule.effective_at, current_rule.purge_cutoff_at;
    END IF;
    RETURN;
  END IF;

  IF COALESCE(current_rule.excluded, false) IS DISTINCT FROM requested_expected_excluded THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, selected_account_id,
      selected_connection_id, selected_kind, selected_locator,
      COALESCE(current_rule.excluded, false), current_rule.effective_at,
      current_rule.purge_cutoff_at;
    RETURN;
  END IF;

  IF COALESCE(current_rule.excluded, false) = requested_excluded THEN
    RETURN QUERY SELECT 'unchanged'::text, NULL::uuid, selected_account_id,
      selected_connection_id, selected_kind, selected_locator,
      requested_excluded, current_rule.effective_at, current_rule.purge_cutoff_at;
    RETURN;
  END IF;

  new_transition_id := pg_catalog.gen_random_uuid();
  new_cutoff := CASE WHEN requested_excluded
    THEN GREATEST(current_rule.purge_cutoff_at, prepared_at)
    ELSE current_rule.purge_cutoff_at END;
  INSERT INTO public.whatsapp_recipient_exclusions AS rules (
    personal_account_id, whatsapp_connection_id, recipient_kind, recipient_locator,
    recipient_public_id, excluded, transition_id, transition_excluded,
    transition_effective_at, transition_purge_cutoff_at, transition_idempotency_key,
    transition_prepared_at
  ) VALUES (
    selected_account_id, selected_connection_id, selected_kind, selected_locator,
    requested_recipient_public_id, false, new_transition_id, requested_excluded,
    prepared_at, new_cutoff, requested_idempotency_key, prepared_at
  )
  ON CONFLICT (personal_account_id, whatsapp_connection_id, recipient_kind, recipient_locator)
  DO UPDATE SET recipient_public_id = excluded.recipient_public_id,
    transition_id = excluded.transition_id,
    transition_excluded = excluded.transition_excluded,
    transition_effective_at = excluded.transition_effective_at,
    transition_purge_cutoff_at = excluded.transition_purge_cutoff_at,
    transition_idempotency_key = excluded.transition_idempotency_key,
    transition_prepared_at = excluded.transition_prepared_at,
    updated_at = excluded.transition_prepared_at;
  RETURN QUERY SELECT 'prepared'::text, new_transition_id, selected_account_id,
    selected_connection_id, selected_kind, selected_locator, requested_excluded,
    prepared_at, new_cutoff;
END
$function$;
--> statement-breakpoint

-- Step three of prepare, append, finalize. Only called after the append only
-- journal object is durable, so acknowledged state can never outlive its
-- restore evidence.
CREATE FUNCTION public.finalize_whatsapp_recipient_exclusion(
  verified_clerk_user_id text, requested_connection_public_id text,
  requested_recipient_public_id text, requested_transition_id uuid,
  observed_at timestamptz
)
RETURNS TABLE (
  recipient_excluded boolean, effective_at timestamptz, purge_cutoff_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
#variable_conflict use_column
DECLARE
  selected_account_id uuid; selected_connection_id uuid;
  current_rule public.whatsapp_recipient_exclusions%ROWTYPE;
BEGIN
  SELECT accounts.id INTO selected_account_id
  FROM public.clerk_identities identities
  JOIN public.personal_accounts accounts ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id AND accounts.state = 'active'
  FOR UPDATE OF accounts;
  IF selected_account_id IS NULL THEN RETURN; END IF;
  SELECT connections.id INTO selected_connection_id
  FROM public.whatsapp_connections connections
  WHERE connections.personal_account_id = selected_account_id
    AND connections.public_id = requested_connection_public_id
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;
  IF selected_connection_id IS NULL THEN RETURN; END IF;

  SELECT * INTO current_rule FROM public.whatsapp_recipient_exclusions rules
  WHERE rules.personal_account_id = selected_account_id
    AND rules.whatsapp_connection_id = selected_connection_id
    AND rules.recipient_public_id = requested_recipient_public_id
  FOR UPDATE;
  IF current_rule.recipient_locator IS NULL THEN RETURN; END IF;
  IF current_rule.transition_id IS DISTINCT FROM requested_transition_id THEN
    IF current_rule.last_transition_id IS NOT DISTINCT FROM requested_transition_id THEN
      RETURN QUERY SELECT current_rule.excluded, current_rule.effective_at,
        current_rule.purge_cutoff_at;
    END IF;
    RETURN;
  END IF;

  UPDATE public.whatsapp_recipient_exclusions AS rules
  SET excluded = current_rule.transition_excluded,
    effective_at = current_rule.transition_effective_at,
    purge_cutoff_at = GREATEST(rules.purge_cutoff_at, current_rule.transition_purge_cutoff_at),
    last_transition_id = current_rule.transition_id,
    transition_id = NULL, transition_excluded = NULL, transition_effective_at = NULL,
    transition_purge_cutoff_at = NULL, transition_idempotency_key = NULL,
    transition_prepared_at = NULL, updated_at = observed_at
  WHERE rules.personal_account_id = selected_account_id
    AND rules.whatsapp_connection_id = selected_connection_id
    AND rules.recipient_kind = current_rule.recipient_kind
    AND rules.recipient_locator = current_rule.recipient_locator
  RETURNING rules.* INTO current_rule;

  IF current_rule.excluded THEN
    PERFORM public.apply_whatsapp_recipient_exclusion_purge(
      selected_account_id, selected_connection_id, current_rule.recipient_locator,
      current_rule.recipient_public_id, current_rule.purge_cutoff_at, observed_at
    );
  END IF;
  RETURN QUERY SELECT current_rule.excluded, current_rule.effective_at,
    current_rule.purge_cutoff_at;
END
$function$;
--> statement-breakpoint

-- Bounded recovery for a transition that was prepared but never finalized.
CREATE FUNCTION public.list_pending_whatsapp_recipient_exclusions(
  observed_at timestamptz, requested_limit integer
)
RETURNS TABLE (
  clerk_user_id text, connection_public_id text, recipient_public_id text,
  recipient_kind text, recipient_locator text, whatsapp_connection_id uuid,
  transition_id uuid, transition_excluded boolean,
  transition_effective_at timestamptz, transition_purge_cutoff_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
#variable_conflict use_column
BEGIN
  IF requested_limit < 1 OR requested_limit > 100 THEN
    RAISE EXCEPTION 'invalid pending recipient exclusion limit';
  END IF;
  RETURN QUERY
    SELECT identities.clerk_user_id, connections.public_id, rules.recipient_public_id,
      rules.recipient_kind, rules.recipient_locator, rules.whatsapp_connection_id,
      rules.transition_id, rules.transition_excluded, rules.transition_effective_at,
      rules.transition_purge_cutoff_at
    FROM public.whatsapp_recipient_exclusions rules
    JOIN public.whatsapp_connections connections
      ON connections.personal_account_id = rules.personal_account_id
     AND connections.id = rules.whatsapp_connection_id
    JOIN public.clerk_identities identities
      ON identities.personal_account_id = rules.personal_account_id
    WHERE rules.transition_id IS NOT NULL
      AND rules.transition_prepared_at <= observed_at
      AND connections.state <> 'deleting'
    ORDER BY rules.transition_prepared_at, rules.transition_id
    LIMIT requested_limit;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
  public.apply_whatsapp_recipient_exclusion_purge(uuid,uuid,text,text,timestamptz,timestamptz),
  public.purge_excluded_recipient_history(timestamptz,integer),
  public.load_recipient_directory_material(text,text,timestamptz),
  public.list_whatsapp_recipient_directory(text,text,text,text,text,text,integer),
  public.prepare_whatsapp_recipient_exclusion(text,text,text,boolean,boolean,text),
  public.finalize_whatsapp_recipient_exclusion(text,text,text,uuid,timestamptz),
  public.list_pending_whatsapp_recipient_exclusions(timestamptz,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.purge_excluded_recipient_history(timestamptz,integer),
  public.load_recipient_directory_material(text,text,timestamptz),
  public.list_whatsapp_recipient_directory(text,text,text,text,text,text,integer),
  public.prepare_whatsapp_recipient_exclusion(text,text,text,boolean,boolean,text),
  public.finalize_whatsapp_recipient_exclusion(text,text,text,uuid,timestamptz),
  public.list_pending_whatsapp_recipient_exclusions(timestamptz,integer)
  TO whatsapp_api_runtime;
--> statement-breakpoint

-- Message reads enforce exclusion independently of the chat list, because an
-- MCP Client may retain a WhatsApp Conversation handle it saw earlier.
CREATE OR REPLACE FUNCTION public.load_mcp_message_read_material(
  requested_authorization_id uuid, requested_oauth_subject text, requested_client_id text,
  requested_at timestamptz, requested_connection_public_id text,
  requested_conversation_public_id text
)
RETURNS TABLE (
  connection_id uuid, connection_created_at timestamptz, message_retention_days integer,
  personal_account_id uuid,
  account_key_version integer, account_kms_key_id text, account_key_ciphertext bytea,
  connection_key_account_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea
)
LANGUAGE sql STABLE CALLED ON NULL INPUT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT connections.id,connections.created_at,connections.message_retention_days,
    connections.personal_account_id,
    account_keys.key_version,account_keys.kms_key_id,account_keys.ciphertext,
    connection_keys.account_key_version,connection_keys.key_version,connection_keys.nonce,connection_keys.ciphertext
  FROM public.mcp_authorizations authorizations
  JOIN public.mcp_authorization_connections selected ON selected.personal_account_id=authorizations.personal_account_id
    AND selected.mcp_authorization_id=authorizations.id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id=selected.personal_account_id
    AND connections.id=selected.whatsapp_connection_id
  JOIN public.whatsapp_conversations conversations ON conversations.personal_account_id=connections.personal_account_id
    AND conversations.whatsapp_connection_id=connections.id
  JOIN public.personal_account_key_envelopes account_keys ON account_keys.personal_account_id=connections.personal_account_id
  JOIN public.whatsapp_connection_key_envelopes connection_keys ON connection_keys.personal_account_id=connections.personal_account_id
    AND connection_keys.whatsapp_connection_id=connections.id AND connection_keys.account_key_version=account_keys.key_version
  JOIN public.personal_accounts accounts ON accounts.id=authorizations.personal_account_id
  WHERE authorizations.id=requested_authorization_id
    AND authorizations.oauth_subject=requested_oauth_subject
    AND (requested_client_id IS NULL OR authorizations.client_id=requested_client_id)
    AND authorizations.personal_account_id=nullif(pg_catalog.current_setting('public.personal_account_id',true),'')::uuid
    AND authorizations.state='active' AND authorizations.refresh_family_state='active'
    AND authorizations.absolute_expires_at>requested_at AND accounts.state='active'
    AND EXISTS (SELECT 1 FROM public.clerk_identities identities
      WHERE identities.personal_account_id=authorizations.personal_account_id)
    AND 'messages:read'=ANY(authorizations.scopes)
    AND connections.public_id=requested_connection_public_id
    AND conversations.public_id=requested_conversation_public_id AND connections.state<>'deleting'
    AND NOT EXISTS (SELECT 1 FROM public.whatsapp_recipient_exclusions rules
      WHERE rules.personal_account_id=connections.personal_account_id
        AND rules.whatsapp_connection_id=connections.id
        AND rules.recipient_locator=conversations.recipient_locator AND rules.excluded)
    AND account_keys.unavailable_at IS NULL AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL AND connection_keys.ciphertext IS NOT NULL;
$function$;
--> statement-breakpoint

-- Protected Stored Media enforces exclusion independently, because a media URI
-- is a retained handle that must stop resolving.
CREATE OR REPLACE FUNCTION public.load_protected_stored_media(
  candidate_authorization_id uuid,
  candidate_connection_public_id text,
  candidate_message_public_id text,
  candidate_media_public_id text
)
RETURNS TABLE (
  media_id uuid, object_key text, plaintext_size_bytes bigint,
  metadata_ciphertext_version smallint, metadata_key_version integer,
  metadata_nonce bytea, metadata_ciphertext bytea,
  account_key_version integer, kms_key_id text, account_key_ciphertext bytea,
  connection_account_key_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea, connection_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, public
AS $function$
  SELECT media.id,media.object_key,media.plaintext_size_bytes,
    media.metadata_ciphertext_version,media.metadata_key_version,media.metadata_nonce,media.metadata_ciphertext,
    keys.key_version,keys.kms_key_id,keys.ciphertext,
    connection_keys.account_key_version,connection_keys.key_version,connection_keys.nonce,
    connection_keys.ciphertext,connections.id
  FROM public.stored_media media
  JOIN public.stored_messages messages ON messages.personal_account_id=media.personal_account_id
    AND messages.whatsapp_connection_id=media.whatsapp_connection_id AND messages.id=media.stored_message_id
  JOIN public.whatsapp_conversations conversations ON conversations.personal_account_id=messages.personal_account_id
    AND conversations.whatsapp_connection_id=messages.whatsapp_connection_id
    AND conversations.id=messages.conversation_id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id=media.personal_account_id
    AND connections.id=media.whatsapp_connection_id
  JOIN public.mcp_authorization_connections selected ON selected.personal_account_id=media.personal_account_id
    AND selected.whatsapp_connection_id=media.whatsapp_connection_id
    AND selected.mcp_authorization_id=candidate_authorization_id
  JOIN public.whatsapp_connection_key_envelopes connection_keys ON connection_keys.personal_account_id=media.personal_account_id
    AND connection_keys.whatsapp_connection_id=media.whatsapp_connection_id
  JOIN public.personal_account_key_envelopes keys ON keys.personal_account_id=media.personal_account_id
    AND keys.key_version=connection_keys.account_key_version
  WHERE media.personal_account_id=nullif(pg_catalog.current_setting('public.personal_account_id',true),'')::uuid
    AND connections.public_id=candidate_connection_public_id
    AND messages.public_id=candidate_message_public_id
    AND media.public_id=candidate_media_public_id AND media.state='ready'
    AND media.plaintext_size_bytes <= 16777216 AND messages.deleted_at IS NULL
    AND connections.state <> 'deleting' AND keys.unavailable_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.whatsapp_recipient_exclusions rules
      WHERE rules.personal_account_id=connections.personal_account_id
        AND rules.whatsapp_connection_id=connections.id
        AND rules.recipient_locator=conversations.recipient_locator AND rules.excluded)
    AND keys.ciphertext IS NOT NULL AND connection_keys.unavailable_at IS NULL
    AND connection_keys.ciphertext IS NOT NULL;
$function$;
--> statement-breakpoint

-- The restore coordinator scans restored stable recipient identities so it can
-- derive journal prefixes without any tenant or provider identifier.
CREATE FUNCTION public.list_restore_recipient_identities(
  requested_limit integer, cursor_key text
)
RETURNS TABLE (
  personal_account_id uuid, whatsapp_connection_id uuid, recipient_kind text,
  recipient_locator text, recipient_public_id text, scan_key text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
#variable_conflict use_column
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid restore recipient scan limit';
  END IF;
  RETURN QUERY
    WITH restored AS (
      SELECT contacts.personal_account_id AS account_id,
        contacts.whatsapp_connection_id AS connection_id,
        'contact'::text AS kind, contacts.provider_identity_index::text AS locator,
        contacts.public_id AS handle
      FROM public.directory_contacts contacts
      UNION
      SELECT groups.personal_account_id, groups.whatsapp_connection_id, 'group'::text,
        groups.provider_locator, groups.public_id
      FROM public.whatsapp_groups groups
      UNION
      SELECT rules.personal_account_id, rules.whatsapp_connection_id,
        rules.recipient_kind, rules.recipient_locator, rules.recipient_public_id
      FROM public.whatsapp_recipient_exclusions rules
      UNION
      SELECT conversations.personal_account_id, conversations.whatsapp_connection_id,
        CASE WHEN conversations.kind = 'group' THEN 'group' ELSE 'contact' END,
        conversations.recipient_locator, conversations.recipient_public_id
      FROM public.whatsapp_conversations conversations
    )
    SELECT restored.account_id, restored.connection_id, restored.kind,
      restored.locator, restored.handle,
      restored.connection_id::text || '/' || restored.kind || '/' || restored.locator
    FROM restored
    WHERE cursor_key IS NULL
      OR restored.connection_id::text || '/' || restored.kind || '/' || restored.locator
        > cursor_key
    ORDER BY restored.connection_id::text || '/' || restored.kind || '/' || restored.locator
    LIMIT requested_limit;
END
$function$;
--> statement-breakpoint

-- Replays one ordered journal transition over a restored snapshot. The greatest
-- purge cutoff is reapplied whether or not the recipient is currently excluded.
CREATE FUNCTION public.replay_whatsapp_recipient_exclusion(
  requested_account_id uuid, requested_connection_id uuid, requested_kind text,
  requested_locator text, requested_public_id text, requested_excluded boolean,
  requested_effective_at timestamptz, requested_purge_cutoff_at timestamptz,
  requested_transition_id uuid, observed_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, public AS $function$
DECLARE current_rule public.whatsapp_recipient_exclusions%ROWTYPE;
BEGIN
  IF requested_kind NOT IN ('contact', 'group')
    OR requested_public_id !~ '^(ctc|grp)_[A-Za-z0-9_-]{21}$'
    OR requested_locator !~ '^(wi1|di1)_[A-Za-z0-9_-]{43}$'
    OR requested_effective_at IS NULL OR requested_transition_id IS NULL THEN
    RAISE EXCEPTION 'invalid recipient exclusion replay';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_connections connections
    WHERE connections.personal_account_id = requested_account_id
      AND connections.id = requested_connection_id
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO public.whatsapp_recipient_exclusions AS rules (
    personal_account_id, whatsapp_connection_id, recipient_kind, recipient_locator,
    recipient_public_id, excluded, effective_at, purge_cutoff_at, last_transition_id
  ) VALUES (
    requested_account_id, requested_connection_id, requested_kind, requested_locator,
    requested_public_id, requested_excluded, requested_effective_at,
    requested_purge_cutoff_at, requested_transition_id
  )
  ON CONFLICT (personal_account_id, whatsapp_connection_id, recipient_kind, recipient_locator)
  DO UPDATE SET
    excluded = CASE WHEN rules.effective_at IS NULL
      OR rules.effective_at <= excluded.effective_at
      THEN excluded.excluded ELSE rules.excluded END,
    effective_at = GREATEST(rules.effective_at, excluded.effective_at),
    purge_cutoff_at = GREATEST(rules.purge_cutoff_at, excluded.purge_cutoff_at),
    last_transition_id = CASE WHEN rules.effective_at IS NULL
      OR rules.effective_at <= excluded.effective_at
      THEN excluded.last_transition_id ELSE rules.last_transition_id END,
    transition_id = NULL, transition_excluded = NULL, transition_effective_at = NULL,
    transition_purge_cutoff_at = NULL, transition_idempotency_key = NULL,
    transition_prepared_at = NULL,
    updated_at = observed_at
  RETURNING rules.* INTO current_rule;
  PERFORM public.apply_whatsapp_recipient_exclusion_purge(
    requested_account_id, requested_connection_id, current_rule.recipient_locator,
    current_rule.recipient_public_id, current_rule.purge_cutoff_at, observed_at
  );
  RETURN true;
END
$function$;
--> statement-breakpoint

-- Restore readiness stays closed while a prepared transition has no
-- acknowledged outcome, so recovery cannot serve uncertain privacy state.
CREATE OR REPLACE FUNCTION public.complete_restore_replay(
  requested_branch_id text, requested_at timestamptz, requested_marker_count integer,
  requested_deleted_count integer, requested_expired_count integer
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.restore_readiness
    WHERE singleton AND branch_id = requested_branch_id AND state = 'ready'
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
  UPDATE public.restore_readiness SET state = 'ready', completed_at = requested_at,
    marker_count = requested_marker_count, deleted_entity_count = requested_deleted_count,
    expired_record_count = requested_expired_count
  WHERE singleton AND branch_id = requested_branch_id AND state = 'replaying';
  IF NOT FOUND THEN RAISE EXCEPTION 'restore replay is not active'; END IF;
  INSERT INTO public.restore_replay_audit
    (branch_id, completed_at, marker_count, deleted_entity_count, expired_record_count)
  VALUES (requested_branch_id, requested_at, requested_marker_count,
    requested_deleted_count, requested_expired_count)
  ON CONFLICT (branch_id) DO UPDATE SET completed_at = excluded.completed_at,
    marker_count = excluded.marker_count, deleted_entity_count = excluded.deleted_entity_count,
    expired_record_count = excluded.expired_record_count;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
  public.list_restore_recipient_identities(integer,text),
  public.replay_whatsapp_recipient_exclusion(uuid,uuid,text,text,text,boolean,timestamptz,timestamptz,uuid,timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.list_restore_recipient_identities(integer,text),
  public.replay_whatsapp_recipient_exclusion(uuid,uuid,text,text,text,boolean,timestamptz,timestamptz,uuid,timestamptz),
  public.purge_excluded_recipient_history(timestamptz,integer)
  TO whatsapp_restore_runtime;
--> statement-breakpoint
