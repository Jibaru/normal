CREATE TABLE public.recovery_source_points (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  observed_at timestamptz NOT NULL
);
--> statement-breakpoint

REVOKE ALL ON public.recovery_source_points FROM PUBLIC;
--> statement-breakpoint

INSERT INTO public.recovery_source_points (singleton, observed_at)
VALUES (true, pg_catalog.statement_timestamp());
--> statement-breakpoint

CREATE FUNCTION public.record_recovery_source_point()
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  recorded_at timestamptz := pg_catalog.statement_timestamp();
BEGIN
  INSERT INTO public.recovery_source_points (singleton, observed_at)
  VALUES (true, recorded_at)
  ON CONFLICT (singleton) DO UPDATE
    SET observed_at = excluded.observed_at;
  RETURN recorded_at;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.read_recovery_source_point()
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT observed_at
  FROM public.recovery_source_points
  WHERE singleton
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.record_recovery_source_point() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_recovery_source_point() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_recovery_source_point()
  TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.read_recovery_source_point()
  TO whatsapp_recovery_auditor;
