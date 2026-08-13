import { describe, expect, test } from "bun:test";
import {
  decodeOnboardingProfile,
  decodeOnboardingProfileWrite,
  ONBOARDING_INTENDED_MCP_CLIENTS,
  ONBOARDING_PRIMARY_USE_CASES,
  ONBOARDING_RESEARCH_CALL_INTERESTS,
  ONBOARDING_ROLES,
  ONBOARDING_WHATSAPP_USAGE_CONTEXTS,
  type OnboardingProfileWrite,
} from "../src/onboarding-profile";

const validWrite: OnboardingProfileWrite = {
  intended_mcp_client: "claude",
  primary_use_case: "conversation_search",
  research_call_interest: "yes",
  role: "engineer",
  whatsapp_usage_context: "personal",
};

describe("onboarding profile contract", () => {
  test("accepts every constrained enum value", () => {
    for (const primary_use_case of ONBOARDING_PRIMARY_USE_CASES) {
      expect(
        decodeOnboardingProfileWrite({ ...validWrite, primary_use_case }),
      ).toMatchObject({ primary_use_case });
    }
    for (const whatsapp_usage_context of ONBOARDING_WHATSAPP_USAGE_CONTEXTS) {
      expect(
        decodeOnboardingProfileWrite({ ...validWrite, whatsapp_usage_context }),
      ).toMatchObject({ whatsapp_usage_context });
    }
    for (const role of ONBOARDING_ROLES) {
      expect(
        decodeOnboardingProfileWrite({ ...validWrite, role }),
      ).toMatchObject({ role });
    }
    for (const intended_mcp_client of ONBOARDING_INTENDED_MCP_CLIENTS) {
      expect(
        decodeOnboardingProfileWrite({ ...validWrite, intended_mcp_client }),
      ).toMatchObject({ intended_mcp_client });
    }
    for (const research_call_interest of ONBOARDING_RESEARCH_CALL_INTERESTS) {
      expect(
        decodeOnboardingProfileWrite({ ...validWrite, research_call_interest }),
      ).toMatchObject({ research_call_interest });
    }
  });

  test("rejects unknown enums, extra keys, and free text", () => {
    expect(() =>
      decodeOnboardingProfileWrite({ ...validWrite, role: "wizard" }),
    ).toThrow();
    expect(() =>
      decodeOnboardingProfileWrite({ ...validWrite, notes: "free text" }),
    ).toThrow();
    expect(() =>
      decodeOnboardingProfileWrite({
        ...validWrite,
        primary_use_case: "conversation search",
      }),
    ).toThrow();
  });

  test("decodes a completed profile and rejects extra identity fields", () => {
    const profile = {
      completed_at: "2026-08-13T12:00:00.000Z",
      created_at: "2026-08-13T12:00:00.000Z",
      intended_mcp_client: "chatgpt",
      primary_use_case: "summaries",
      research_call_interest: "not_sure",
      role: "founder_or_owner",
      updated_at: "2026-08-13T13:00:00.000Z",
      whatsapp_usage_context: "work",
    } as const;
    expect(decodeOnboardingProfile(profile)).toEqual(profile);
    expect(() =>
      decodeOnboardingProfile({
        ...profile,
        clerk_user_id: "user_example",
      }),
    ).toThrow();
  });
});
