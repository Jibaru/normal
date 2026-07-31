CREATE DOMAIN app.directory_blind_index AS text
CHECK (VALUE ~ '^di1_[A-Za-z0-9_-]{43}$');

CREATE TABLE app.directory_contact_projections (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  as_of timestamptz NOT NULL,
  stale boolean NOT NULL,
  partial boolean NOT NULL,
  snapshot_observed_at timestamptz,
  reconciliation_attempted_at timestamptz,
  reconciliation_claim_id uuid,
  reconciliation_lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  CHECK (
    (reconciliation_claim_id IS NULL AND reconciliation_lease_expires_at IS NULL)
    OR
    (reconciliation_claim_id IS NOT NULL AND reconciliation_lease_expires_at IS NOT NULL)
  )
);

CREATE TABLE app.directory_contacts (
  personal_account_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  public_id text NOT NULL
    CHECK (public_id ~ '^ctc_[A-Za-z0-9_-]{21}$'),
  provider_identity_index app.directory_blind_index NOT NULL,
  provider_identity_ciphertext_version smallint NOT NULL
    CHECK (provider_identity_ciphertext_version = 1),
  provider_identity_key_version integer NOT NULL
    CHECK (provider_identity_key_version > 0),
  provider_identity_nonce bytea NOT NULL
    CHECK (octet_length(provider_identity_nonce) = 12),
  provider_identity_ciphertext bytea NOT NULL
    CHECK (octet_length(provider_identity_ciphertext) > 16),
  display_name_ciphertext_version smallint,
  display_name_key_version integer,
  display_name_nonce bytea,
  display_name_ciphertext bytea,
  display_name_sort text COLLATE "C" NOT NULL
    CHECK (octet_length(display_name_sort) <= 1024),
  phone_ciphertext_version smallint,
  phone_key_version integer,
  phone_nonce bytea,
  phone_ciphertext bytea,
  name_prefix_indexes app.directory_blind_index[] NOT NULL
    DEFAULT ARRAY[]::app.directory_blind_index[],
  phone_index app.directory_blind_index,
  active boolean NOT NULL,
  provider_occurred_at timestamptz,
  provider_version text,
  received_at timestamptz NOT NULL,
  webhook_event_id uuid,
  webhook_item_identity text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (personal_account_id, whatsapp_connection_id, id),
  UNIQUE (id),
  UNIQUE (public_id),
  UNIQUE (
    personal_account_id,
    whatsapp_connection_id,
    provider_identity_index
  ),
  FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES app.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (
    personal_account_id,
    whatsapp_connection_id,
    webhook_event_id
  ) REFERENCES app.webhook_events (
    personal_account_id,
    whatsapp_connection_id,
    id
  ) ON DELETE SET NULL (webhook_event_id),
  CHECK (
    (display_name_ciphertext IS NULL
      AND display_name_ciphertext_version IS NULL
      AND display_name_key_version IS NULL
      AND display_name_nonce IS NULL)
    OR
    (display_name_ciphertext IS NOT NULL
      AND display_name_ciphertext_version = 1
      AND display_name_key_version > 0
      AND octet_length(display_name_nonce) = 12
      AND octet_length(display_name_ciphertext) > 16)
  ),
  CHECK (
    (phone_ciphertext IS NULL
      AND phone_ciphertext_version IS NULL
      AND phone_key_version IS NULL
      AND phone_nonce IS NULL)
    OR
    (phone_ciphertext IS NOT NULL
      AND phone_ciphertext_version = 1
      AND phone_key_version > 0
      AND octet_length(phone_nonce) = 12
      AND octet_length(phone_ciphertext) > 16)
  ),
  CHECK (array_position(name_prefix_indexes, NULL) IS NULL),
  CHECK (
    active
    OR (
      display_name_ciphertext IS NULL
      AND display_name_sort = ''
      AND phone_ciphertext IS NULL
      AND cardinality(name_prefix_indexes) = 0
      AND phone_index IS NULL
    )
  ),
  CHECK (provider_version IS NULL OR octet_length(provider_version) <= 512),
  CHECK (
    webhook_item_identity IS NULL
    OR webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'
  )
);

CREATE INDEX directory_contacts_active_order
ON app.directory_contacts (
  personal_account_id,
  whatsapp_connection_id,
  display_name_sort,
  public_id
)
WHERE active;

