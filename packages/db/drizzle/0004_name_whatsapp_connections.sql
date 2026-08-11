CREATE FUNCTION public.random_whatsapp_connection_name()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    (ARRAY['Bright', 'Calm', 'Clever', 'Kind', 'Lucky', 'Quiet', 'Swift', 'Warm'])[1 + floor(random() * 8)::integer]
    || ' ' ||
    (ARRAY['Badger', 'Falcon', 'Fox', 'Otter', 'Panda', 'Robin', 'Tiger', 'Turtle'])[1 + floor(random() * 8)::integer]
$function$;
--> statement-breakpoint

ALTER TABLE public.connection_setups
  ADD COLUMN display_name_ciphertext_version smallint,
  ADD COLUMN display_name_key_version integer,
  ADD COLUMN display_name_nonce bytea,
  ADD COLUMN display_name_ciphertext bytea,
  ADD COLUMN display_name_fallback text DEFAULT public.random_whatsapp_connection_name();
--> statement-breakpoint

UPDATE public.connection_setups
SET display_name_fallback = public.random_whatsapp_connection_name();
--> statement-breakpoint

ALTER TABLE public.connection_setups
  ADD CONSTRAINT connection_setups_display_name_storage_check CHECK (
    (
      display_name_fallback ~ '^(Bright|Calm|Clever|Kind|Lucky|Quiet|Swift|Warm) (Badger|Falcon|Fox|Otter|Panda|Robin|Tiger|Turtle)$'
      AND display_name_ciphertext_version IS NULL
      AND display_name_key_version IS NULL
      AND display_name_nonce IS NULL
      AND display_name_ciphertext IS NULL
    ) OR (
      display_name_fallback IS NULL
      AND display_name_ciphertext_version = 1
      AND display_name_key_version > 0
      AND octet_length(display_name_nonce) = 12
      AND octet_length(display_name_ciphertext) > 16
    )
  );
--> statement-breakpoint

ALTER TABLE public.whatsapp_connections
  ADD COLUMN display_name_ciphertext_version smallint,
  ADD COLUMN display_name_key_version integer,
  ADD COLUMN display_name_nonce bytea,
  ADD COLUMN display_name_fallback text DEFAULT public.random_whatsapp_connection_name();
--> statement-breakpoint

UPDATE public.whatsapp_connections
SET
  display_name_ciphertext = NULL,
  display_name_fallback = public.random_whatsapp_connection_name();
--> statement-breakpoint

ALTER TABLE public.whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_display_name_storage_check CHECK (
    (
      display_name_fallback ~ '^(Bright|Calm|Clever|Kind|Lucky|Quiet|Swift|Warm) (Badger|Falcon|Fox|Otter|Panda|Robin|Tiger|Turtle)$'
      AND display_name_ciphertext_version IS NULL
      AND display_name_key_version IS NULL
      AND display_name_nonce IS NULL
      AND display_name_ciphertext IS NULL
    ) OR (
      display_name_fallback IS NULL
      AND display_name_ciphertext_version = 1
      AND display_name_key_version > 0
      AND octet_length(display_name_nonce) = 12
      AND octet_length(display_name_ciphertext) > 16
    )
  );
--> statement-breakpoint

GRANT UPDATE (
  display_name_ciphertext_version,
  display_name_key_version,
  display_name_nonce,
  display_name_ciphertext,
  display_name_fallback
) ON public.connection_setups TO whatsapp_api_runtime;
--> statement-breakpoint

GRANT SELECT (
  personal_account_id,
  connection_setup_id,
  account_key_version,
  key_version,
  nonce,
  ciphertext
) ON public.connection_setup_key_envelopes TO whatsapp_api_runtime;
--> statement-breakpoint

GRANT SELECT (
  personal_account_id,
  key_version,
  kms_key_id,
  ciphertext,
  unavailable_at
) ON public.personal_account_key_envelopes TO whatsapp_api_runtime;
--> statement-breakpoint

GRANT SELECT (
  personal_account_id,
  whatsapp_connection_id,
  account_key_version,
  key_version,
  nonce,
  ciphertext,
  unavailable_at
) ON public.whatsapp_connection_key_envelopes TO whatsapp_api_runtime;
