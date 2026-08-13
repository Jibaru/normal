import { Schema } from "effect";

export const OnboardingPrimaryUseCase = Schema.Literal(
  "conversation_search",
  "summaries",
  "draft_replies",
  "outbound_sends",
  "follow_ups",
  "exploration",
  "other",
);
export type OnboardingPrimaryUseCase = typeof OnboardingPrimaryUseCase.Type;

export const OnboardingWhatsAppUsageContext = Schema.Literal(
  "personal",
  "work",
  "both",
);
export type OnboardingWhatsAppUsageContext =
  typeof OnboardingWhatsAppUsageContext.Type;

export const OnboardingRole = Schema.Literal(
  "founder_or_owner",
  "engineer",
  "product_or_design",
  "operations_or_support",
  "marketing_or_sales",
  "consultant_or_freelancer",
  "student_or_researcher",
  "other",
  "not_sure",
);
export type OnboardingRole = typeof OnboardingRole.Type;

export const OnboardingIntendedMcpClient = Schema.Literal(
  "claude",
  "chatgpt",
  "other",
  "not_sure",
);
export type OnboardingIntendedMcpClient =
  typeof OnboardingIntendedMcpClient.Type;

export const OnboardingResearchCallInterest = Schema.Literal(
  "yes",
  "no",
  "not_sure",
);
export type OnboardingResearchCallInterest =
  typeof OnboardingResearchCallInterest.Type;

export const OnboardingProfileWrite = Schema.Struct({
  intended_mcp_client: OnboardingIntendedMcpClient,
  primary_use_case: OnboardingPrimaryUseCase,
  research_call_interest: OnboardingResearchCallInterest,
  role: OnboardingRole,
  whatsapp_usage_context: OnboardingWhatsAppUsageContext,
});
export type OnboardingProfileWrite = typeof OnboardingProfileWrite.Type;

export const OnboardingProfile = Schema.Struct({
  completed_at: Schema.String,
  created_at: Schema.String,
  intended_mcp_client: OnboardingIntendedMcpClient,
  primary_use_case: OnboardingPrimaryUseCase,
  research_call_interest: OnboardingResearchCallInterest,
  role: OnboardingRole,
  updated_at: Schema.String,
  whatsapp_usage_context: OnboardingWhatsAppUsageContext,
});
export type OnboardingProfile = typeof OnboardingProfile.Type;

export const decodeOnboardingProfileWrite = Schema.decodeUnknownSync(
  OnboardingProfileWrite,
  { onExcessProperty: "error" },
);

export const decodeOnboardingProfile = Schema.decodeUnknownSync(
  OnboardingProfile,
  { onExcessProperty: "error" },
);

export const ONBOARDING_PRIMARY_USE_CASES = [
  "conversation_search",
  "summaries",
  "draft_replies",
  "outbound_sends",
  "follow_ups",
  "exploration",
  "other",
] as const satisfies ReadonlyArray<OnboardingPrimaryUseCase>;

export const ONBOARDING_WHATSAPP_USAGE_CONTEXTS = [
  "personal",
  "work",
  "both",
] as const satisfies ReadonlyArray<OnboardingWhatsAppUsageContext>;

export const ONBOARDING_ROLES = [
  "founder_or_owner",
  "engineer",
  "product_or_design",
  "operations_or_support",
  "marketing_or_sales",
  "consultant_or_freelancer",
  "student_or_researcher",
  "other",
  "not_sure",
] as const satisfies ReadonlyArray<OnboardingRole>;

export const ONBOARDING_INTENDED_MCP_CLIENTS = [
  "claude",
  "chatgpt",
  "other",
  "not_sure",
] as const satisfies ReadonlyArray<OnboardingIntendedMcpClient>;

export const ONBOARDING_RESEARCH_CALL_INTERESTS = [
  "yes",
  "no",
  "not_sure",
] as const satisfies ReadonlyArray<OnboardingResearchCallInterest>;
