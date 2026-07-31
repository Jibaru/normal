ALTER TABLE app.connection_setups
  ADD COLUMN webhook_ingress_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD CONSTRAINT connection_setups_webhook_ingress_unique
    UNIQUE (webhook_ingress_id),
  ADD CONSTRAINT connection_setups_activation_ingress_unique
    UNIQUE (personal_account_id, id, webhook_ingress_id);

UPDATE app.connection_setups AS setups
SET webhook_ingress_id = connections.webhook_ingress_id
FROM app.whatsapp_connections AS connections
WHERE connections.personal_account_id = setups.personal_account_id
  AND connections.connection_setup_id = setups.id
  AND setups.webhook_ingress_id IS DISTINCT FROM
    connections.webhook_ingress_id;

ALTER TABLE app.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_setup_ingress_foreign_key
    FOREIGN KEY (
      personal_account_id,
      connection_setup_id,
      webhook_ingress_id
    )
    REFERENCES app.connection_setups (
      personal_account_id,
      id,
      webhook_ingress_id
    );

CREATE FUNCTION app_private.load_connection_setup_webhook_ingress_for_worker(
  requested_setup_id text,
  requested_worker_id text
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT setups.webhook_ingress_id
  FROM app.connection_setups AS setups
  WHERE setups.id = requested_setup_id
    AND setups.state = 'provisioning_pending'
    AND setups.provisioning_lease_owner = requested_worker_id
$function$;

CREATE FUNCTION app_private.load_connection_setup_webhook_ingress_for_user(
  verified_clerk_user_id text,
  requested_setup_id text
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT setups.webhook_ingress_id
  FROM app_private.clerk_identities AS identities
  JOIN app.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  JOIN app.connection_setups AS setups
    ON setups.personal_account_id = accounts.id
   AND setups.id = requested_setup_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
$function$;

REVOKE ALL
  ON FUNCTION app_private.load_connection_setup_webhook_ingress_for_worker(
    text,
    text
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION app_private.load_connection_setup_webhook_ingress_for_user(
    text,
    text
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.load_connection_setup_webhook_ingress_for_worker(
    text,
    text
  )
  TO whatsapp_api_runtime;
GRANT EXECUTE
  ON FUNCTION app_private.load_connection_setup_webhook_ingress_for_user(
    text,
    text
  )
  TO whatsapp_api_runtime;

DROP FUNCTION app_private.bootstrap_whatsapp_connection_for_ingress(uuid);

CREATE FUNCTION app_private.bootstrap_whatsapp_connection_for_ingress(
  verified_webhook_ingress_id uuid
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
  authority_ciphertext_version smallint,
  authority_key_version integer,
  authority_nonce bytea,
  authority_ciphertext bytea
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    connections.personal_account_id,
    connections.id AS whatsapp_connection_id,
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
    provider_sessions.authority_ciphertext
  FROM app.whatsapp_connections AS connections
  JOIN app.personal_accounts AS accounts
    ON accounts.id = connections.personal_account_id
  JOIN app.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
  JOIN app.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
  JOIN app.whatsapp_connection_provider_sessions AS provider_sessions
    ON provider_sessions.personal_account_id = connections.personal_account_id
   AND provider_sessions.whatsapp_connection_id = connections.id
  WHERE connections.webhook_ingress_id = verified_webhook_ingress_id
    AND accounts.state = 'active'
    AND connections.state <> 'deleting'
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL
    AND connection_keys.unavailable_at IS NULL
    AND connection_keys.nonce IS NOT NULL
    AND connection_keys.ciphertext IS NOT NULL
$function$;

REVOKE ALL
  ON FUNCTION app_private.bootstrap_whatsapp_connection_for_ingress(uuid)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION app_private.bootstrap_whatsapp_connection_for_ingress(uuid)
  TO whatsapp_webhook_runtime;