CREATE INDEX directory_contacts_name_prefixes
ON app.directory_contacts USING gin (name_prefix_indexes)
WHERE active;

CREATE INDEX directory_contacts_phone
ON app.directory_contacts (
  personal_account_id,
  whatsapp_connection_id,
  phone_index
)
WHERE active AND phone_index IS NOT NULL;

ALTER TABLE app.directory_contact_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.directory_contact_projections FORCE ROW LEVEL SECURITY;
ALTER TABLE app.directory_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.directory_contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY directory_contact_projections_tenant
ON app.directory_contact_projections
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

CREATE POLICY directory_contacts_tenant
ON app.directory_contacts
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

GRANT SELECT ON app.directory_contact_projections, app.directory_contacts
TO whatsapp_api_runtime;

GRANT SELECT, INSERT, UPDATE
ON app.directory_contact_projections, app.directory_contacts
TO whatsapp_webhook_runtime;

CREATE FUNCTION app_private.load_mcp_contact_read_material(
  candidate_authorization_id uuid,
  candidate_oauth_subject text,
  candidate_client_id text,
  candidate_connection_public_id text,
  observed_at timestamptz
)
RETURNS TABLE (
  personal_account_id uuid,
  whatsapp_connection_id uuid,
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
  identity_ciphertext bytea,
  projection_as_of timestamptz,
  projection_stale boolean,
  projection_partial boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    authorizations.personal_account_id,
    connections.id,
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
    identity_keys.credential_ciphertext,
    coalesce(projections.as_of, connections.created_at),
    coalesce(projections.stale, true),
    coalesce(projections.partial, true)
  FROM app.mcp_authorizations AS authorizations
  JOIN app.personal_accounts AS accounts
    ON accounts.id = authorizations.personal_account_id
  JOIN app.mcp_authorization_connections AS selected
    ON selected.personal_account_id = authorizations.personal_account_id
   AND selected.mcp_authorization_id = authorizations.id
  JOIN app.whatsapp_connections AS connections
    ON connections.personal_account_id = selected.personal_account_id
   AND connections.id = selected.whatsapp_connection_id
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
  LEFT JOIN app.directory_contact_projections AS projections
    ON projections.personal_account_id = connections.personal_account_id
   AND projections.whatsapp_connection_id = connections.id
  WHERE authorizations.id = candidate_authorization_id
    AND authorizations.oauth_subject = candidate_oauth_subject
    AND (
      candidate_client_id IS NULL
      OR authorizations.client_id = candidate_client_id
    )
    AND authorizations.state = 'active'
    AND authorizations.refresh_family_state = 'active'
    AND authorizations.absolute_expires_at > observed_at
    AND 'directory:read' = ANY(authorizations.scopes)
    AND connections.public_id = candidate_connection_public_id
    AND connections.state <> 'deleting'
    AND accounts.state = 'active'
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM app_private.clerk_identities AS identities
      WHERE identities.personal_account_id = authorizations.personal_account_id
    )
$function$;

