import {
  ONBOARDING_INTENDED_MCP_CLIENTS,
  ONBOARDING_PRIMARY_USE_CASES,
  ONBOARDING_RESEARCH_CALL_INTERESTS,
  ONBOARDING_ROLES,
  ONBOARDING_WHATSAPP_USAGE_CONTEXTS,
  type OnboardingProfileWrite,
} from "@whatsapp-mcp/contracts/onboarding-profile";
import type { OnboardingProfile } from "@whatsapp-mcp/db/onboarding-profile";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  HumanIdentity,
  InvalidHumanIdentity,
} from "../src/auth/human-identity";
import {
  createOnboardingProfileHandler,
  OnboardingProfileClock,
  OnboardingProfilePersistence,
  OnboardingProfilePersistenceError,
  type OnboardingProfilePersistenceService,
} from "../src/onboarding-profile";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const browserOrigin = "https://app.example.test";
const endpoint =
  "https://api.example.test/v1/personal-account/onboarding-profile";
const clerkUserId = "user_2RfWKJREkjKbHZy0Wqa5qrHeAnb";

const validBody: OnboardingProfileWrite = {
  intended_mcp_client: "claude",
  primary_use_case: "conversation_search",
  research_call_interest: "yes",
  role: "engineer",
  whatsapp_usage_context: "personal",
};

