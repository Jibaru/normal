ALTER TABLE app.personal_accounts
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_marker_id text CHECK (deletion_marker_id ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT personal_account_deletion_metadata_complete CHECK (
    (deletion_requested_at IS NULL AND deletion_marker_id IS NULL)
    OR (state = 'deleting' AND deletion_requested_at IS NOT NULL AND deletion_marker_id IS NULL)
    OR (state = 'deleting' AND deletion_requested_at IS NOT NULL AND deletion_marker_id IS NOT NULL)
  );

CREATE FUNCTION app_private.prepare_personal_account_deletion(
  verified_clerk_user_id text,
  observed_at timestamptz
)
RETURNS TABLE (
  personal_account_id uuid,
  account_state text,
  requested_at timestamptz,
  connection_public_id text
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE selected_account_id uuid;
BEGIN
  SELECT accounts.id INTO selected_account_id
  FROM app_private.clerk_identities identities
  JOIN app.personal_accounts accounts
    ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
  FOR UPDATE OF accounts;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE app.personal_accounts accounts
  SET state = 'deleting', deletion_requested_at = observed_at,
      updated_at = greatest(accounts.updated_at, observed_at)
  WHERE accounts.id = selected_account_id
    AND accounts.deletion_requested_at IS NULL;
  UPDATE app.connection_setups setups
  SET state = 'cancelled', cleanup_state = 'pending',
      cleanup_lease_owner = NULL, cleanup_lease_expires_at = NULL,
      provisioning_lease_owner = NULL, provisioning_lease_expires_at = NULL,
      updated_at = greatest(setups.updated_at, observed_at)
  WHERE setups.personal_account_id = selected_account_id
    AND setups.state NOT IN ('activated', 'cancelled', 'expired');
  DELETE FROM app.mcp_authorization_connections selected
  WHERE selected.personal_account_id = selected_account_id;
  DELETE FROM app.mcp_refresh_credentials credentials
  WHERE credentials.personal_account_id = selected_account_id;
  UPDATE app.mcp_authorizations authorizations
  SET state = 'revoked', revoked_at = coalesce(authorizations.revoked_at, observed_at),
      refresh_family_state = 'revoked',
      refresh_family_revoked_at = coalesce(authorizations.refresh_family_revoked_at, observed_at)
  WHERE authorizations.personal_account_id = selected_account_id
    AND (authorizations.state <> 'revoked' OR authorizations.refresh_family_state <> 'revoked');
  RETURN QUERY
  SELECT accounts.id, accounts.state, accounts.deletion_requested_at, connections.public_id
  FROM app.personal_accounts accounts
  LEFT JOIN app.whatsapp_connections connections
    ON connections.personal_account_id = accounts.id
   AND connections.state <> 'deleting'
  WHERE accounts.id = selected_account_id
  ORDER BY connections.public_id;
END
$function$;

CREATE FUNCTION app_private.finish_personal_account_deletion(
  verified_clerk_user_id text,
  requested_marker_id text,
  requested_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  selected_account app.personal_accounts%ROWTYPE;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$' THEN
    RAISE invalid_parameter_value;
  END IF;

  SELECT accounts.* INTO selected_account
  FROM app.personal_accounts accounts
  JOIN app_private.clerk_identities identities
    ON identities.personal_account_id = accounts.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
  FOR UPDATE OF accounts;

  IF NOT FOUND THEN RETURN false; END IF;
  IF selected_account.deletion_marker_id IS NOT NULL THEN
    RETURN selected_account.deletion_marker_id = requested_marker_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.whatsapp_connections connections
    WHERE connections.personal_account_id = selected_account.id
      AND connections.state <> 'deleting'
  ) THEN
    RAISE object_not_in_prerequisite_state;
  END IF;

  UPDATE app.personal_account_key_envelopes keys
  SET ciphertext = NULL, unavailable_at = coalesce(keys.unavailable_at, requested_at)
  WHERE keys.personal_account_id = selected_account.id;
  UPDATE app.personal_accounts accounts
  SET deletion_marker_id = requested_marker_id,
      updated_at = greatest(accounts.updated_at, requested_at)
  WHERE accounts.id = selected_account.id;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION app_private.prepare_whatsapp_connection_deletion(
  verified_clerk_user_id text, requested_public_id text
)
RETURNS TABLE (
  outcome text, public_id text, deletion_requested_at timestamptz,
  deletion_marker_id text, personal_account_id uuid, whatsapp_connection_id uuid,
  account_key_version integer, account_kms_key_id text, account_key_ciphertext bytea,
  connection_key_account_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea,
  locator_ciphertext_version smallint, locator_key_version integer,
  locator_nonce bytea, locator_ciphertext bytea
)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE WHEN connections.state = 'deleting' THEN 'complete' ELSE 'prepared' END,
    connections.public_id, connections.deletion_requested_at, connections.deletion_marker_id,
    connections.personal_account_id, connections.id,
    account_keys.key_version, account_keys.kms_key_id, account_keys.ciphertext,
    connection_keys.account_key_version, connection_keys.key_version,
    connection_keys.nonce, connection_keys.ciphertext,
    sessions.locator_ciphertext_version, sessions.locator_key_version,
    sessions.locator_nonce, sessions.locator_ciphertext
  FROM app_private.clerk_identities identities
  JOIN app.personal_accounts accounts ON accounts.id = identities.personal_account_id
  JOIN app.whatsapp_connections connections ON connections.personal_account_id = accounts.id
  LEFT JOIN app.personal_account_key_envelopes account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
  LEFT JOIN app.whatsapp_connection_key_envelopes connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  LEFT JOIN app.whatsapp_connection_provider_sessions sessions
    ON sessions.personal_account_id = connections.personal_account_id
   AND sessions.whatsapp_connection_id = connections.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND connections.public_id = requested_public_id
    AND accounts.state IN ('active', 'deleting')
    AND (connections.state = 'deleting' OR (
      account_keys.unavailable_at IS NULL AND account_keys.ciphertext IS NOT NULL
      AND connection_keys.unavailable_at IS NULL AND connection_keys.ciphertext IS NOT NULL
      AND sessions.locator_ciphertext IS NOT NULL
    ))
$function$;

CREATE OR REPLACE FUNCTION app_private.finish_whatsapp_connection_deletion(
  verified_clerk_user_id text, requested_public_id text,
  requested_marker_id text, requested_at timestamptz
)
RETURNS TABLE (public_id text, deletion_requested_at timestamptz, deletion_marker_id text)
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE connection app.whatsapp_connections%ROWTYPE;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$' THEN RAISE invalid_parameter_value; END IF;
  SELECT connections.* INTO connection
  FROM app.whatsapp_connections connections
  JOIN app_private.clerk_identities identities ON identities.personal_account_id=connections.personal_account_id
  JOIN app.personal_accounts accounts ON accounts.id=connections.personal_account_id
  WHERE identities.clerk_user_id=verified_clerk_user_id
    AND connections.public_id=requested_public_id AND accounts.state IN ('active','deleting')
  FOR UPDATE OF connections;
  IF NOT FOUND THEN RETURN; END IF;
  IF connection.state='deleting' THEN
    IF connection.deletion_marker_id IS DISTINCT FROM requested_marker_id THEN RAISE invalid_parameter_value; END IF;
  ELSE
    DELETE FROM app.mcp_authorization_connections selected
      WHERE selected.personal_account_id=connection.personal_account_id
        AND selected.whatsapp_connection_id=connection.id;
    UPDATE app.whatsapp_connection_key_envelopes keys
      SET account_key_version=NULL, key_version=NULL, nonce=NULL, ciphertext=NULL, unavailable_at=requested_at
      WHERE keys.personal_account_id=connection.personal_account_id
        AND keys.whatsapp_connection_id=connection.id AND keys.unavailable_at IS NULL;
    UPDATE app.whatsapp_connections connections SET state='deleting', desired_state='disconnected',
      deletion_requested_at=requested_at, deletion_marker_id=requested_marker_id,
      lifecycle_claim_id=NULL, lifecycle_lease_expires_at=NULL,
      state_changed_at=greatest(connections.state_changed_at,requested_at),
      updated_at=greatest(connections.updated_at,requested_at)
      WHERE connections.id=connection.id RETURNING connections.* INTO connection;
  END IF;
  RETURN QUERY SELECT connection.public_id, connection.deletion_requested_at, connection.deletion_marker_id;
END $function$;

REVOKE ALL ON FUNCTION app_private.prepare_personal_account_deletion(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.finish_personal_account_deletion(text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.prepare_personal_account_deletion(text,timestamptz) TO whatsapp_api_runtime;
GRANT EXECUTE ON FUNCTION app_private.finish_personal_account_deletion(text,text,timestamptz) TO whatsapp_api_runtime;
