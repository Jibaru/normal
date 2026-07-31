ALTER TABLE app.whatsapp_connections
  ADD COLUMN desired_state text NOT NULL DEFAULT 'connected'
    CHECK (desired_state IN ('connected', 'disconnected')),
  ADD COLUMN lifecycle_claim_id uuid,
  ADD COLUMN lifecycle_lease_expires_at timestamptz,
  ADD CONSTRAINT whatsapp_connection_lifecycle_lease_complete
    CHECK (
      (lifecycle_claim_id IS NULL AND lifecycle_lease_expires_at IS NULL)
      OR
      (lifecycle_claim_id IS NOT NULL AND lifecycle_lease_expires_at IS NOT NULL)
    );

CREATE FUNCTION app_private.claim_whatsapp_connection_lifecycle(
  verified_clerk_user_id text,
  requested_public_id text,
  requested_action text,
  requested_claim_id uuid,
  requested_at timestamptz
)
RETURNS TABLE (
  outcome text,
  lifecycle_action text,
  setup_marker text,
  connection_public_id text,
  connection_display_name text,
  connection_number_suffix text,
  connection_state text,
  connection_state_changed_at timestamptz
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  connection app.whatsapp_connections%ROWTYPE;
  next_state text;
  target_state text;
BEGIN
  IF requested_public_id !~ '^con_[A-Za-z0-9_-]{21}$'
    OR requested_action NOT IN ('disconnect', 'reconnect')
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid WhatsApp Connection lifecycle request';
  END IF;

  SELECT connections.*
  INTO connection
  FROM app.whatsapp_connections AS connections
  JOIN app_private.clerk_identities AS identities
    ON identities.personal_account_id = connections.personal_account_id
  JOIN app.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND connections.public_id = requested_public_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF connection.lifecycle_claim_id IS NOT NULL
    AND connection.lifecycle_lease_expires_at > requested_at
  THEN
    RETURN QUERY SELECT
      'in_progress'::text,
      NULL::text,
      NULL::text,
      connection.public_id,
      NULL::text,
      connection.number_suffix,
      connection.state,
      connection.state_changed_at;
    RETURN;
  END IF;

  target_state := CASE requested_action
    WHEN 'disconnect' THEN 'disconnected'
    ELSE 'connected'
  END;

  IF connection.state = target_state THEN
    UPDATE app.whatsapp_connections AS connections
    SET
      desired_state = target_state,
      lifecycle_claim_id = NULL,
      lifecycle_lease_expires_at = NULL,
      updated_at = greatest(connections.updated_at, requested_at)
    WHERE connections.id = connection.id;

    RETURN QUERY SELECT
      'complete'::text,
      NULL::text,
      NULL::text,
      connection.public_id,
      NULL::text,
      connection.number_suffix,
      connection.state,
      connection.state_changed_at;
    RETURN;
  END IF;

  next_state := CASE requested_action
    WHEN 'disconnect' THEN 'degraded'
    ELSE 'connecting'
  END;

  UPDATE app.whatsapp_connections AS connections
  SET
    desired_state = target_state,
    lifecycle_claim_id = requested_claim_id,
    lifecycle_lease_expires_at = requested_at + interval '2 minutes',
    state = next_state,
    state_changed_at = CASE
      WHEN connections.state = next_state
        THEN connections.state_changed_at
      ELSE requested_at
    END,
    updated_at = greatest(connections.updated_at, requested_at)
  WHERE connections.id = connection.id
  RETURNING connections.* INTO connection;

  RETURN QUERY SELECT
    'claimed'::text,
    requested_action,
    connection.connection_setup_id,
    connection.public_id,
    NULL::text,
    connection.number_suffix,
    connection.state,
    connection.state_changed_at;
END
$function$;

CREATE FUNCTION app_private.finish_whatsapp_connection_lifecycle(
  verified_clerk_user_id text,
  requested_public_id text,
  requested_claim_id uuid,
  observed_state text,
  observed_at timestamptz
)
RETURNS TABLE (
  public_id text,
  display_name text,
  number_suffix text,
  state text,
  state_changed_at timestamptz
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  connection app.whatsapp_connections%ROWTYPE;
BEGIN
  IF requested_public_id !~ '^con_[A-Za-z0-9_-]{21}$'
    OR observed_state NOT IN (
      'connected',
      'connecting',
      'disconnected',
      'reconnect_required',
      'degraded'
    )
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid WhatsApp Connection lifecycle observation';
  END IF;

  SELECT connections.*
  INTO connection
  FROM app.whatsapp_connections AS connections
  JOIN app_private.clerk_identities AS identities
    ON identities.personal_account_id = connections.personal_account_id
  JOIN app.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND connections.public_id = requested_public_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
  FOR UPDATE OF connections;

  IF NOT FOUND
    OR connection.lifecycle_claim_id IS DISTINCT FROM requested_claim_id
    OR observed_at < connection.state_changed_at
  THEN
    RETURN;
  END IF;

  UPDATE app.whatsapp_connections AS connections
  SET
    lifecycle_claim_id = NULL,
    lifecycle_lease_expires_at = NULL,
    state = observed_state,
    state_changed_at = CASE
      WHEN connections.state = observed_state
        THEN connections.state_changed_at
      ELSE observed_at
    END,
    updated_at = greatest(connections.updated_at, observed_at)
  WHERE connections.id = connection.id
  RETURNING connections.* INTO connection;

  RETURN QUERY SELECT
    connection.public_id,
    NULL::text,
    connection.number_suffix,
    connection.state,
    connection.state_changed_at;
END
$function$;

REVOKE ALL
  ON FUNCTION app_private.claim_whatsapp_connection_lifecycle(
    text,
    text,
    text,
    uuid,
    timestamptz
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.finish_whatsapp_connection_lifecycle(
    text,
    text,
    uuid,
    text,
    timestamptz
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.claim_whatsapp_connection_lifecycle(
    text,
    text,
    text,
    uuid,
    timestamptz
  )
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.finish_whatsapp_connection_lifecycle(
    text,
    text,
    uuid,
    text,
    timestamptz
  )
  TO whatsapp_api_runtime;
