import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgPolicy,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { personalAccountsInApp } from "./accounts";
import { publicSchema } from "./common";

export const personalAccountOnboardingProfilesInApp = publicSchema.table(
  "personal_account_onboarding_profiles",
  {
    personalAccountId: uuid("personal_account_id").primaryKey().notNull(),
    primaryUseCase: text("primary_use_case").notNull(),
    whatsappUsageContext: text("whatsapp_usage_context").notNull(),
    role: text().notNull(),
    intendedMcpClient: text("intended_mcp_client").notNull(),
    researchCallInterest: text("research_call_interest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "personal_account_onboarding_profiles_personal_account_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("personal_account_onboarding_profiles_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "personal_account_onboarding_profiles_primary_use_case_check",
      sql`primary_use_case = ANY (ARRAY['conversation_search'::text, 'summaries'::text, 'draft_replies'::text, 'outbound_sends'::text, 'follow_ups'::text, 'exploration'::text, 'other'::text])`,
    ),
    check(
      "personal_account_onboarding_profiles_whatsapp_usage_context_check",
      sql`whatsapp_usage_context = ANY (ARRAY['personal'::text, 'work'::text, 'both'::text])`,
    ),
    check(
      "personal_account_onboarding_profiles_role_check",
      sql`role = ANY (ARRAY['founder_or_owner'::text, 'engineer'::text, 'product_or_design'::text, 'operations_or_support'::text, 'marketing_or_sales'::text, 'consultant_or_freelancer'::text, 'student_or_researcher'::text, 'other'::text, 'not_sure'::text])`,
    ),
    check(
      "personal_account_onboarding_profiles_intended_mcp_client_check",
      sql`intended_mcp_client = ANY (ARRAY['claude'::text, 'chatgpt'::text, 'other'::text, 'not_sure'::text])`,
    ),
    check(
      "personal_account_onboarding_profiles_research_call_interest_check",
      sql`research_call_interest = ANY (ARRAY['yes'::text, 'no'::text, 'not_sure'::text])`,
    ),
  ],
);
