ALTER TABLE "send_idempotency_bindings"
ADD COLUMN "request_shape_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "send_idempotency_bindings"
ADD CONSTRAINT "send_idempotency_bindings_request_shape_fingerprint_check"
CHECK (
  "request_shape_fingerprint" IS NULL
  OR "request_shape_fingerprint" ~ '^sf1_[A-Za-z0-9_-]{43}$'::text
);
--> statement-breakpoint
ALTER TABLE "send_operations" DROP CONSTRAINT "send_operations_check";
--> statement-breakpoint
ALTER TABLE "send_operations" ADD CONSTRAINT "send_operations_check"
CHECK (
  "lease_expires_at" = "attempt_claimed_at" + interval '30 seconds'
  OR "lease_expires_at" = "attempt_claimed_at" + interval '45 seconds'
);
--> statement-breakpoint
DO $migration$
DECLARE function_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.verify_recovery_branch(text,timestamptz)'::regprocedure
  ) INTO function_definition;
  IF pg_catalog.strpos(function_definition, '1787253600000') = 0 THEN
    RAISE EXCEPTION 'verify_recovery_branch schema version is unexpected';
  END IF;
  function_definition := pg_catalog.replace(
    function_definition, '1787253600000', '1787544000000');
  EXECUTE function_definition;
END
$migration$;
