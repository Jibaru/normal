import { sql } from "drizzle-orm";
import {
  makeDatabase,
  type QueryConnection,
  withPgQueryConnection,
} from "./database";

export type OnboardingPrimaryUseCase =
  | "conversation_search"
  | "summaries"
  | "draft_replies"
  | "outbound_sends"
  | "follow_ups"
  | "exploration"
  | "other";

export type OnboardingWhatsAppUsageContext = "personal" | "work" | "both";

export type OnboardingRole =
  | "founder_or_owner"
  | "engineer"
  | "product_or_design"
  | "operations_or_support"
  | "marketing_or_sales"
  | "consultant_or_freelancer"
  | "student_or_researcher"
  | "other"
  | "not_sure";

export type OnboardingIntendedMcpClient =
  | "claude"
  | "chatgpt"
  | "other"
  | "not_sure";

export type OnboardingResearchCallInterest = "yes" | "no" | "not_sure";

export interface OnboardingProfile {
  readonly completedAt: string;
  readonly createdAt: string;
  readonly firstConnectionCompletedAt: string | null;
  readonly intendedMcpClient: OnboardingIntendedMcpClient;
  readonly primaryUseCase: OnboardingPrimaryUseCase;
  readonly researchCallInterest: OnboardingResearchCallInterest;
  readonly role: OnboardingRole;
  readonly securityCompletedAt: string | null;
  readonly updatedAt: string;
  readonly whatsappUsageContext: OnboardingWhatsAppUsageContext;
}

export type OnboardingProfileLookup =
  | { readonly accessible: false }
  | {
      readonly accessible: true;
      readonly profile: OnboardingProfile | null;
    };

export interface UpsertOnboardingProfileInput {
  readonly clerkUserId: string;
  readonly intendedMcpClient: OnboardingIntendedMcpClient;
  readonly primaryUseCase: OnboardingPrimaryUseCase;
  readonly researchCallInterest: OnboardingResearchCallInterest;
  readonly role: OnboardingRole;
  readonly updatedAt: string;
  readonly whatsappUsageContext: OnboardingWhatsAppUsageContext;
}

export interface OnboardingProfileConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: QueryConnection) => Promise<Value>,
  ) => Promise<Value>;
}

const primaryUseCases = new Set<string>([
  "conversation_search",
  "summaries",
  "draft_replies",
  "outbound_sends",
  "follow_ups",
  "exploration",
  "other",
]);
const usageContexts = new Set<string>(["personal", "work", "both"]);
const roles = new Set<string>([
  "founder_or_owner",
  "engineer",
  "product_or_design",
  "operations_or_support",
  "marketing_or_sales",
  "consultant_or_freelancer",
  "student_or_researcher",
  "other",
  "not_sure",
]);
const mcpClients = new Set<string>(["claude", "chatgpt", "other", "not_sure"]);
const callInterests = new Set<string>(["yes", "no", "not_sure"]);

const timestamp = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
};

const decodeProfile = (
  row: Record<string, unknown>,
): OnboardingProfile | null => {
  if (row.primary_use_case === null || row.primary_use_case === undefined) {
    return null;
  }
  const primaryUseCase = row.primary_use_case;
  const whatsappUsageContext = row.whatsapp_usage_context;
  const role = row.role;
  const intendedMcpClient = row.intended_mcp_client;
  const researchCallInterest = row.research_call_interest;
  const createdAt = timestamp(row.created_at);
  const updatedAt = timestamp(row.updated_at);
  const completedAt = timestamp(row.completed_at);
  const firstConnectionCompletedAt = timestamp(
    row.first_connection_completed_at,
  );
  const securityCompletedAt = timestamp(row.security_completed_at);
  if (
    typeof primaryUseCase !== "string" ||
    !primaryUseCases.has(primaryUseCase) ||
    typeof whatsappUsageContext !== "string" ||
    !usageContexts.has(whatsappUsageContext) ||
    typeof role !== "string" ||
    !roles.has(role) ||
    typeof intendedMcpClient !== "string" ||
    !mcpClients.has(intendedMcpClient) ||
    typeof researchCallInterest !== "string" ||
    !callInterests.has(researchCallInterest) ||
    createdAt === null ||
    updatedAt === null ||
    completedAt === null
  ) {
    throw new Error("invalid onboarding profile");
  }
  return {
    completedAt,
    createdAt,
    firstConnectionCompletedAt,
    intendedMcpClient: intendedMcpClient as OnboardingIntendedMcpClient,
    primaryUseCase: primaryUseCase as OnboardingPrimaryUseCase,
    researchCallInterest:
      researchCallInterest as OnboardingResearchCallInterest,
    role: role as OnboardingRole,
    securityCompletedAt,
    updatedAt,
    whatsappUsageContext:
      whatsappUsageContext as OnboardingWhatsAppUsageContext,
  };
};

const decodeLookup = (
  row: Record<string, unknown> | undefined,
): OnboardingProfileLookup => {
  if (row === undefined || row.account_accessible !== true) {
    return { accessible: false };
  }
  return { accessible: true, profile: decodeProfile(row) };
};

const decodeUpsert = (
  row: Record<string, unknown> | undefined,
): OnboardingProfile | null => {
  if (row === undefined) return null;
  return decodeProfile(row);
};

export const makeOnboardingProfileRepository = (
  provider: OnboardingProfileConnectionProvider,
) => ({
  getForUser: (clerkUserId: string) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute(
        sql`SELECT * FROM public.get_onboarding_profile(${clerkUserId})`,
      );
      return decodeLookup(rows[0]);
    }),
  upsertForUser: (input: UpsertOnboardingProfileInput) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute(
        sql`SELECT * FROM public.upsert_onboarding_profile(
          ${input.clerkUserId},
          ${input.primaryUseCase},
          ${input.whatsappUsageContext},
          ${input.role},
          ${input.intendedMcpClient},
          ${input.researchCallInterest},
          ${input.updatedAt}
        )`,
      );
      return decodeUpsert(rows[0]);
    }),
  markSecurityCompletedForUser: (input: {
    readonly clerkUserId: string;
    readonly completedAt: string;
  }) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute(
        sql`SELECT * FROM public.complete_onboarding_security(
          ${input.clerkUserId},
          ${input.completedAt}
        )`,
      );
      return decodeUpsert(rows[0]);
    }),
  isFirstConnectionSetupEligible: (clerkUserId: string) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        eligible: unknown;
      }>(
        sql`SELECT public.first_connection_setup_eligible(${clerkUserId}) AS eligible`,
      );
      if (typeof rows[0]?.eligible !== "boolean") {
        throw new Error("invalid first Connection Setup eligibility");
      }
      return rows[0].eligible;
    }),
});

export type OnboardingProfileRepository = ReturnType<
  typeof makeOnboardingProfileRepository
>;

const makePgProvider = (
  connectionString: string,
): OnboardingProfileConnectionProvider => ({
  withConnection: (use) => withPgQueryConnection(connectionString, use, 70_000),
});

export const makePgOnboardingProfileRepository = (connectionString: string) =>
  makeOnboardingProfileRepository(makePgProvider(connectionString));
