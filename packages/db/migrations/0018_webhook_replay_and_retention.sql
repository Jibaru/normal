ALTER TABLE app.webhook_items
  DROP CONSTRAINT webhook_items_personal_account_id_whatsapp_connection_id_f_fkey,
  ALTER COLUMN first_webhook_event_id DROP NOT NULL,
  ADD CONSTRAINT webhook_items_first_event
    FOREIGN KEY (
      personal_account_id,
      whatsapp_connection_id,
      first_webhook_event_id
    )
    REFERENCES app.webhook_events (
      personal_account_id,
      whatsapp_connection_id,
      id
    )
    ON DELETE SET NULL (first_webhook_event_id);

CREATE TABLE app.webhook_dead_letter_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  webhook_event_id uuid,
  detected_at timestamptz NOT NULL,
  source_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (webhook_event_id),
  FOREIGN KEY (
    personal_account_id,
    whatsapp_connection_id
  )
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (
    personal_account_id,
    whatsapp_connection_id,
    webhook_event_id
  )
    REFERENCES app.webhook_events (
      personal_account_id,
      whatsapp_connection_id,
      id
    )
    ON DELETE SET NULL (webhook_event_id)
);

CREATE TABLE app.webhook_replay_attempts (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  incident_id uuid NOT NULL
    REFERENCES app.webhook_dead_letter_incidents (id) ON DELETE CASCADE,
  operator_reference text NOT NULL
    CHECK (operator_reference ~ '^[a-f0-9]{64}$'),
  reason_code text NOT NULL
    CHECK (
      reason_code IN (
        'dependency_recovered',
        'schema_support_deployed',
        'transient_incident_resolved'
      )
    ),
  requested_at timestamptz NOT NULL,
  status text NOT NULL
    CHECK (status IN ('pending', 'dispatched', 'source_unavailable')),
  dispatched_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (expires_at = requested_at + interval '90 days'),
  CHECK (
    (status IN ('pending', 'source_unavailable') AND dispatched_at IS NULL)
    OR
    (
      status = 'dispatched'
      AND dispatched_at IS NOT NULL
      AND dispatched_at >= requested_at
    )
  )
);

CREATE INDEX webhook_replay_attempts_incident
ON app.webhook_replay_attempts (incident_id, requested_at, id);

ALTER TABLE app.webhook_dead_letter_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_dead_letter_incidents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_replay_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_replay_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY webhook_dead_letter_incidents_tenant
ON app.webhook_dead_letter_incidents
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid
);

CREATE POLICY webhook_replay_attempts_tenant
ON app.webhook_replay_attempts
USING (
  personal_account_id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid
)
WITH CHECK (
  personal_account_id = nullif(
    pg_catalog.current_setting('app.personal_account_id', true),
    ''
  )::uuid
);

GRANT SELECT, INSERT
  ON app.webhook_dead_letter_incidents
  TO whatsapp_webhook_runtime;

