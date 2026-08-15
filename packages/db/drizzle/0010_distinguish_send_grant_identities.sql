-- Send Operations record a protocol-neutral originating grant. MCP
-- Authorization and API Key remain distinct principals. Existing MCP rows
-- keep their authorization identity. Internal grant IDs stay out of public
-- receipts.
ALTER TABLE public.send_operations
  ADD COLUMN grant_type text NOT NULL DEFAULT 'mcp',
  ADD COLUMN api_key_id uuid;
--> statement-breakpoint

ALTER TABLE public.send_operations
  ALTER COLUMN mcp_authorization_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE public.send_operations
  ADD CONSTRAINT send_operations_grant_type_check
    CHECK (grant_type IN ('mcp', 'api'));
--> statement-breakpoint

ALTER TABLE public.send_operations
  ADD CONSTRAINT send_operations_grant_principal
    CHECK (
      (
        grant_type = 'mcp'
        AND mcp_authorization_id IS NOT NULL
        AND api_key_id IS NULL
      )
      OR (
        grant_type = 'api'
        AND mcp_authorization_id IS NULL
        AND api_key_id IS NOT NULL
      )
    );
--> statement-breakpoint

ALTER TABLE public.send_operations
  ADD CONSTRAINT send_operations_api_key_fkey
    FOREIGN KEY (personal_account_id, api_key_id)
    REFERENCES public.api_keys (personal_account_id, id)
    ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE public.send_quota_reservations
  ADD COLUMN grant_type text NOT NULL DEFAULT 'mcp',
  ADD COLUMN api_key_id uuid;
--> statement-breakpoint

ALTER TABLE public.send_quota_reservations
  ALTER COLUMN mcp_authorization_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE public.send_quota_reservations
  ADD CONSTRAINT send_quota_reservations_grant_type_check
    CHECK (grant_type IN ('mcp', 'api'));
--> statement-breakpoint

ALTER TABLE public.send_quota_reservations
  ADD CONSTRAINT send_quota_reservations_grant_principal
    CHECK (
      (
        grant_type = 'mcp'
        AND mcp_authorization_id IS NOT NULL
        AND api_key_id IS NULL
      )
      OR (
        grant_type = 'api'
        AND mcp_authorization_id IS NULL
        AND api_key_id IS NOT NULL
      )
    );
--> statement-breakpoint

ALTER TABLE public.send_quota_reservations
  ADD CONSTRAINT send_quota_reservations_api_key_fkey
    FOREIGN KEY (personal_account_id, api_key_id)
    REFERENCES public.api_keys (personal_account_id, id)
    ON DELETE CASCADE;
--> statement-breakpoint

CREATE INDEX send_quota_api_key_time
  ON public.send_quota_reservations (api_key_id, reserved_at)
  WHERE api_key_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.send_idempotency_bindings
  ADD COLUMN grant_type text NOT NULL DEFAULT 'mcp',
  ADD COLUMN grant_id uuid,
  ADD COLUMN api_key_id uuid;
--> statement-breakpoint

UPDATE public.send_idempotency_bindings
SET grant_id = mcp_authorization_id
WHERE grant_id IS NULL;
--> statement-breakpoint

ALTER TABLE public.send_idempotency_bindings
  ALTER COLUMN grant_id SET NOT NULL;
--> statement-breakpoint

ALTER TABLE public.send_idempotency_bindings
  DROP CONSTRAINT send_idempotency_bindings_pkey;
--> statement-breakpoint

ALTER TABLE public.send_idempotency_bindings
  ADD PRIMARY KEY (idempotency_key, grant_id);
--> statement-breakpoint

ALTER TABLE public.send_idempotency_bindings
  ALTER COLUMN mcp_authorization_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE public.send_idempotency_bindings
  ADD CONSTRAINT send_idempotency_bindings_grant_type_check
    CHECK (grant_type IN ('mcp', 'api'));
--> statement-breakpoint

ALTER TABLE public.send_idempotency_bindings
  ADD CONSTRAINT send_idempotency_bindings_grant_principal
    CHECK (
      (
        grant_type = 'mcp'
        AND grant_id = mcp_authorization_id
        AND mcp_authorization_id IS NOT NULL
        AND api_key_id IS NULL
      )
      OR (
        grant_type = 'api'
        AND grant_id = api_key_id
        AND mcp_authorization_id IS NULL
        AND api_key_id IS NOT NULL
      )
    );
--> statement-breakpoint

ALTER TABLE public.send_idempotency_bindings
  ADD CONSTRAINT send_idempotency_bindings_api_key_fkey
    FOREIGN KEY (personal_account_id, api_key_id)
    REFERENCES public.api_keys (personal_account_id, id)
    ON DELETE CASCADE;
