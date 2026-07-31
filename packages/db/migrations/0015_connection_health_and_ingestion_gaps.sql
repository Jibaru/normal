ALTER TABLE app.whatsapp_connections
  ADD COLUMN health_last_checked_at timestamptz,
  ADD COLUMN health_last_confirmed_at timestamptz,
  ADD COLUMN health_claim_id uuid,
  ADD COLUMN health_lease_expires_at timestamptz,
  ADD COLUMN state_snapshot_observed_at timestamptz,
  ADD CONSTRAINT whatsapp_connection_health_lease_complete
    CHECK (
      (health_claim_id IS NULL AND health_lease_expires_at IS NULL)
      OR
      (health_claim_id IS NOT NULL AND health_lease_expires_at IS NOT NULL)
    );

UPDATE app.whatsapp_connections
SET health_last_confirmed_at = created_at
WHERE connection_setup_id IS NOT NULL;

CREATE FUNCTION app_private.initialize_whatsapp_connection_health()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.state = 'connected' AND NEW.health_last_confirmed_at IS NULL THEN
    NEW.health_last_confirmed_at := NEW.created_at;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER initialize_whatsapp_connection_health
BEFORE INSERT ON app.whatsapp_connections
FOR EACH ROW
EXECUTE FUNCTION app_private.initialize_whatsapp_connection_health();

CREATE FUNCTION app_private.track_whatsapp_connection_state_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.state_received_at > OLD.state_received_at
    AND NEW.state_provider_occurred_at IS NULL
    AND NEW.state_provider_version IS NULL
    AND NEW.state_webhook_event_id IS NULL
  THEN
    NEW.state_snapshot_observed_at := NEW.state_received_at;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER track_whatsapp_connection_state_snapshot
BEFORE UPDATE ON app.whatsapp_connections
FOR EACH ROW
EXECUTE FUNCTION app_private.track_whatsapp_connection_state_snapshot();

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
  history_window_started_at timestamptz NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  detected_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (personal_account_id, whatsapp_connection_id, id),
  UNIQUE (id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (starts_at >= history_window_started_at),
  CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CHECK (updated_at >= detected_at)
);

CREATE UNIQUE INDEX ingestion_gaps_one_active_cause
ON app.ingestion_gaps (
  personal_account_id,
  whatsapp_connection_id,
  cause
)
WHERE ends_at IS NULL;

CREATE INDEX ingestion_gaps_connection_interval
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

REVOKE ALL
  ON TABLE app.ingestion_gaps
  FROM PUBLIC, whatsapp_api_runtime, whatsapp_webhook_runtime;

CREATE FUNCTION app_private.claim_whatsapp_connection_health(
  requested_claimed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  health_claim_id uuid,
  whatsapp_connection_id uuid,
  connection_setup_marker text,
  webhook_ingress_id uuid
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 100 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid connection health claim limit';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT connections.id
    FROM app.whatsapp_connections AS connections
    JOIN app.personal_accounts AS accounts
      ON accounts.id = connections.personal_account_id
    JOIN app.connection_setups AS setups
      ON setups.personal_account_id = connections.personal_account_id
     AND setups.id = connections.connection_setup_id
    WHERE accounts.state = 'active'
      AND setups.state = 'activated'
      AND connections.state <> 'deleting'
      AND (
        connections.lifecycle_claim_id IS NULL
        OR connections.lifecycle_lease_expires_at <= requested_claimed_at
      )
      AND (
        connections.health_claim_id IS NULL
        OR connections.health_lease_expires_at <= requested_claimed_at
      )
      AND (
        connections.health_last_checked_at IS NULL
        OR connections.health_last_checked_at
          < date_bin(
            interval '5 minutes',
            requested_claimed_at,
            timestamptz '2000-01-01 00:00:00+00'
          )
      )
    ORDER BY
      connections.health_last_checked_at NULLS FIRST,
      connections.created_at,
      connections.id
    LIMIT requested_limit
    FOR UPDATE OF connections SKIP LOCKED
  ), claimed AS (
    UPDATE app.whatsapp_connections AS connections
    SET
      health_claim_id = gen_random_uuid(),
      health_lease_expires_at = requested_claimed_at + interval '4 minutes',
      updated_at = greatest(connections.updated_at, requested_claimed_at)
    FROM candidates
    WHERE connections.id = candidates.id
    RETURNING
      connections.health_claim_id,
      connections.id,
      connections.personal_account_id,
      connections.connection_setup_id,
      connections.webhook_ingress_id
  )
  SELECT
    claimed.health_claim_id,
    claimed.id,
    claimed.connection_setup_id,
    claimed.webhook_ingress_id
  FROM claimed
  ORDER BY claimed.id;
