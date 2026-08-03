DO $roles$
DECLARE role_name name;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'whatsapp_break_glass_requester'::name,
    'whatsapp_break_glass_approver'::name,
    'whatsapp_break_glass_runtime'::name
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
      role_name
    );
  END LOOP;
END
$roles$;

GRANT USAGE ON SCHEMA app_private TO
  whatsapp_break_glass_requester,
  whatsapp_break_glass_approver,
  whatsapp_break_glass_runtime;

CREATE TABLE app_private.break_glass_requests (
  id uuid PRIMARY KEY,
  incident_reference text NOT NULL CHECK (length(incident_reference) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  requester_reference text NOT NULL CHECK (requester_reference ~ '^[A-Za-z0-9_-]{3,128}$'),
  personal_account_id uuid NOT NULL REFERENCES app.personal_accounts (id),
  capability text NOT NULL CHECK (capability IN ('message_content', 'stored_media')),
  legal_notification_prohibition text CHECK (
    legal_notification_prohibition IS NULL OR length(legal_notification_prohibition) BETWEEN 1 AND 2000
  ),
  requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  credential_sha256 text CHECK (credential_sha256 ~ '^[a-f0-9]{64}$'),
  credential_issued_at timestamptz,
  CHECK (expires_at > requested_at AND expires_at <= requested_at + interval '1 hour'),
  CHECK ((credential_sha256 IS NULL) = (credential_issued_at IS NULL))
);

CREATE TABLE app_private.break_glass_approvals (
  request_id uuid NOT NULL REFERENCES app_private.break_glass_requests (id),
  approver_reference text NOT NULL CHECK (approver_reference ~ '^[A-Za-z0-9_-]{3,128}$'),
  approved_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (request_id, approver_reference)
);

CREATE TABLE app_private.break_glass_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES app_private.break_glass_requests (id),
  event_type text NOT NULL CHECK (event_type IN (
    'requested', 'approved', 'credential_issued', 'decryption_attempt_allowed',
    'decryption_attempt_denied', 'decryption_succeeded', 'decryption_failed', 'expired'
  )),
  actor_reference text NOT NULL CHECK (actor_reference ~ '^[A-Za-z0-9_-]{3,128}$'),
  outcome text NOT NULL CHECK (outcome IN ('recorded', 'allowed', 'denied')),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE app_private.break_glass_user_notifications (
  request_id uuid PRIMARY KEY REFERENCES app_private.break_glass_requests (id),
  personal_account_id uuid NOT NULL REFERENCES app.personal_accounts (id),
  queued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  delivered_at timestamptz,
  CHECK (delivered_at IS NULL OR delivered_at >= queued_at)
);

REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM
  whatsapp_break_glass_requester,
  whatsapp_break_glass_approver,
  whatsapp_break_glass_runtime;

CREATE FUNCTION app_private.break_glass_audit_is_append_only()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'break-glass audit events are immutable';
END
$function$;

CREATE TRIGGER break_glass_audit_is_append_only
BEFORE UPDATE OR DELETE ON app_private.break_glass_audit_events
FOR EACH ROW EXECUTE FUNCTION app_private.break_glass_audit_is_append_only();

CREATE FUNCTION app_private.create_break_glass_request(
  request_id uuid,
  incident_reference text,
  requester_reference text,
  personal_account_id uuid,
  capability text,
  expires_at timestamptz,
  reason text DEFAULT 'Scoped incident investigation',
  legal_notification_prohibition text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  INSERT INTO app_private.break_glass_requests (
    id, incident_reference, reason, requester_reference, personal_account_id,
    capability, expires_at, legal_notification_prohibition
  ) VALUES (
    request_id, incident_reference, reason, requester_reference,
    personal_account_id, capability, expires_at, legal_notification_prohibition
  );
  INSERT INTO app_private.break_glass_audit_events
    (request_id, event_type, actor_reference, outcome)
  VALUES (request_id, 'requested', requester_reference, 'recorded');
END
$function$;

CREATE FUNCTION app_private.approve_break_glass_request(
  request_id uuid, approver_reference text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE request app_private.break_glass_requests;
BEGIN
  SELECT * INTO STRICT request FROM app_private.break_glass_requests
  WHERE id = request_id FOR UPDATE;
  IF request.expires_at <= statement_timestamp() OR request.credential_issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'break-glass request is not approvable';
  END IF;
  IF request.requester_reference = approver_reference THEN
    RAISE EXCEPTION 'requester cannot approve own break-glass request';
  END IF;
  INSERT INTO app_private.break_glass_approvals VALUES
    (request_id, approver_reference, statement_timestamp());
  INSERT INTO app_private.break_glass_audit_events
    (request_id, event_type, actor_reference, outcome)
  VALUES (request_id, 'approved', approver_reference, 'recorded');
END
$function$;

CREATE FUNCTION app_private.issue_break_glass_credential(
  request_id uuid, issuer_reference text, credential_sha256 text
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE request app_private.break_glass_requests;
DECLARE approval_count integer;
BEGIN
  SELECT * INTO STRICT request FROM app_private.break_glass_requests
  WHERE id = request_id FOR UPDATE;
  SELECT count(*)::integer INTO approval_count
  FROM app_private.break_glass_approvals AS approvals
  WHERE approvals.request_id = request.id;
  IF approval_count <> 2 OR request.expires_at <= statement_timestamp()
     OR request.credential_issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'break-glass credential requirements are not satisfied';
  END IF;
  UPDATE app_private.break_glass_requests SET
    credential_sha256 = issue_break_glass_credential.credential_sha256,
    credential_issued_at = statement_timestamp()
  WHERE id = request.id;
  INSERT INTO app_private.break_glass_audit_events
    (request_id, event_type, actor_reference, outcome)
  VALUES (request.id, 'credential_issued', issuer_reference, 'recorded');
  RETURN request.expires_at;
END
$function$;

CREATE FUNCTION app_private.authorize_break_glass_attempt(
  request_id uuid, credential_sha256 text, personal_account_id uuid, capability text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE request app_private.break_glass_requests;
DECLARE allowed boolean;
BEGIN
  SELECT * INTO request FROM app_private.break_glass_requests WHERE id = request_id FOR UPDATE;
  allowed := COALESCE(request.id IS NOT NULL
    AND request.credential_sha256 = authorize_break_glass_attempt.credential_sha256
    AND request.personal_account_id = authorize_break_glass_attempt.personal_account_id
    AND request.capability = authorize_break_glass_attempt.capability
    AND request.credential_issued_at IS NOT NULL
    AND request.expires_at > statement_timestamp(), false);
  IF request.id IS NOT NULL THEN
    INSERT INTO app_private.break_glass_audit_events
      (request_id, event_type, actor_reference, outcome)
    VALUES (
      request.id,
      CASE WHEN allowed THEN 'decryption_attempt_allowed' ELSE 'decryption_attempt_denied' END,
      'break-glass-runtime', CASE WHEN allowed THEN 'allowed' ELSE 'denied' END
    );
    IF allowed AND request.legal_notification_prohibition IS NULL THEN
      INSERT INTO app_private.break_glass_user_notifications (request_id, personal_account_id)
      VALUES (request.id, request.personal_account_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN allowed;
END
$function$;

CREATE FUNCTION app_private.record_break_glass_decryption_result(
  request_id uuid, credential_sha256 text, succeeded boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE request app_private.break_glass_requests;
BEGIN
  SELECT * INTO STRICT request FROM app_private.break_glass_requests WHERE id = request_id FOR UPDATE;
  IF request.credential_sha256 IS DISTINCT FROM record_break_glass_decryption_result.credential_sha256
     OR request.credential_issued_at IS NULL OR request.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'break-glass result credential is invalid or expired';
  END IF;
  INSERT INTO app_private.break_glass_audit_events
    (request_id, event_type, actor_reference, outcome)
  VALUES (
    request.id, CASE WHEN succeeded THEN 'decryption_succeeded' ELSE 'decryption_failed' END,
    'break-glass-runtime', CASE WHEN succeeded THEN 'allowed' ELSE 'denied' END
  );
END
$function$;

CREATE FUNCTION app_private.expire_break_glass_requests(maximum_rows integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE expired_count integer;
BEGIN
  IF maximum_rows < 1 OR maximum_rows > 1000 THEN
    RAISE EXCEPTION 'maximum_rows must be between 1 and 1000';
  END IF;
  WITH candidates AS (
    SELECT requests.id
    FROM app_private.break_glass_requests AS requests
    WHERE requests.expires_at <= statement_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM app_private.break_glass_audit_events AS events
        WHERE events.request_id = requests.id AND events.event_type = 'expired'
      )
    ORDER BY requests.expires_at, requests.id
    LIMIT maximum_rows FOR UPDATE SKIP LOCKED
  ), inserted AS (
    INSERT INTO app_private.break_glass_audit_events
      (request_id, event_type, actor_reference, outcome)
    SELECT id, 'expired', 'break-glass-runtime', 'recorded' FROM candidates
    RETURNING 1
  ) SELECT count(*)::integer INTO expired_count FROM inserted;
  RETURN expired_count;
END
$function$;

REVOKE ALL ON FUNCTION app_private.create_break_glass_request(uuid,text,text,uuid,text,timestamptz,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.approve_break_glass_request(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.issue_break_glass_credential(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.authorize_break_glass_attempt(uuid,text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.record_break_glass_decryption_result(uuid,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.expire_break_glass_requests(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.create_break_glass_request(uuid,text,text,uuid,text,timestamptz,text,text) TO whatsapp_break_glass_requester;
GRANT EXECUTE ON FUNCTION app_private.approve_break_glass_request(uuid,text) TO whatsapp_break_glass_approver;
GRANT EXECUTE ON FUNCTION app_private.issue_break_glass_credential(uuid,text,text) TO whatsapp_break_glass_runtime;
GRANT EXECUTE ON FUNCTION app_private.authorize_break_glass_attempt(uuid,text,uuid,text) TO whatsapp_break_glass_runtime;
GRANT EXECUTE ON FUNCTION app_private.record_break_glass_decryption_result(uuid,text,boolean) TO whatsapp_break_glass_runtime;
GRANT EXECUTE ON FUNCTION app_private.expire_break_glass_requests(integer) TO whatsapp_break_glass_runtime;
