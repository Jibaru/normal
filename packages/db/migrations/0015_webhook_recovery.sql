ALTER TABLE app.webhook_events
  ADD COLUMN dead_lettered_at timestamptz,
  ADD CONSTRAINT webhook_event_dead_letter_order
    CHECK (
      dead_lettered_at IS NULL
      OR dead_lettered_at >= received_at
    );

CREATE TABLE app.ingestion_gaps (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cause text NOT NULL
    CHECK (
      cause IN (
        'connection_unavailable',
        'webhook_configuration',
        'ingress_failure',
        'processing_failure',
        'restore_loss'
      )
    ),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  evidence_webhook_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id, id),
  UNIQUE (id),
  UNIQUE (evidence_webhook_event_id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
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
    ON DELETE SET NULL (evidence_webhook_event_id),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX ingestion_gaps_connection_time
ON app.ingestion_gaps (
  personal_account_id,
  whatsapp_connection_id,
  starts_at,
  ends_at
);

ALTER TABLE app.ingestion_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ingestion_gaps FORCE ROW LEVEL SECURITY;

CREATE POLICY ingestion_gaps_tenant
ON app.ingestion_gaps
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
  ON app.ingestion_gaps
  TO whatsapp_webhook_runtime;
GRANT SELECT
  ON app.ingestion_gaps
  TO whatsapp_api_runtime;

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