END
$function$;

CREATE FUNCTION app_private.finish_whatsapp_connection_health(
  requested_connection_id uuid,
  requested_claim_id uuid,
  observed_state text,
  gap_evidence text,
  webhook_configuration_healthy boolean,
  started_at timestamptz,
  checked_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  connection app.whatsapp_connections%ROWTYPE;
  gap_start timestamptz;
BEGIN
  IF observed_state NOT IN (
    'connected',
    'disconnected',
    'reconnect_required',
    'degraded'
  ) OR gap_evidence NOT IN (
    'healthy',
    'connection_unavailable',
    'webhook_configuration',
    'unknown'
  ) OR (gap_evidence = 'healthy' AND observed_state <> 'connected')
    OR (gap_evidence = 'healthy' AND NOT webhook_configuration_healthy)
    OR (
      gap_evidence IN ('webhook_configuration', 'unknown')
      AND webhook_configuration_healthy
    )
    OR started_at > checked_at
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid connection health observation';
  END IF;

  SELECT connections.*
  INTO connection
  FROM app.whatsapp_connections AS connections
  JOIN app.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE connections.id = requested_connection_id
    AND connections.health_claim_id = requested_claim_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF started_at <= connection.state_received_at
    OR (
      connection.health_last_checked_at IS NOT NULL
      AND checked_at < connection.health_last_checked_at
    )
  THEN
    UPDATE app.whatsapp_connections AS connections
    SET
      health_last_checked_at = CASE
        WHEN connections.health_last_checked_at IS NULL
          THEN checked_at
        ELSE greatest(connections.health_last_checked_at, checked_at)
      END,
      health_claim_id = NULL,
      health_lease_expires_at = NULL,
      updated_at = greatest(connections.updated_at, checked_at)
    WHERE connections.id = connection.id;
    RETURN false;
  END IF;

  gap_start := greatest(
    connection.created_at,
    coalesce(connection.health_last_confirmed_at, connection.created_at)
  );

  UPDATE app.whatsapp_connections AS connections
  SET
    health_last_checked_at = checked_at,
    health_last_confirmed_at = CASE
      WHEN gap_evidence = 'healthy' THEN checked_at
      ELSE connections.health_last_confirmed_at
    END,
    health_claim_id = NULL,
    health_lease_expires_at = NULL,
    state = observed_state,
    state_changed_at = CASE
      WHEN connections.state = observed_state
        THEN connections.state_changed_at
      ELSE checked_at
    END,
    state_provider_occurred_at = NULL,
    state_provider_version = NULL,
    state_received_at = checked_at,
    state_webhook_event_id = NULL,
    state_webhook_item_identity = NULL,
    updated_at = greatest(connections.updated_at, checked_at)
  WHERE connections.id = connection.id;

  IF webhook_configuration_healthy THEN
    UPDATE app.ingestion_gaps AS gaps
    SET
      ends_at = greatest(gaps.starts_at, checked_at),
      updated_at = greatest(gaps.updated_at, checked_at)
    WHERE gaps.personal_account_id = connection.personal_account_id
      AND gaps.whatsapp_connection_id = connection.id
      AND gaps.cause = 'webhook_configuration'
      AND gaps.ends_at IS NULL;
  END IF;

  IF gap_evidence = 'healthy' THEN
    UPDATE app.ingestion_gaps AS gaps
    SET
      ends_at = greatest(gaps.starts_at, checked_at),
      updated_at = greatest(gaps.updated_at, checked_at)
    WHERE gaps.personal_account_id = connection.personal_account_id
      AND gaps.whatsapp_connection_id = connection.id
      AND gaps.cause = 'connection_unavailable'
      AND gaps.ends_at IS NULL;
  ELSIF gap_evidence IN (
    'connection_unavailable',
    'webhook_configuration'
  ) THEN
    INSERT INTO app.ingestion_gaps (
      personal_account_id,
      whatsapp_connection_id,
      cause,
      history_window_started_at,
      starts_at,
      detected_at,
      updated_at
    )
    SELECT
      connection.personal_account_id,
      connection.id,
      gap_evidence,
      connection.created_at,
      gap_start,
      checked_at,
      checked_at
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.ingestion_gaps AS gaps
      WHERE gaps.personal_account_id = connection.personal_account_id
        AND gaps.whatsapp_connection_id = connection.id
        AND gaps.cause = gap_evidence
        AND gaps.ends_at IS NULL
    );
  END IF;

  RETURN true;
