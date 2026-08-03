ALTER TABLE app.whatsapp_connections
  ADD COLUMN message_retention_days smallint DEFAULT 30
    CHECK (message_retention_days IS NULL OR message_retention_days > 0),
  ADD COLUMN message_retention_updated_at timestamptz NOT NULL DEFAULT transaction_timestamp();

ALTER TABLE app.stored_messages
  ADD COLUMN content_expired_at timestamptz;

ALTER TABLE app.stored_messages DROP CONSTRAINT stored_messages_content_or_tombstone;
ALTER TABLE app.stored_messages ADD CONSTRAINT stored_messages_content_lifecycle CHECK (
  (deleted_at IS NULL AND content_expired_at IS NULL AND content_type IS NOT NULL
    AND content_ciphertext_version IS NOT NULL AND content_key_version IS NOT NULL
    AND content_nonce IS NOT NULL AND content_ciphertext IS NOT NULL)
  OR
  ((deleted_at IS NOT NULL OR content_expired_at IS NOT NULL) AND content_type IS NULL
    AND content_ciphertext_version IS NULL AND content_key_version IS NULL
    AND content_nonce IS NULL AND content_ciphertext IS NULL)
);

CREATE FUNCTION app_private.preserve_expired_message_content_state()
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
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app_private.load_protected_stored_media(
  candidate_authorization_id uuid, candidate_connection_public_id text,
  candidate_message_public_id text, candidate_media_public_id text
)
RETURNS TABLE (
  media_id uuid, object_key text, plaintext_size_bytes bigint,
  metadata_ciphertext_version smallint, metadata_key_version integer,
  metadata_nonce bytea, metadata_ciphertext bytea,
  account_key_version integer, kms_key_id text, account_key_ciphertext bytea,
  connection_account_key_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea, connection_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, app_private AS $function$
  SELECT media.id,media.object_key,media.plaintext_size_bytes,
    media.metadata_ciphertext_version,media.metadata_key_version,media.metadata_nonce,media.metadata_ciphertext,
    keys.key_version,keys.kms_key_id,keys.ciphertext,
    connection_keys.account_key_version,connection_keys.key_version,connection_keys.nonce,
    connection_keys.ciphertext,connections.id
  FROM app.stored_media media
  JOIN app.stored_messages messages ON messages.personal_account_id=media.personal_account_id
    AND messages.whatsapp_connection_id=media.whatsapp_connection_id AND messages.id=media.stored_message_id
  JOIN app.whatsapp_connections connections ON connections.personal_account_id=media.personal_account_id
    AND connections.id=media.whatsapp_connection_id
  JOIN app.mcp_authorization_connections selected ON selected.personal_account_id=media.personal_account_id
    AND selected.whatsapp_connection_id=media.whatsapp_connection_id
    AND selected.mcp_authorization_id=candidate_authorization_id
  JOIN app.whatsapp_connection_key_envelopes connection_keys ON connection_keys.personal_account_id=media.personal_account_id
    AND connection_keys.whatsapp_connection_id=media.whatsapp_connection_id
  JOIN app.personal_account_key_envelopes keys ON keys.personal_account_id=media.personal_account_id
    AND keys.key_version=connection_keys.account_key_version
  WHERE media.personal_account_id=nullif(pg_catalog.current_setting('app.personal_account_id',true),'')::uuid
    AND connections.public_id=candidate_connection_public_id
    AND messages.public_id=candidate_message_public_id
    AND media.public_id=candidate_media_public_id AND media.state='ready'
    AND media.plaintext_size_bytes<=16777216 AND messages.deleted_at IS NULL
    AND messages.content_expired_at IS NULL
    AND (connections.message_retention_days IS NULL OR
      messages.sent_at + make_interval(days => connections.message_retention_days)>transaction_timestamp())
    AND connections.state<>'deleting' AND keys.unavailable_at IS NULL
    AND keys.ciphertext IS NOT NULL AND connection_keys.unavailable_at IS NULL
    AND connection_keys.ciphertext IS NOT NULL;
$function$;
CREATE TRIGGER preserve_expired_message_content_state
BEFORE UPDATE ON app.stored_messages FOR EACH ROW
EXECUTE FUNCTION app_private.preserve_expired_message_content_state();

CREATE FUNCTION app_private.prevent_media_for_unavailable_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, app_private AS $function$
BEGIN
  PERFORM 1 FROM app.stored_messages messages
  WHERE messages.personal_account_id=NEW.personal_account_id
    AND messages.whatsapp_connection_id=NEW.whatsapp_connection_id
    AND messages.id=NEW.stored_message_id
    AND messages.deleted_at IS NULL AND messages.content_expired_at IS NULL
  FOR KEY SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER prevent_media_for_unavailable_message
BEFORE INSERT ON app.stored_media FOR EACH ROW
EXECUTE FUNCTION app_private.prevent_media_for_unavailable_message();

ALTER TABLE app.stored_media DROP CONSTRAINT stored_media_state_check;
ALTER TABLE app.stored_media ADD CONSTRAINT stored_media_state_check
  CHECK (state IN ('pending','ready','purging','rejected','failed'));
ALTER TABLE app.stored_media DROP CONSTRAINT stored_media_check;
ALTER TABLE app.stored_media ADD CONSTRAINT stored_media_lifecycle_check CHECK (
  (state = 'pending' AND source_ciphertext IS NOT NULL AND source_nonce IS NOT NULL
    AND source_key_version IS NOT NULL AND source_ciphertext_version IS NOT NULL
    AND object_key IS NULL AND plaintext_size_bytes IS NULL AND sha256 IS NULL
    AND metadata_ciphertext IS NULL AND failure_code IS NULL)
  OR
  (state IN ('ready','purging') AND source_ciphertext IS NULL AND source_nonce IS NULL
    AND source_key_version IS NULL AND source_ciphertext_version IS NULL
    AND object_key IS NOT NULL AND plaintext_size_bytes IS NOT NULL AND sha256 IS NOT NULL
    AND metadata_ciphertext IS NOT NULL AND metadata_nonce IS NOT NULL
    AND metadata_key_version IS NOT NULL AND metadata_ciphertext_version IS NOT NULL
    AND failure_code IS NULL)
  OR
  (state IN ('rejected','failed') AND source_ciphertext IS NULL AND source_nonce IS NULL
    AND source_key_version IS NULL AND source_ciphertext_version IS NULL
    AND object_key IS NULL AND plaintext_size_bytes IS NULL AND sha256 IS NULL
    AND metadata_ciphertext IS NULL AND metadata_nonce IS NULL
    AND metadata_key_version IS NULL AND metadata_ciphertext_version IS NULL
    AND failure_code IS NOT NULL)
);

GRANT SELECT (message_retention_days, message_retention_updated_at),
  UPDATE (message_retention_days, message_retention_updated_at)
  ON app.whatsapp_connections TO whatsapp_api_runtime;
GRANT SELECT (content_expired_at), UPDATE (content_type, content_ciphertext_version,
  content_key_version, content_nonce, content_ciphertext, content_expired_at)
  ON app.stored_messages TO whatsapp_api_runtime;

CREATE FUNCTION app_private.get_message_retention_policy(
  verified_clerk_user_id text, requested_connection_public_id text
)
RETURNS TABLE (retention_days smallint, retention_updated_at timestamptz)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, app, app_private AS $function$
  SELECT connections.message_retention_days, connections.message_retention_updated_at
  FROM app_private.clerk_identities identities
  JOIN app.personal_accounts accounts ON accounts.id=identities.personal_account_id
  JOIN app.whatsapp_connections connections ON connections.personal_account_id=accounts.id
  WHERE identities.clerk_user_id=verified_clerk_user_id AND accounts.state='active'
    AND connections.public_id=requested_connection_public_id AND connections.state<>'deleting';
$function$;

CREATE FUNCTION app_private.update_message_retention_policy(
  verified_clerk_user_id text, requested_connection_public_id text,
  expected_days smallint, requested_days smallint, requested_updated_at timestamptz
)
RETURNS TABLE (retention_days smallint, retention_updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, app_private AS $function$
DECLARE selected_account_id uuid; selected_connection_id uuid;
BEGIN
  SELECT accounts.id,connections.id INTO selected_account_id,selected_connection_id
  FROM app_private.clerk_identities identities
  JOIN app.personal_accounts accounts ON accounts.id=identities.personal_account_id
  JOIN app.whatsapp_connections connections ON connections.personal_account_id=accounts.id
  WHERE identities.clerk_user_id=verified_clerk_user_id AND accounts.state='active'
    AND connections.public_id=requested_connection_public_id AND connections.state<>'deleting'
    AND connections.message_retention_days IS NOT DISTINCT FROM expected_days
  FOR UPDATE OF connections;
  IF selected_connection_id IS NULL THEN RETURN; END IF;
  UPDATE app.whatsapp_connections SET message_retention_days=requested_days,
    message_retention_updated_at=requested_updated_at
  WHERE personal_account_id=selected_account_id AND id=selected_connection_id;
  UPDATE app.pending_send_contents pending SET expires_at=LEAST(
    operations.created_at + interval '7 days',
    CASE WHEN requested_days IS NULL THEN operations.created_at + interval '7 days'
      ELSE operations.created_at + make_interval(days => requested_days) END)
  FROM app.send_operations operations
  WHERE pending.personal_account_id=selected_account_id
    AND pending.whatsapp_connection_id=selected_connection_id
    AND operations.personal_account_id=pending.personal_account_id
    AND operations.id=pending.send_operation_id AND pending.expires_at>requested_updated_at;
  RETURN QUERY SELECT requested_days,requested_updated_at;
END
$function$;

-- Expiry keeps identity, ordering, tombstones, gaps, replay bindings and audit rows.
-- Ready media first becomes unreadable and quota remains charged until object deletion succeeds.
CREATE FUNCTION app_private.purge_expired_message_content(observed_at timestamptz, requested_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, app_private AS $function$
DECLARE candidate record; purged integer := 0;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN RAISE EXCEPTION 'invalid retention purge limit'; END IF;
  DELETE FROM app.pending_send_contents pending USING app.whatsapp_connections connections,
    app.send_operations operations
  WHERE pending.personal_account_id=connections.personal_account_id
    AND pending.whatsapp_connection_id=connections.id
    AND operations.personal_account_id=pending.personal_account_id
    AND operations.id=pending.send_operation_id
    AND (pending.expires_at<=observed_at OR (connections.message_retention_days IS NOT NULL
      AND operations.created_at + make_interval(days => connections.message_retention_days)<=observed_at));
  FOR candidate IN
    SELECT messages.personal_account_id,messages.whatsapp_connection_id,messages.conversation_id,messages.id
    FROM app.stored_messages messages
    JOIN app.whatsapp_connections connections ON connections.personal_account_id=messages.personal_account_id
      AND connections.id=messages.whatsapp_connection_id
    WHERE messages.content_expired_at IS NULL AND messages.deleted_at IS NULL
      AND connections.message_retention_days IS NOT NULL
      AND messages.sent_at + make_interval(days => connections.message_retention_days)<=observed_at
    ORDER BY messages.sent_at,messages.id FOR UPDATE OF messages SKIP LOCKED LIMIT requested_limit
  LOOP
    DELETE FROM app.stored_media WHERE personal_account_id=candidate.personal_account_id
      AND whatsapp_connection_id=candidate.whatsapp_connection_id AND stored_message_id=candidate.id
      AND state IN ('pending','rejected','failed');
    INSERT INTO app.stored_media_object_deletions(personal_account_id,object_key,requested_at)
      SELECT personal_account_id,object_key,observed_at FROM app.stored_media
      WHERE personal_account_id=candidate.personal_account_id
        AND whatsapp_connection_id=candidate.whatsapp_connection_id
        AND stored_message_id=candidate.id AND state='ready'
      ON CONFLICT DO NOTHING;
    UPDATE app.stored_media SET state='purging',updated_at=observed_at
      WHERE personal_account_id=candidate.personal_account_id
        AND whatsapp_connection_id=candidate.whatsapp_connection_id
        AND stored_message_id=candidate.id AND state='ready';
    UPDATE app.stored_messages SET content_type=NULL,content_ciphertext_version=NULL,
      content_key_version=NULL,content_nonce=NULL,content_ciphertext=NULL,content_expired_at=observed_at,
      updated_at=observed_at WHERE personal_account_id=candidate.personal_account_id AND id=candidate.id;
    UPDATE app.whatsapp_conversations conversations SET
      last_activity_at=latest.sent_at,last_activity_direction=latest.direction,updated_at=observed_at
    FROM (SELECT sent_at,direction FROM app.stored_messages
      WHERE personal_account_id=candidate.personal_account_id
        AND whatsapp_connection_id=candidate.whatsapp_connection_id
        AND conversation_id=candidate.conversation_id AND content_expired_at IS NULL
      ORDER BY sent_at DESC,public_id DESC LIMIT 1) latest
    WHERE conversations.personal_account_id=candidate.personal_account_id
      AND conversations.whatsapp_connection_id=candidate.whatsapp_connection_id
      AND conversations.id=candidate.conversation_id;
    purged := purged + 1;
  END LOOP;
  RETURN purged;
END
$function$;

CREATE FUNCTION app_private.finish_stored_media_object_deletion(requested_account_id uuid, requested_object_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, app_private AS $function$
DECLARE released_bytes bigint;
BEGIN
  PERFORM 1 FROM app.personal_accounts WHERE id=requested_account_id FOR UPDATE;
  SELECT plaintext_size_bytes INTO released_bytes FROM app.stored_media
    WHERE personal_account_id=requested_account_id AND object_key=requested_object_key AND state='purging' FOR UPDATE;
  IF released_bytes IS NOT NULL THEN
    DELETE FROM app.stored_media WHERE personal_account_id=requested_account_id
      AND object_key=requested_object_key AND state='purging';
    UPDATE app.personal_accounts SET stored_media_used_bytes=stored_media_used_bytes-released_bytes
      WHERE id=requested_account_id;
  END IF;
  DELETE FROM app.stored_media_object_deletions WHERE personal_account_id=requested_account_id
    AND object_key=requested_object_key;
END
$function$;

REVOKE ALL ON FUNCTION app_private.get_message_retention_policy(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.update_message_retention_policy(text,text,smallint,smallint,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.purge_expired_message_content(timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.finish_stored_media_object_deletion(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.get_message_retention_policy(text,text),
  app_private.update_message_retention_policy(text,text,smallint,smallint,timestamptz),
  app_private.purge_expired_message_content(timestamptz,integer),
  app_private.finish_stored_media_object_deletion(uuid,text) TO whatsapp_api_runtime;

CREATE OR REPLACE FUNCTION app_private.load_mcp_message_read_material(
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
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
  SELECT connections.id,connections.created_at,connections.message_retention_days,
    connections.personal_account_id,
    account_keys.key_version,account_keys.kms_key_id,account_keys.ciphertext,
    connection_keys.account_key_version,connection_keys.key_version,connection_keys.nonce,connection_keys.ciphertext
  FROM app.mcp_authorizations authorizations
  JOIN app.mcp_authorization_connections selected ON selected.personal_account_id=authorizations.personal_account_id
    AND selected.mcp_authorization_id=authorizations.id
  JOIN app.whatsapp_connections connections ON connections.personal_account_id=selected.personal_account_id
    AND connections.id=selected.whatsapp_connection_id
  JOIN app.whatsapp_conversations conversations ON conversations.personal_account_id=connections.personal_account_id
    AND conversations.whatsapp_connection_id=connections.id
  JOIN app.personal_account_key_envelopes account_keys ON account_keys.personal_account_id=connections.personal_account_id
  JOIN app.whatsapp_connection_key_envelopes connection_keys ON connection_keys.personal_account_id=connections.personal_account_id
    AND connection_keys.whatsapp_connection_id=connections.id AND connection_keys.account_key_version=account_keys.key_version
  JOIN app.personal_accounts accounts ON accounts.id=authorizations.personal_account_id
  WHERE authorizations.id=requested_authorization_id
    AND authorizations.oauth_subject=requested_oauth_subject
    AND (requested_client_id IS NULL OR authorizations.client_id=requested_client_id)
    AND authorizations.personal_account_id=nullif(pg_catalog.current_setting('app.personal_account_id',true),'')::uuid
    AND authorizations.state='active' AND authorizations.refresh_family_state='active'
    AND authorizations.absolute_expires_at>requested_at AND accounts.state='active'
    AND EXISTS (SELECT 1 FROM app_private.clerk_identities identities
      WHERE identities.personal_account_id=authorizations.personal_account_id)
    AND 'messages:read'=ANY(authorizations.scopes)
    AND connections.public_id=requested_connection_public_id
    AND conversations.public_id=requested_conversation_public_id AND connections.state<>'deleting'
    AND account_keys.unavailable_at IS NULL AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL AND connection_keys.ciphertext IS NOT NULL;
$function$;
