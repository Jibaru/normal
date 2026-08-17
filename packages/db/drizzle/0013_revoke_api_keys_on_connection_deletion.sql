-- Connection Deletion removes the WhatsApp Connection from every API Key in
-- the same authoritative lifecycle transaction that revokes MCP selection and
-- makes connection keys unavailable. A key that loses its last selected
-- Connection is permanently revoked and its credential digest is cleared.
-- Ordinary disconnection does not change selection or revoke the key.
DELETE FROM public.api_key_connections selected
USING public.whatsapp_connections connections
WHERE selected.personal_account_id = connections.personal_account_id
  AND selected.whatsapp_connection_id = connections.id
  AND connections.state = 'deleting';
--> statement-breakpoint

UPDATE public.api_keys keys
SET
  state = 'revoked',
  credential_digest = NULL,
  revoked_at = transaction_timestamp(),
  metadata_expires_at = transaction_timestamp() + interval '90 days'
WHERE keys.state = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM public.api_key_connections remaining
    WHERE remaining.personal_account_id = keys.personal_account_id
      AND remaining.api_key_id = keys.id
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.finish_whatsapp_connection_deletion(
  verified_clerk_user_id text, requested_public_id text,
  requested_marker_id text, requested_at timestamptz
)
RETURNS TABLE (public_id text, deletion_requested_at timestamptz, deletion_marker_id text)
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE connection public.whatsapp_connections%ROWTYPE;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$' THEN RAISE invalid_parameter_value; END IF;
  SELECT connections.* INTO connection
  FROM public.whatsapp_connections connections
  JOIN public.clerk_identities identities ON identities.personal_account_id=connections.personal_account_id
  JOIN public.personal_accounts accounts ON accounts.id=connections.personal_account_id
  WHERE identities.clerk_user_id=verified_clerk_user_id
    AND connections.public_id=requested_public_id AND accounts.state IN ('active','deleting')
  FOR UPDATE OF connections;
  IF NOT FOUND THEN RETURN; END IF;
  IF connection.state='deleting' THEN
    IF connection.deletion_marker_id IS DISTINCT FROM requested_marker_id THEN RAISE invalid_parameter_value; END IF;
  ELSE
    DELETE FROM public.mcp_authorization_connections selected
      WHERE selected.personal_account_id=connection.personal_account_id
        AND selected.whatsapp_connection_id=connection.id;
    DELETE FROM public.api_key_connections selected
      WHERE selected.personal_account_id=connection.personal_account_id
        AND selected.whatsapp_connection_id=connection.id;
    UPDATE public.api_keys keys
      SET state='revoked', credential_digest=NULL, revoked_at=requested_at,
        metadata_expires_at=requested_at + interval '90 days'
      WHERE keys.personal_account_id=connection.personal_account_id
        AND keys.state='active'
        AND NOT EXISTS (
          SELECT 1 FROM public.api_key_connections remaining
          WHERE remaining.personal_account_id=keys.personal_account_id
            AND remaining.api_key_id=keys.id
        );
    UPDATE public.whatsapp_connection_key_envelopes keys
      SET account_key_version=NULL, key_version=NULL, nonce=NULL, ciphertext=NULL, unavailable_at=requested_at
      WHERE keys.personal_account_id=connection.personal_account_id
        AND keys.whatsapp_connection_id=connection.id AND keys.unavailable_at IS NULL;
    UPDATE public.whatsapp_connections connections SET state='deleting', desired_state='disconnected',
      deletion_requested_at=requested_at, deletion_marker_id=requested_marker_id,
      lifecycle_claim_id=NULL, lifecycle_lease_expires_at=NULL,
      state_changed_at=greatest(connections.state_changed_at,requested_at),
      updated_at=greatest(connections.updated_at,requested_at)
      WHERE connections.id=connection.id RETURNING connections.* INTO connection;
  END IF;
  RETURN QUERY SELECT connection.public_id, connection.deletion_requested_at, connection.deletion_marker_id;
END $function$;