END
$function$;

CREATE FUNCTION app_private.record_ingestion_gap_evidence(
  requested_connection_id uuid,
  requested_cause text,
  evidence_active boolean,
  observed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  connection app.whatsapp_connections%ROWTYPE;
  gap_start timestamptz;
BEGIN
  IF requested_cause NOT IN (
    'ingress_failure',
    'processing_failure',
    'restore_loss'
  ) THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid ingestion gap evidence cause';
  END IF;

  SELECT connections.*
  INTO connection
  FROM app.whatsapp_connections AS connections
  JOIN app.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE connections.id = requested_connection_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  gap_start := greatest(
    connection.created_at,
    coalesce(connection.health_last_confirmed_at, connection.created_at)
  );

  IF observed_at < gap_start THEN
    RETURN false;
  END IF;

  IF evidence_active THEN
    INSERT INTO app.ingestion_gaps (
      personal_account_id,
      whatsapp_connection_id,
      cause,
      history_window_started_at,
      starts_at,
      detected_at,
      updated_at
    )
    SELECT
      connection.personal_account_id,
      connection.id,
      requested_cause,
      connection.created_at,
      gap_start,
      observed_at,
      observed_at
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.ingestion_gaps AS gaps
      WHERE gaps.personal_account_id = connection.personal_account_id
        AND gaps.whatsapp_connection_id = connection.id
        AND gaps.cause = requested_cause
        AND gaps.ends_at IS NULL
    );
  ELSE
    UPDATE app.ingestion_gaps AS gaps
    SET
      ends_at = greatest(gaps.starts_at, observed_at),
      updated_at = greatest(gaps.updated_at, observed_at)
    WHERE gaps.personal_account_id = connection.personal_account_id
      AND gaps.whatsapp_connection_id = connection.id
      AND gaps.cause = requested_cause
      AND gaps.ends_at IS NULL
      AND observed_at >= gaps.starts_at;
  END IF;

  RETURN true;
END
$function$;

REVOKE ALL
  ON FUNCTION app_private.claim_whatsapp_connection_health(
    timestamptz,
    integer
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.finish_whatsapp_connection_health(
    uuid,
    uuid,
    text,
    text,
    boolean,
    timestamptz,
    timestamptz
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.record_ingestion_gap_evidence(
    uuid,
    text,
    boolean,
    timestamptz
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.claim_whatsapp_connection_health(
    timestamptz,
    integer
  )
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.finish_whatsapp_connection_health(
    uuid,
    uuid,
    text,
    text,
    boolean,
    timestamptz,
    timestamptz
  )
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.record_ingestion_gap_evidence(
    uuid,
    text,
    boolean,
    timestamptz
  )
  TO whatsapp_api_runtime;