const makeHarness = (
  options: {
    readonly deleted?: boolean;
    readonly identityValid?: boolean;
    readonly persistenceFailure?: boolean;
  } = {},
) => {
  const profiles = new Map<string, OnboardingProfile>();
  const events: Array<SafeTelemetryEvent> = [];

  const persistence: OnboardingProfilePersistenceService = {
    get: ({ clerkUserId: requested }) =>
      options.persistenceFailure
        ? Effect.fail(new OnboardingProfilePersistenceError())
        : Effect.sync(() => {
            if (options.deleted) return { accessible: false as const };
            return {
              accessible: true as const,
              profile: profiles.get(requested) ?? null,
            };
          }),
    markSecurityCompleted: (input) =>
      options.persistenceFailure
        ? Effect.fail(new OnboardingProfilePersistenceError())
        : Effect.sync(() => {
            const existing = profiles.get(input.clerkUserId);
            if (options.deleted || existing === undefined) return null;
            const profile = {
              ...existing,
              securityCompletedAt:
                existing.securityCompletedAt ?? input.completedAt,
            };
            profiles.set(input.clerkUserId, profile);
            return profile;
          }),
    upsert: (input) =>
      options.persistenceFailure
        ? Effect.fail(new OnboardingProfilePersistenceError())
        : Effect.sync(() => {
            if (options.deleted) return null;
            const existing = profiles.get(input.clerkUserId);
            const profile: OnboardingProfile = {
              completedAt: existing?.completedAt ?? input.updatedAt,
              createdAt: existing?.createdAt ?? input.updatedAt,
              intendedMcpClient: input.intendedMcpClient,
              primaryUseCase: input.primaryUseCase,
              researchCallInterest: input.researchCallInterest,
              role: input.role,
              securityCompletedAt: existing?.securityCompletedAt ?? null,
              updatedAt: input.updatedAt,
              whatsappUsageContext: input.whatsappUsageContext,
            };
            profiles.set(input.clerkUserId, profile);
            return profile;
          }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: (request) =>
        options.identityValid === false ||
        request.headers.get("authorization") !== "Bearer signed-clerk-token"
          ? Effect.fail(new InvalidHumanIdentity())
          : Effect.succeed(clerkUserId),
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(OnboardingProfilePersistence, persistence),
    Layer.succeed(OnboardingProfileClock, {
      now: Effect.succeed("2026-08-13T12:00:00.000Z"),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    }),
  );

  return {
    events,
    handler: createOnboardingProfileHandler(layer, browserOrigin),
    profiles,
  };
};

const request = (
  method: "GET" | "PATCH" | "PUT" | "POST",
  overrides: {
    readonly authorization?: string | undefined;
    readonly body?: unknown;
    readonly origin?: string | undefined;
  } = {},
) =>
  new Request(endpoint, {
    body: overrides.body === undefined ? null : JSON.stringify(overrides.body),
    headers: {
      authorization: overrides.authorization ?? "Bearer signed-clerk-token",
      "content-type": "application/json",
      origin: overrides.origin ?? browserOrigin,
    },
    method,
  });

describe("Onboarding profile HTTP boundary", () => {
  test("reads null, upserts, and returns the normalized profile", async () => {
    const harness = makeHarness();

    const empty = await harness.handler(request("GET"));
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(empty.headers.get("access-control-allow-origin")).toBe(
      browserOrigin,
    );
    await expect(empty.json()).resolves.toEqual({ profile: null });

    const created = await harness.handler(request("PUT", { body: validBody }));
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toEqual({
      profile: {
        completed_at: "2026-08-13T12:00:00.000Z",
        created_at: "2026-08-13T12:00:00.000Z",
        intended_mcp_client: "claude",
        primary_use_case: "conversation_search",
        research_call_interest: "yes",
        role: "engineer",
        security_completed_at: null,
        updated_at: "2026-08-13T12:00:00.000Z",
        whatsapp_usage_context: "personal",
      },
    });
    expect(harness.events).toEqual([
      {
        event: "onboarding_profile.upsert.completed",
        outcome: "success",
        service: "api",
      },
    ]);

    const securityCompleted = await harness.handler(
      request("PATCH", { body: { security_completed: true } }),
    );
    expect(securityCompleted.status).toBe(200);
    await expect(securityCompleted.json()).resolves.toMatchObject({
      profile: {
        security_completed_at: "2026-08-13T12:00:00.000Z",
      },
    });

    const updated = await harness.handler(
      request("PUT", {
        body: { ...validBody, intended_mcp_client: "chatgpt" },
      }),
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      profile: {
        completed_at: "2026-08-13T12:00:00.000Z",
        intended_mcp_client: "chatgpt",
      },
    });
  });

  test("accepts every allowed enum value", async () => {
    const bodies: Array<OnboardingProfileWrite> = [
      ...ONBOARDING_PRIMARY_USE_CASES.map((primary_use_case) => ({
        ...validBody,
        primary_use_case,
      })),
      ...ONBOARDING_WHATSAPP_USAGE_CONTEXTS.map((whatsapp_usage_context) => ({
        ...validBody,
        whatsapp_usage_context,
      })),
      ...ONBOARDING_ROLES.map((role) => ({ ...validBody, role })),
      ...ONBOARDING_INTENDED_MCP_CLIENTS.map((intended_mcp_client) => ({
        ...validBody,
        intended_mcp_client,
      })),
      ...ONBOARDING_RESEARCH_CALL_INTERESTS.map((research_call_interest) => ({
        ...validBody,
        research_call_interest,
      })),
    ];
    for (const body of bodies) {
      const harness = makeHarness();
      const response = await harness.handler(request("PUT", { body }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        profile: body,
      });
    }
  });

  test("rejects malformed and extra fields with constant invalid_request", async () => {
    const harness = makeHarness();
    const malformed = await harness.handler(
      request("PUT", {
        body: { ...validBody, extra: true },
      }),
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: "invalid_request",
    });

    const invalidEnum = await harness.handler(
      request("PUT", {
        body: { ...validBody, role: "wizard" },
      }),
    );
    expect(invalidEnum.status).toBe(400);
    const invalidSecurity = await harness.handler(
      request("PATCH", { body: { security_completed: false } }),
    );
    expect(invalidSecurity.status).toBe(400);
  });

  test("keeps constant-shape not_found for inaccessible accounts and invalid identity", async () => {
    const deleted = makeHarness({ deleted: true });
    const deletedResponse = await deleted.handler(request("GET"));
    expect(deletedResponse.status).toBe(404);
    await expect(deletedResponse.json()).resolves.toEqual({
      error: "not_found",
    });

    const invalid = makeHarness({ identityValid: false });
    const invalidResponse = await invalid.handler(request("GET"));
    expect(invalidResponse.status).toBe(404);
    await expect(invalidResponse.json()).resolves.toEqual({
      error: "not_found",
    });
  });

  test("fails closed when persistence is unavailable", async () => {
    const harness = makeHarness({ persistenceFailure: true });
    const response = await harness.handler(request("GET"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
  });

  test("rejects origin mismatch without granting CORS", async () => {
    const harness = makeHarness();
    const response = await harness.handler(
      request("GET", { origin: "https://evil.example.test" }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
