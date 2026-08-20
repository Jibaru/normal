CREATE FUNCTION public.rotate_recovery_verifier_password(
  requested_password text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_password IS NULL OR requested_password !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid recovery verifier password';
  END IF;
  BEGIN
    EXECUTE format(
      'ALTER ROLE whatsapp_recovery_auditor PASSWORD %L',
      requested_password
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'recovery verifier password rotation failed';
  END;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.rotate_recovery_verifier_password(text)
  FROM PUBLIC;