REVOKE ALL
ON FUNCTION app_private.load_mcp_contact_read_material(
  uuid, text, text, text, timestamptz
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app_private.load_mcp_contact_read_material(
  uuid, text, text, text, timestamptz
)
TO whatsapp_api_runtime;

CREATE FUNCTION app_private.claim_contact_reconciliations(
  claimed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  reconciliation_claim_id uuid,
  personal_account_id uuid,
  whatsapp_connection_id uuid,
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea,
  authority_ciphertext_version smallint,
  authority_key_version integer,
  authority_nonce bytea,
  authority_ciphertext bytea,
  identity_ciphertext_version smallint,
  identity_key_version integer,
  identity_nonce bytea,
  identity_ciphertext bytea
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 100 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid contact reconciliation claim limit';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT connections.personal_account_id, connections.id
    FROM app.whatsapp_connections AS connections
    JOIN app.personal_accounts AS accounts
      ON accounts.id = connections.personal_account_id
    JOIN app.whatsapp_connection_key_envelopes AS connection_keys
      ON connection_keys.personal_account_id = connections.personal_account_id
     AND connection_keys.whatsapp_connection_id = connections.id
     AND connection_keys.unavailable_at IS NULL
     AND connection_keys.nonce IS NOT NULL
     AND connection_keys.ciphertext IS NOT NULL
    JOIN app.personal_account_key_envelopes AS account_keys
      ON account_keys.personal_account_id = connections.personal_account_id
     AND account_keys.key_version = connection_keys.account_key_version
     AND account_keys.unavailable_at IS NULL
     AND account_keys.ciphertext IS NOT NULL
    JOIN app.whatsapp_connection_provider_sessions AS provider_sessions
      ON provider_sessions.personal_account_id = connections.personal_account_id
     AND provider_sessions.whatsapp_connection_id = connections.id
     AND provider_sessions.authority_key_version = connection_keys.key_version
    JOIN app.whatsapp_connection_secrets AS identity_keys
      ON identity_keys.personal_account_id = connections.personal_account_id
     AND identity_keys.whatsapp_connection_id = connections.id
     AND identity_keys.credential_key_version = connection_keys.key_version
    LEFT JOIN app.directory_contact_projections AS projections
      ON projections.personal_account_id = connections.personal_account_id
     AND projections.whatsapp_connection_id = connections.id
    WHERE accounts.state = 'active'
      AND connections.state = 'connected'
      AND (
        projections.reconciliation_claim_id IS NULL
        OR projections.reconciliation_lease_expires_at <= claimed_at
      )
      AND (
        projections.reconciliation_attempted_at IS NULL
        OR projections.reconciliation_attempted_at
          < claimed_at - interval '5 minutes'
      )
    ORDER BY
      projections.reconciliation_attempted_at NULLS FIRST,
      connections.created_at,
      connections.id
    LIMIT requested_limit
    FOR UPDATE OF connections SKIP LOCKED
  ), claimed AS (
    INSERT INTO app.directory_contact_projections (
      personal_account_id,
      whatsapp_connection_id,
      as_of,
      stale,
      partial,
      reconciliation_attempted_at,
      reconciliation_claim_id,
      reconciliation_lease_expires_at,
      updated_at
    )
    SELECT
      candidates.personal_account_id,
      candidates.id,
      connections.created_at,
      true,
      true,
      claimed_at,
      gen_random_uuid(),
      claimed_at + interval '4 minutes',
      claimed_at
    FROM candidates
    JOIN app.whatsapp_connections AS connections
      ON connections.personal_account_id = candidates.personal_account_id
     AND connections.id = candidates.id
    ON CONFLICT ON CONSTRAINT directory_contact_projections_pkey
    DO UPDATE SET
      reconciliation_attempted_at = excluded.reconciliation_attempted_at,
      reconciliation_claim_id = excluded.reconciliation_claim_id,
      reconciliation_lease_expires_at = excluded.reconciliation_lease_expires_at,
      updated_at = greatest(
        app.directory_contact_projections.updated_at,
        excluded.updated_at
      )
    RETURNING
      app.directory_contact_projections.personal_account_id,
      app.directory_contact_projections.whatsapp_connection_id,
      app.directory_contact_projections.reconciliation_claim_id
  )
  SELECT
    claimed.reconciliation_claim_id,
    claimed.personal_account_id,
    claimed.whatsapp_connection_id,
    account_keys.key_version,
    account_keys.kms_key_id,
    account_keys.ciphertext,
    connection_keys.account_key_version,
    connection_keys.key_version,
    connection_keys.nonce,
    connection_keys.ciphertext,
    provider_sessions.authority_ciphertext_version,
    provider_sessions.authority_key_version,
    provider_sessions.authority_nonce,
    provider_sessions.authority_ciphertext,
    identity_keys.credential_ciphertext_version,
    identity_keys.credential_key_version,
    identity_keys.credential_nonce,
    identity_keys.credential_ciphertext
  FROM claimed
  JOIN app.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = claimed.personal_account_id
   AND connection_keys.whatsapp_connection_id = claimed.whatsapp_connection_id
  JOIN app.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = claimed.personal_account_id
   AND account_keys.key_version = connection_keys.account_key_version
  JOIN app.whatsapp_connection_provider_sessions AS provider_sessions
    ON provider_sessions.personal_account_id = claimed.personal_account_id
   AND provider_sessions.whatsapp_connection_id = claimed.whatsapp_connection_id
   AND provider_sessions.authority_key_version = connection_keys.key_version
  JOIN app.whatsapp_connection_secrets AS identity_keys
    ON identity_keys.personal_account_id = claimed.personal_account_id
   AND identity_keys.whatsapp_connection_id = claimed.whatsapp_connection_id
   AND identity_keys.credential_key_version = connection_keys.key_version
  WHERE account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL;
END
$function$;

CREATE FUNCTION app_private.finish_contact_reconciliation(
  requested_connection_id uuid,
  requested_claim_id uuid,
  observed_at timestamptz,
  observation_stale boolean,
  observation_partial boolean,
  protected_contacts jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  projection app.directory_contact_projections%ROWTYPE;
  contact jsonb;
BEGIN
  SELECT projections.*
  INTO projection
  FROM app.directory_contact_projections AS projections
  JOIN app.whatsapp_connections AS connections
    ON connections.personal_account_id = projections.personal_account_id
   AND connections.id = projections.whatsapp_connection_id
  JOIN app.personal_accounts AS accounts
    ON accounts.id = projections.personal_account_id
  WHERE projections.whatsapp_connection_id = requested_connection_id
    AND projections.reconciliation_claim_id = requested_claim_id
    AND projections.reconciliation_lease_expires_at > observed_at
    AND connections.state = 'connected'
    AND accounts.state = 'active'
  FOR UPDATE OF projections;

  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(protected_contacts) <> 'array' THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid protected contact snapshot';
  END IF;
  IF projection.snapshot_observed_at IS NOT NULL
    AND observed_at < projection.snapshot_observed_at
  THEN
    UPDATE app.directory_contact_projections
    SET
      reconciliation_claim_id = NULL,
      reconciliation_lease_expires_at = NULL,
      updated_at = greatest(updated_at, transaction_timestamp())
    WHERE personal_account_id = projection.personal_account_id
      AND whatsapp_connection_id = projection.whatsapp_connection_id;
    RETURN true;
  END IF;

  FOR contact IN SELECT value FROM jsonb_array_elements(protected_contacts)
  LOOP
    INSERT INTO app.directory_contacts (
      personal_account_id,
      whatsapp_connection_id,
      public_id,
      provider_identity_index,
      provider_identity_ciphertext_version,
      provider_identity_key_version,
      provider_identity_nonce,
      provider_identity_ciphertext,
      display_name_ciphertext_version,
      display_name_key_version,
      display_name_nonce,
      display_name_ciphertext,
      display_name_sort,
      phone_ciphertext_version,
      phone_key_version,
      phone_nonce,
      phone_ciphertext,
      name_prefix_indexes,
      phone_index,
      active,
      received_at,
      updated_at
    ) VALUES (
      projection.personal_account_id,
      projection.whatsapp_connection_id,
      contact->>'public_id',
      (contact->>'provider_identity_index')::app.directory_blind_index,
      (contact->>'provider_identity_ciphertext_version')::smallint,
      (contact->>'provider_identity_key_version')::integer,
      decode(contact->>'provider_identity_nonce', 'base64'),
      decode(contact->>'provider_identity_ciphertext', 'base64'),
      (contact->>'display_name_ciphertext_version')::smallint,
      (contact->>'display_name_key_version')::integer,
      CASE WHEN contact->>'display_name_nonce' IS NULL THEN NULL
        ELSE decode(contact->>'display_name_nonce', 'base64') END,
      CASE WHEN contact->>'display_name_ciphertext' IS NULL THEN NULL
        ELSE decode(contact->>'display_name_ciphertext', 'base64') END,
      contact->>'display_name_sort',
      (contact->>'phone_ciphertext_version')::smallint,
      (contact->>'phone_key_version')::integer,
      CASE WHEN contact->>'phone_nonce' IS NULL THEN NULL
        ELSE decode(contact->>'phone_nonce', 'base64') END,
      CASE WHEN contact->>'phone_ciphertext' IS NULL THEN NULL
        ELSE decode(contact->>'phone_ciphertext', 'base64') END,
      ARRAY(
        SELECT value::app.directory_blind_index
        FROM jsonb_array_elements_text(contact->'name_prefix_indexes') AS value
      ),
      (contact->>'phone_index')::app.directory_blind_index,
      true,
      observed_at,
      observed_at
    )
    ON CONFLICT (
      personal_account_id,
      whatsapp_connection_id,
      provider_identity_index
    ) DO UPDATE SET
      provider_identity_ciphertext_version =
        excluded.provider_identity_ciphertext_version,
      provider_identity_key_version = excluded.provider_identity_key_version,
      provider_identity_nonce = excluded.provider_identity_nonce,
      provider_identity_ciphertext = excluded.provider_identity_ciphertext,
      display_name_ciphertext_version = excluded.display_name_ciphertext_version,
      display_name_key_version = excluded.display_name_key_version,
      display_name_nonce = excluded.display_name_nonce,
      display_name_ciphertext = excluded.display_name_ciphertext,
      display_name_sort = excluded.display_name_sort,
      phone_ciphertext_version = excluded.phone_ciphertext_version,
      phone_key_version = excluded.phone_key_version,
      phone_nonce = excluded.phone_nonce,
      phone_ciphertext = excluded.phone_ciphertext,
      name_prefix_indexes = excluded.name_prefix_indexes,
      phone_index = excluded.phone_index,
      active = true,
      provider_occurred_at = NULL,
      provider_version = NULL,
      received_at = excluded.received_at,
      webhook_event_id = NULL,
      webhook_item_identity = NULL,
      updated_at = excluded.updated_at
    WHERE app.directory_contacts.received_at <= observed_at;
  END LOOP;

  IF NOT observation_partial THEN
    UPDATE app.directory_contacts AS contacts
    SET
      active = false,
      display_name_ciphertext_version = NULL,
      display_name_key_version = NULL,
      display_name_nonce = NULL,
      display_name_ciphertext = NULL,
      display_name_sort = '',
      phone_ciphertext_version = NULL,
      phone_key_version = NULL,
      phone_nonce = NULL,
      phone_ciphertext = NULL,
      name_prefix_indexes = ARRAY[]::app.directory_blind_index[],
      phone_index = NULL,
      provider_occurred_at = NULL,
      provider_version = NULL,
      received_at = observed_at,
      webhook_event_id = NULL,
      webhook_item_identity = NULL,
      updated_at = observed_at
    WHERE contacts.personal_account_id = projection.personal_account_id
      AND contacts.whatsapp_connection_id = projection.whatsapp_connection_id
      AND contacts.active
      AND contacts.received_at <= observed_at
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(protected_contacts) AS candidate
        WHERE candidate->>'provider_identity_index' =
          contacts.provider_identity_index::text
      );
  END IF;

  UPDATE app.directory_contact_projections
  SET
    as_of = greatest(as_of, observed_at),
    stale = observation_stale,
    partial = observation_partial,
    snapshot_observed_at = observed_at,
    reconciliation_claim_id = NULL,
    reconciliation_lease_expires_at = NULL,
    updated_at = greatest(updated_at, observed_at)
  WHERE personal_account_id = projection.personal_account_id
    AND whatsapp_connection_id = projection.whatsapp_connection_id;
  RETURN true;
END
$function$;

CREATE FUNCTION app_private.fail_contact_reconciliation(
  requested_connection_id uuid,
  requested_claim_id uuid,
  failed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  UPDATE app.directory_contact_projections AS projections
  SET
    stale = true,
    partial = true,
    reconciliation_claim_id = NULL,
    reconciliation_lease_expires_at = NULL,
    updated_at = greatest(projections.updated_at, failed_at)
  WHERE projections.whatsapp_connection_id = requested_connection_id
    AND projections.reconciliation_claim_id = requested_claim_id
  RETURNING true
$function$;

REVOKE ALL
ON FUNCTION app_private.claim_contact_reconciliations(timestamptz, integer),
  app_private.finish_contact_reconciliation(
    uuid, uuid, timestamptz, boolean, boolean, jsonb
  ),
  app_private.fail_contact_reconciliation(uuid, uuid, timestamptz)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app_private.claim_contact_reconciliations(timestamptz, integer),
  app_private.finish_contact_reconciliation(
    uuid, uuid, timestamptz, boolean, boolean, jsonb
  ),
  app_private.fail_contact_reconciliation(uuid, uuid, timestamptz)
TO whatsapp_api_runtime;
