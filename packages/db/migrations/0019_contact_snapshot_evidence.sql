ALTER TABLE app.directory_contacts
ADD COLUMN snapshot_observed_at timestamptz;

UPDATE app.directory_contacts AS contacts
SET snapshot_observed_at = CASE
  WHEN projections.partial THEN contacts.received_at
  ELSE projections.snapshot_observed_at
END
FROM app.directory_contact_projections AS projections
WHERE projections.personal_account_id = contacts.personal_account_id
  AND projections.whatsapp_connection_id = contacts.whatsapp_connection_id
  AND projections.snapshot_observed_at IS NOT NULL
  AND (
    NOT projections.partial
    OR (
      contacts.provider_occurred_at IS NULL
      AND contacts.provider_version IS NULL
      AND contacts.webhook_event_id IS NULL
      AND contacts.webhook_item_identity IS NULL
    )
  );

CREATE OR REPLACE FUNCTION app_private.finish_contact_reconciliation(
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
      snapshot_observed_at,
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
      snapshot_observed_at = excluded.snapshot_observed_at,
      received_at = excluded.received_at,
      webhook_event_id = NULL,
      webhook_item_identity = NULL,
      updated_at = excluded.updated_at
    WHERE app.directory_contacts.received_at <= observed_at;
  END LOOP;

  UPDATE app.directory_contacts AS contacts
  SET
    snapshot_observed_at = observed_at,
    updated_at = greatest(contacts.updated_at, observed_at)
  WHERE contacts.personal_account_id = projection.personal_account_id
    AND contacts.whatsapp_connection_id = projection.whatsapp_connection_id
    AND (
      contacts.snapshot_observed_at IS NULL
      OR contacts.snapshot_observed_at < observed_at
    )
    AND (
      NOT observation_partial
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(protected_contacts) AS candidate
        WHERE candidate->>'provider_identity_index' =
          contacts.provider_identity_index::text
      )
    );

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
      snapshot_observed_at = observed_at,
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
