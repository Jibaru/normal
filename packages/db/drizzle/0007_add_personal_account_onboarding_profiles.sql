-- Personal Account-owned first-connection research profile. One row per
-- Personal Account, completed before the first Connection Setup (except when
-- the account already retains a WhatsApp Connection). Cascades with Personal
-- Account purge; answers are structured enums only and never enter Tool Call
-- Logs or analytics identity surfaces.
CREATE TABLE public.personal_account_onboarding_profiles (
  personal_account_id uuid PRIMARY KEY REFERENCES public.personal_accounts (id)
    ON DELETE CASCADE,
  primary_use_case text NOT NULL CHECK (primary_use_case IN (
    'conversation_search',
    'summaries',
    'draft_replies',
    'outbound_sends',
    'follow_ups',
    'exploration',
    'other'
  )),
  whatsapp_usage_context text NOT NULL CHECK (whatsapp_usage_context IN (
    'personal',
    'work',
    'both'
  )),
  role text NOT NULL CHECK (role IN (
    'founder_or_owner',
    'engineer',
    'product_or_design',
    'operations_or_support',
    'marketing_or_sales',
    'consultant_or_freelancer',
    'student_or_researcher',
    'other',
    'not_sure'
  )),
  intended_mcp_client text NOT NULL CHECK (intended_mcp_client IN (
    'claude',
    'chatgpt',
    'other',
    'not_sure'
  )),
  research_call_interest text NOT NULL CHECK (research_call_interest IN (
    'yes',
    'no',
    'not_sure'
  )),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
--> statement-breakpoint

CREATE INDEX personal_account_onboarding_profiles_completed_at
  ON public.personal_account_onboarding_profiles (completed_at);
--> statement-breakpoint

ALTER TABLE public.personal_account_onboarding_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.personal_account_onboarding_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY personal_account_onboarding_profiles_tenant
  ON public.personal_account_onboarding_profiles
  USING (
    personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true),
      ''
    )::uuid
  )
  WITH CHECK (
    personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true),
      ''
    )::uuid
  );
--> statement-breakpoint
REVOKE ALL ON TABLE public.personal_account_onboarding_profiles FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.personal_account_onboarding_profiles TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.get_onboarding_profile(verified_clerk_user_id text)
RETURNS TABLE (
  account_accessible boolean,
  primary_use_case text,
  whatsapp_usage_context text,
  role text,
  intended_mcp_client text,
  research_call_interest text,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, public
AS $function$
  SELECT
    TRUE AS account_accessible,
    profiles.primary_use_case,
    profiles.whatsapp_usage_context,
    profiles.role,
    profiles.intended_mcp_client,
    profiles.research_call_interest,
    profiles.created_at,
    profiles.updated_at,
    profiles.completed_at
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  LEFT JOIN public.personal_account_onboarding_profiles AS profiles
    ON profiles.personal_account_id = accounts.id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active';
$function$;
--> statement-breakpoint

CREATE FUNCTION public.upsert_onboarding_profile(
  verified_clerk_user_id text,
  requested_primary_use_case text,
  requested_whatsapp_usage_context text,
  requested_role text,
  requested_intended_mcp_client text,
  requested_research_call_interest text,
  requested_at timestamptz
)
RETURNS TABLE (
  primary_use_case text,
  whatsapp_usage_context text,
  role text,
  intended_mcp_client text,
  research_call_interest text,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, public
AS $function$
DECLARE
  selected_account_id uuid;
BEGIN
  IF requested_primary_use_case NOT IN (
    'conversation_search', 'summaries', 'draft_replies', 'outbound_sends',
    'follow_ups', 'exploration', 'other'
  )
    OR requested_whatsapp_usage_context NOT IN ('personal', 'work', 'both')
    OR requested_role NOT IN (
      'founder_or_owner', 'engineer', 'product_or_design',
      'operations_or_support', 'marketing_or_sales',
      'consultant_or_freelancer', 'student_or_researcher', 'other', 'not_sure'
    )
    OR requested_intended_mcp_client NOT IN (
      'claude', 'chatgpt', 'other', 'not_sure'
    )
    OR requested_research_call_interest NOT IN ('yes', 'no', 'not_sure')
  THEN
    RAISE EXCEPTION 'invalid onboarding profile values';
  END IF;

  SELECT accounts.id INTO selected_account_id
  FROM public.clerk_identities AS identities
  JOIN public.personal_accounts AS accounts
    ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
    AND accounts.state = 'active'
  FOR UPDATE OF accounts;
  IF selected_account_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.personal_account_onboarding_profiles AS profiles (
    personal_account_id,
    primary_use_case,
    whatsapp_usage_context,
    role,
    intended_mcp_client,
    research_call_interest,
    created_at,
    updated_at,
    completed_at
  ) VALUES (
    selected_account_id,
    requested_primary_use_case,
    requested_whatsapp_usage_context,
    requested_role,
    requested_intended_mcp_client,
    requested_research_call_interest,
    requested_at,
    requested_at,
    requested_at
  )
  ON CONFLICT (personal_account_id) DO UPDATE SET
    primary_use_case = EXCLUDED.primary_use_case,
    whatsapp_usage_context = EXCLUDED.whatsapp_usage_context,
    role = EXCLUDED.role,
    intended_mcp_client = EXCLUDED.intended_mcp_client,
    research_call_interest = EXCLUDED.research_call_interest,
    updated_at = EXCLUDED.updated_at
  RETURNING
    profiles.primary_use_case,
    profiles.whatsapp_usage_context,
    profiles.role,
    profiles.intended_mcp_client,
    profiles.research_call_interest,
    profiles.created_at,
    profiles.updated_at,
    profiles.completed_at;
END
$function$;
--> statement-breakpoint

-- First Connection Setup requires a completed profile unless the Personal
-- Account already retains a non-deleted WhatsApp Connection (grandfathered).
CREATE FUNCTION public.first_connection_setup_eligible(
  verified_clerk_user_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.clerk_identities AS identities
    JOIN public.personal_accounts AS accounts
      ON accounts.id = identities.personal_account_id
    WHERE identities.clerk_user_id = verified_clerk_user_id
      AND accounts.state = 'active'
      AND (
        EXISTS (
          SELECT 1
          FROM public.personal_account_onboarding_profiles AS profiles
          WHERE profiles.personal_account_id = accounts.id
            AND profiles.completed_at IS NOT NULL
        )
        OR EXISTS (
          SELECT 1
          FROM public.whatsapp_connections AS connections
          WHERE connections.personal_account_id = accounts.id
            AND connections.state <> 'deleting'
        )
      )
  );
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.get_onboarding_profile(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.upsert_onboarding_profile(
  text, text, text, text, text, text, timestamptz
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.first_connection_setup_eligible(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.get_onboarding_profile(text),
  public.upsert_onboarding_profile(
    text, text, text, text, text, text, timestamptz
  ),
  public.first_connection_setup_eligible(text)
  TO whatsapp_api_runtime;
