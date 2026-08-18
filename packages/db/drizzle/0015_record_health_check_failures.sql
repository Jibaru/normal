ALTER TABLE public.ingestion_gaps
DROP CONSTRAINT ingestion_gaps_cause_check;
--> statement-breakpoint

ALTER TABLE public.ingestion_gaps
ADD CONSTRAINT ingestion_gaps_cause_check
CHECK (
  cause = ANY (
    ARRAY[
      'connection_unavailable'::text,
      'webhook_configuration'::text,
      'health_check_failure'::text,
      'ingress_failure'::text,
      'processing_failure'::text,
      'restore_loss'::text
    ]
  )
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.finish_whatsapp_connection_health(
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
  connection public.whatsapp_connections%ROWTYPE;
  gap_start timestamptz;
  previous_check_at timestamptz;
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
  FROM public.whatsapp_connections AS connections
  JOIN public.personal_accounts AS accounts
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
    UPDATE public.whatsapp_connections AS connections
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
  previous_check_at := greatest(
    connection.created_at,
    coalesce(connection.health_last_checked_at, connection.created_at)
  );

  IF started_at > previous_check_at + interval '10 minutes' THEN
    INSERT INTO public.ingestion_gaps (
      personal_account_id,
      whatsapp_connection_id,
      cause,
      history_window_started_at,
      starts_at,
      ends_at,
      detected_at,
      updated_at
    ) VALUES (
      connection.personal_account_id,
      connection.id,
      'health_check_failure',
      connection.created_at,
      previous_check_at,
      checked_at,
      checked_at,
      checked_at
    );
  END IF;

  UPDATE public.whatsapp_connections AS connections
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
    UPDATE public.ingestion_gaps AS gaps
    SET
      ends_at = greatest(gaps.starts_at, checked_at),
      updated_at = greatest(gaps.updated_at, checked_at)
    WHERE gaps.personal_account_id = connection.personal_account_id
      AND gaps.whatsapp_connection_id = connection.id
      AND gaps.cause = 'webhook_configuration'
      AND gaps.ends_at IS NULL;
  END IF;

  IF gap_evidence = 'healthy' THEN
    UPDATE public.ingestion_gaps AS gaps
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
    INSERT INTO public.ingestion_gaps (
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
      FROM public.ingestion_gaps AS gaps
      WHERE gaps.personal_account_id = connection.personal_account_id
        AND gaps.whatsapp_connection_id = connection.id
        AND gaps.cause = gap_evidence
        AND gaps.ends_at IS NULL
    );
  END IF;

  RETURN true;
END
$function$;