CREATE FUNCTION app_private.resolve_webhook_processing_gap(
  requested_personal_account_id uuid,
  requested_connection_id uuid,
  requested_event_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  completed_at timestamptz;
BEGIN
  SELECT events.processing_completed_at
  INTO completed_at
  FROM app.webhook_events AS events
  WHERE events.personal_account_id = requested_personal_account_id
    AND events.personal_account_id = nullif(
      pg_catalog.current_setting('app.personal_account_id', true),
      ''
    )::uuid
    AND events.whatsapp_connection_id = requested_connection_id
    AND events.id = requested_event_id
    AND events.processing_completed_at IS NOT NULL;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE app.ingestion_gaps AS gaps
  SET
    ends_at = greatest(gaps.starts_at, completed_at),
    updated_at = greatest(gaps.updated_at, completed_at)
  WHERE gaps.personal_account_id = requested_personal_account_id
    AND gaps.whatsapp_connection_id = requested_connection_id
    AND gaps.evidence_webhook_event_id = requested_event_id
    AND gaps.cause = 'processing_failure'
    AND gaps.ends_at IS NULL;

  RETURN true;
END
$function$;

CREATE FUNCTION app_private.prepare_webhook_replay(
  requested_id uuid,
  requested_incident_id uuid,
  requested_operator_reference text,
  requested_reason_code text,
  requested_at timestamptz,
  observed_at timestamptz
)
RETURNS TABLE (
  outcome text,
  event_id uuid,
  personal_account_id uuid,
  whatsapp_connection_id uuid,
  ciphertext_sha256 text,
  payload_bytes integer,
  received_at timestamptz
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  existing app.webhook_replay_attempts%ROWTYPE;
  incident app.webhook_dead_letter_incidents%ROWTYPE;
  source app.webhook_events%ROWTYPE;
BEGIN
  IF requested_operator_reference !~ '^[a-f0-9]{64}$'
    OR requested_at > observed_at + interval '5 minutes'
    OR requested_reason_code NOT IN (
      'dependency_recovered',
      'schema_support_deployed',
      'transient_incident_resolved'
    )
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Webhook Event replay request';
  END IF;

  SELECT attempts.*
  INTO existing
  FROM app.webhook_replay_attempts AS attempts
  WHERE attempts.id = requested_id
  FOR UPDATE;

  IF FOUND THEN
    IF existing.incident_id <> requested_incident_id
      OR existing.operator_reference <> requested_operator_reference
      OR existing.reason_code <> requested_reason_code
      OR existing.requested_at <> requested_at
    THEN
      RAISE unique_violation
        USING MESSAGE = 'conflicting Webhook Event replay request';
    END IF;

    SELECT incidents.*
    INTO incident
    FROM app.webhook_dead_letter_incidents AS incidents
    WHERE incidents.id = existing.incident_id;

    SELECT events.*
    INTO source
    FROM app.webhook_events AS events
    WHERE events.personal_account_id = existing.personal_account_id
      AND events.whatsapp_connection_id = existing.whatsapp_connection_id
      AND events.id = incident.webhook_event_id;

    IF source.id IS NULL OR observed_at >= source.source_expires_at THEN
      UPDATE app.webhook_replay_attempts AS attempts
      SET status = 'source_unavailable'
      WHERE attempts.id = existing.id
        AND attempts.status = 'pending';

      RETURN QUERY SELECT
        'source_unavailable'::text,
        NULL::uuid,
        NULL::uuid,
        NULL::uuid,
        NULL::text,
        NULL::integer,
        NULL::timestamptz;
      RETURN;
    END IF;

    RETURN QUERY SELECT
      CASE
        WHEN existing.status = 'dispatched' THEN 'already_dispatched'::text
        ELSE 'pending'::text
      END,
      source.id,
      source.personal_account_id,
      source.whatsapp_connection_id,
      source.ciphertext_sha256,
      source.payload_bytes,
      source.received_at;
    RETURN;
  END IF;

  SELECT incidents.*
  INTO incident
  FROM app.webhook_dead_letter_incidents AS incidents
  WHERE incidents.id = requested_incident_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'source_unavailable'::text,
      NULL::uuid,
      NULL::uuid,
      NULL::uuid,
      NULL::text,
      NULL::integer,
      NULL::timestamptz;
    RETURN;
  END IF;

  IF incident.webhook_event_id IS NULL THEN
    INSERT INTO app.webhook_replay_attempts (
      id,
      personal_account_id,
      whatsapp_connection_id,
      incident_id,
      operator_reference,
      reason_code,
      requested_at,
      status,
      expires_at
    )
    VALUES (
      requested_id,
      incident.personal_account_id,
      incident.whatsapp_connection_id,
      incident.id,
      requested_operator_reference,
      requested_reason_code,
      requested_at,
      'source_unavailable',
      requested_at + interval '90 days'
    );

    RETURN QUERY SELECT
      'source_unavailable'::text,
      NULL::uuid,
      NULL::uuid,
      NULL::uuid,
      NULL::text,
      NULL::integer,
      NULL::timestamptz;
    RETURN;
  END IF;

  SELECT events.*
  INTO source
  FROM app.webhook_events AS events
  WHERE events.personal_account_id = incident.personal_account_id
    AND events.whatsapp_connection_id = incident.whatsapp_connection_id
    AND events.id = incident.webhook_event_id
    AND events.dead_lettered_at IS NOT NULL
    AND events.processing_completed_at IS NULL
    AND observed_at < events.source_expires_at
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO app.webhook_replay_attempts (
      id,
      personal_account_id,
      whatsapp_connection_id,
      incident_id,
      operator_reference,
      reason_code,
      requested_at,
      status,
      expires_at
    )
    VALUES (
      requested_id,
      incident.personal_account_id,
      incident.whatsapp_connection_id,
      incident.id,
      requested_operator_reference,
      requested_reason_code,
      requested_at,
      'source_unavailable',
      requested_at + interval '90 days'
    );

    RETURN QUERY SELECT
      'source_unavailable'::text,
      NULL::uuid,
      NULL::uuid,
      NULL::uuid,
      NULL::text,
      NULL::integer,
      NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO app.webhook_replay_attempts (
    id,
    personal_account_id,
    whatsapp_connection_id,
    incident_id,
    operator_reference,
    reason_code,
    requested_at,
    status,
    expires_at
  )
  VALUES (
    requested_id,
    source.personal_account_id,
    source.whatsapp_connection_id,
    incident.id,
    requested_operator_reference,
    requested_reason_code,
    requested_at,
    'pending',
    requested_at + interval '90 days'
  );

  RETURN QUERY SELECT
    'pending'::text,
    source.id,
    source.personal_account_id,
    source.whatsapp_connection_id,
    source.ciphertext_sha256,
    source.payload_bytes,
    source.received_at;
END
$function$;

CREATE FUNCTION app_private.complete_webhook_replay(
  requested_id uuid,
  requested_dispatched_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  UPDATE app.webhook_replay_attempts AS attempts
  SET
    status = 'dispatched',
    dispatched_at = coalesce(attempts.dispatched_at, requested_dispatched_at)
  WHERE attempts.id = requested_id
    AND attempts.status IN ('pending', 'dispatched')
    AND requested_dispatched_at >= attempts.requested_at;
  RETURN FOUND;
END
$function$;

CREATE FUNCTION app_private.list_expired_webhook_sources(
  observed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (event_id uuid)
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 100 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Webhook Event retention limit';
  END IF;

  RETURN QUERY
  SELECT events.id
  FROM app.webhook_events AS events
  WHERE events.source_expires_at <= observed_at
  ORDER BY events.source_expires_at, events.id
  LIMIT requested_limit;
END
$function$;

CREATE FUNCTION app_private.finalize_expired_webhook_source(
  requested_event_id uuid,
  observed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  UPDATE app.whatsapp_connections AS connections
  SET state_webhook_event_id = NULL
  FROM app.webhook_events AS events
  WHERE events.id = requested_event_id
    AND events.source_expires_at <= observed_at
    AND connections.personal_account_id = events.personal_account_id
    AND connections.id = events.whatsapp_connection_id
    AND connections.state_webhook_event_id = events.id;

  DELETE FROM app.webhook_events AS events
  WHERE events.id = requested_event_id
    AND events.source_expires_at <= observed_at;
  RETURN FOUND;
END
$function$;

REVOKE ALL
  ON TABLE app.webhook_replay_attempts
  FROM PUBLIC, whatsapp_api_runtime, whatsapp_webhook_runtime;
REVOKE ALL
  ON FUNCTION app_private.resolve_webhook_processing_gap(uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.prepare_webhook_replay(
    uuid,
    uuid,
    text,
    text,
    timestamptz,
    timestamptz
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.complete_webhook_replay(uuid, timestamptz)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.list_expired_webhook_sources(timestamptz, integer)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.finalize_expired_webhook_source(uuid, timestamptz)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.resolve_webhook_processing_gap(uuid, uuid, uuid)
  TO whatsapp_webhook_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.prepare_webhook_replay(
    uuid,
    uuid,
    text,
    text,
    timestamptz,
    timestamptz
  )
  TO whatsapp_webhook_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.complete_webhook_replay(uuid, timestamptz)
  TO whatsapp_webhook_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.list_expired_webhook_sources(timestamptz, integer)
  TO whatsapp_webhook_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.finalize_expired_webhook_source(uuid, timestamptz)
  TO whatsapp_webhook_runtime;
