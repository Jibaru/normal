ALTER TABLE app.whatsapp_connections
  ADD COLUMN state_provider_occurred_at timestamptz,
  ADD COLUMN state_provider_version text
    CHECK (
      state_provider_version IS NULL
      OR octet_length(state_provider_version) <= 512
    ),
  ADD COLUMN state_received_at timestamptz NOT NULL
    DEFAULT transaction_timestamp(),
  ADD COLUMN state_webhook_event_id uuid,
  ADD COLUMN state_webhook_item_identity text,
  ADD CONSTRAINT whatsapp_connection_state_item_identity_format
    CHECK (
      state_webhook_item_identity IS NULL
      OR state_webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'
    );

UPDATE app.whatsapp_connections
SET
  state_received_at = state_changed_at;

CREATE FUNCTION app_private.initialize_whatsapp_connection_state_receive_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.state_received_at := NEW.state_changed_at;
  RETURN NEW;
END
$function$;

CREATE TRIGGER initialize_whatsapp_connection_state_receive_order
BEFORE INSERT ON app.whatsapp_connections
FOR EACH ROW
EXECUTE FUNCTION app_private.initialize_whatsapp_connection_state_receive_order();

CREATE TABLE app.webhook_events (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  id uuid NOT NULL,
  ciphertext_sha256 text NOT NULL
    CHECK (ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  payload_bytes integer NOT NULL
    CHECK (payload_bytes BETWEEN 1 AND 1048576),
  received_at timestamptz NOT NULL,
  source_expires_at timestamptz NOT NULL,
  processing_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id, id),
  UNIQUE (id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (source_expires_at = received_at + interval '7 days'),
  CHECK (
    processing_completed_at IS NULL
    OR processing_completed_at >= received_at
  )
);

CREATE TABLE app.webhook_items (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  deduplication_identity text NOT NULL
    CHECK (deduplication_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'),
  first_webhook_event_id uuid NOT NULL,
  item_index integer NOT NULL CHECK (item_index >= 0),
  item_kind text NOT NULL CHECK (item_kind ~ '^[a-z][a-z_]{0,63}$'),
  outcome text NOT NULL
    CHECK (outcome IN ('applied', 'quarantined', 'superseded')),
  provider_occurred_at timestamptz,
  provider_version text,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (
    personal_account_id,
    whatsapp_connection_id,
    deduplication_identity
  ),
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
    ON DELETE CASCADE,
  CHECK (provider_version IS NULL OR octet_length(provider_version) <= 512)
);

CREATE TABLE app.webhook_item_quarantines (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  webhook_event_id uuid NOT NULL,
  item_index integer NOT NULL CHECK (item_index >= -1),
  item_identity text,
  item_kind text NOT NULL CHECK (item_kind ~ '^[a-z][a-z_]{0,63}$'),
  classification text NOT NULL
    CHECK (
      classification IN (
        'invalid_item_shape',
        'invalid_top_level_shape',
        'missing_required_identity',
        'unsupported_item_kind',
        'unsupported_projection'
      )
    ),
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (
    personal_account_id,
    whatsapp_connection_id,
    webhook_event_id,
    item_index
  ),
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
    ON DELETE CASCADE,
  CHECK (
    item_identity IS NULL
    OR item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'
  )
);

ALTER TABLE app.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_events FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_items FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_item_quarantines ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_item_quarantines FORCE ROW LEVEL SECURITY;

CREATE POLICY webhook_events_tenant
ON app.webhook_events
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

CREATE POLICY webhook_items_tenant
ON app.webhook_items
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

CREATE POLICY webhook_item_quarantines_tenant
ON app.webhook_item_quarantines
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

GRANT SELECT, INSERT, UPDATE
  ON app.webhook_events
  TO whatsapp_webhook_runtime;
GRANT SELECT, INSERT, UPDATE
  ON app.webhook_items
  TO whatsapp_webhook_runtime;
GRANT SELECT, INSERT
  ON app.webhook_item_quarantines
  TO whatsapp_webhook_runtime;

CREATE FUNCTION app_private.load_webhook_event_processing_material(
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
  identity_ciphertext bytea
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    account_keys.key_version,
    account_keys.kms_key_id,
    account_keys.ciphertext,
    connection_keys.account_key_version,
    connection_keys.key_version,
    connection_keys.nonce,
    connection_keys.ciphertext,
    identity_keys.credential_ciphertext_version,
    identity_keys.credential_key_version,
    identity_keys.credential_nonce,
    identity_keys.credential_ciphertext
  FROM app.whatsapp_connections AS connections
  JOIN app.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  JOIN app.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  JOIN app.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  JOIN app.whatsapp_connection_secrets AS identity_keys
    ON identity_keys.personal_account_id = connections.personal_account_id
   AND identity_keys.whatsapp_connection_id = connections.id
   AND identity_keys.credential_key_version = connection_keys.key_version
  WHERE connections.personal_account_id = requested_personal_account_id
    AND connections.id = requested_whatsapp_connection_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL
$function$;

REVOKE ALL
  ON FUNCTION app_private.load_webhook_event_processing_material(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION app_private.load_webhook_event_processing_material(uuid, uuid)
  TO whatsapp_webhook_runtime;

CREATE OR REPLACE FUNCTION app_private.claim_whatsapp_connection_lifecycle(
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
      ELSE greatest(connections.state_changed_at, requested_at)
    END,
    state_provider_occurred_at = NULL,
    state_provider_version = NULL,
    state_received_at = greatest(connections.state_received_at, requested_at),
    state_webhook_event_id = NULL,
    state_webhook_item_identity = NULL,
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

CREATE OR REPLACE FUNCTION app_private.finish_whatsapp_connection_lifecycle(
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
    state_provider_occurred_at = NULL,
    state_provider_version = NULL,
    state_received_at = greatest(connections.state_received_at, observed_at),
    state_webhook_event_id = NULL,
    state_webhook_item_identity = NULL,
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
