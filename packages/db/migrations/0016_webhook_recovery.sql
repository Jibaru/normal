ALTER TABLE app.webhook_events
  ADD COLUMN dead_lettered_at timestamptz,
  ADD CONSTRAINT webhook_event_dead_letter_order
    CHECK (
      dead_lettered_at IS NULL
      OR dead_lettered_at >= received_at
    );

ALTER TABLE app.ingestion_gaps
  ADD COLUMN evidence_webhook_event_id uuid,
  ADD CONSTRAINT ingestion_gaps_evidence_webhook_event_unique
    UNIQUE (evidence_webhook_event_id),
  ADD CONSTRAINT ingestion_gaps_evidence_webhook_event
    FOREIGN KEY (
    personal_account_id,
    whatsapp_connection_id,
    evidence_webhook_event_id
  )
    REFERENCES app.webhook_events (
      personal_account_id,
      whatsapp_connection_id,
      id
    )
    ON DELETE SET NULL (evidence_webhook_event_id);

CREATE FUNCTION app_private.classify_webhook_recovery_candidates(
  requested_candidates jsonb
)
RETURNS TABLE (
  candidate_index integer,
  status text
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH candidates AS (
    SELECT parsed.*
    FROM pg_catalog.jsonb_to_recordset(requested_candidates) AS parsed (
      candidate_index integer,
      personal_account_id uuid,
      whatsapp_connection_id uuid,
      event_id uuid,
      ciphertext_sha256 text,
      payload_bytes integer,
      received_at timestamptz
    )
  )
  SELECT
    candidates.candidate_index,
    CASE
      WHEN accounts.id IS NULL
        OR connections.id IS NULL
        OR connections.state = 'deleting'
        THEN 'source_unavailable'
      WHEN events.id IS NULL
        THEN 'unclaimed'
      WHEN events.ciphertext_sha256 = candidates.ciphertext_sha256
        AND events.payload_bytes = candidates.payload_bytes
        AND events.received_at = candidates.received_at
        THEN 'claimed'
      ELSE 'conflict'
    END
  FROM candidates
  LEFT JOIN app.personal_accounts AS accounts
    ON accounts.id = candidates.personal_account_id
   AND accounts.state = 'active'
  LEFT JOIN app.whatsapp_connections AS connections
    ON connections.personal_account_id = candidates.personal_account_id
   AND connections.id = candidates.whatsapp_connection_id
  LEFT JOIN app.webhook_events AS events
    ON events.personal_account_id = candidates.personal_account_id
   AND events.whatsapp_connection_id = candidates.whatsapp_connection_id
   AND events.id = candidates.event_id
  ORDER BY candidates.candidate_index
$function$;

REVOKE ALL
  ON FUNCTION app_private.classify_webhook_recovery_candidates(jsonb)
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION app_private.classify_webhook_recovery_candidates(jsonb)
  TO whatsapp_webhook_runtime;

CREATE FUNCTION app_private.record_webhook_dead_letter_gap(
  requested_personal_account_id uuid,
  requested_connection_id uuid,
  requested_event_id uuid,
  requested_detected_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  gap_exists boolean;
BEGIN
  INSERT INTO app.ingestion_gaps (
    personal_account_id,
    whatsapp_connection_id,
    cause,
    history_window_started_at,
    starts_at,
    detected_at,
    updated_at,
    evidence_webhook_event_id
  )
  SELECT
    connections.personal_account_id,
    connections.id,
    'processing_failure',
    connections.created_at,
    greatest(connections.created_at, events.received_at),
    requested_detected_at,
    requested_detected_at,
    events.id
  FROM app.whatsapp_connections AS connections
  JOIN app.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
   AND accounts.state = 'active'
  JOIN app.webhook_events AS events
    ON events.personal_account_id = connections.personal_account_id
   AND events.whatsapp_connection_id = connections.id
   AND events.id = requested_event_id
   AND events.processing_completed_at IS NULL
  WHERE connections.personal_account_id = requested_personal_account_id
    AND connections.id = requested_connection_id
    AND connections.state <> 'deleting'
  ON CONFLICT DO NOTHING;

  SELECT EXISTS (
    SELECT 1
    FROM app.ingestion_gaps AS gaps
    WHERE gaps.personal_account_id = requested_personal_account_id
      AND gaps.whatsapp_connection_id = requested_connection_id
      AND gaps.cause = 'processing_failure'
      AND gaps.ends_at IS NULL
  )
  INTO gap_exists;

  RETURN gap_exists;
END
$function$;

REVOKE ALL
  ON FUNCTION app_private.record_webhook_dead_letter_gap(
    uuid,
    uuid,
    uuid,
    timestamptz
  )
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION app_private.record_webhook_dead_letter_gap(
    uuid,
    uuid,
    uuid,
    timestamptz
  )
  TO whatsapp_webhook_runtime;
