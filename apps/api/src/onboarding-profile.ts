import {
  decodeOnboardingProfileWrite,
  decodeOnboardingSecurityCompletionWrite,
  type OnboardingProfileWrite,
} from "@whatsapp-mcp/contracts/onboarding-profile";
import type {
  OnboardingProfile,
  OnboardingProfileLookup,
} from "@whatsapp-mcp/db/onboarding-profile";
import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import { hasFailureTag } from "./failure-tag";
import { noStoreJsonResponse } from "./http-response";
import { hasExactKeys } from "./record";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const ONBOARDING_PROFILE_ROUTE = "/v1/personal-account/onboarding-profile";

export class OnboardingProfilePersistenceError extends Data.TaggedError(
  "OnboardingProfilePersistenceError",
) {}

export interface OnboardingProfilePersistenceService {
  readonly get: (input: {
    readonly clerkUserId: string;
  }) => Effect.Effect<
    OnboardingProfileLookup,
    OnboardingProfilePersistenceError
  >;
  readonly markSecurityCompleted: (input: {
    readonly clerkUserId: string;
    readonly completedAt: string;
  }) => Effect.Effect<
    OnboardingProfile | null,
    OnboardingProfilePersistenceError
  >;
  readonly upsert: (input: {
    readonly clerkUserId: string;
    readonly intendedMcpClient: OnboardingProfile["intendedMcpClient"];
    readonly primaryUseCase: OnboardingProfile["primaryUseCase"];
    readonly researchCallInterest: OnboardingProfile["researchCallInterest"];
    readonly role: OnboardingProfile["role"];
    readonly updatedAt: string;
    readonly whatsappUsageContext: OnboardingProfile["whatsappUsageContext"];
  }) => Effect.Effect<
    OnboardingProfile | null,
    OnboardingProfilePersistenceError
  >;
}

export const OnboardingProfilePersistence =
  Context.GenericTag<OnboardingProfilePersistenceService>(
    "@whatsapp-mcp/api/OnboardingProfilePersistence",
  );

export interface OnboardingProfileClockService {
  readonly now: Effect.Effect<string>;
}

export const OnboardingProfileClock =
  Context.GenericTag<OnboardingProfileClockService>(
    "@whatsapp-mcp/api/OnboardingProfileClock",
  );

type Requirements =
  | HumanIdentityService
  | OnboardingProfileClockService
  | OnboardingProfilePersistenceService
  | SafeTelemetryService;

const headers = (origin: string) => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,OPTIONS,PATCH,PUT",
  "access-control-allow-origin": origin,
  vary: "Origin",
});

const json = (body: unknown, status: number, origin?: string) =>
  noStoreJsonResponse(
    body,
    status,
    origin === undefined ? {} : headers(origin),
  );

const profileJson = (profile: OnboardingProfile) => ({
  completed_at: profile.completedAt,
  created_at: profile.createdAt,
  intended_mcp_client: profile.intendedMcpClient,
  primary_use_case: profile.primaryUseCase,
  research_call_interest: profile.researchCallInterest,
  role: profile.role,
  security_completed_at: profile.securityCompletedAt,
  updated_at: profile.updatedAt,
  whatsapp_usage_context: profile.whatsappUsageContext,
});

const decodeWriteBody = async (
  request: Request,
): Promise<OnboardingProfileWrite | null> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !hasExactKeys(body, [
      "intended_mcp_client",
      "primary_use_case",
      "research_call_interest",
      "role",
      "whatsapp_usage_context",
    ])
  ) {
    return null;
  }
  try {
    return decodeOnboardingProfileWrite(body);
  } catch {
    return null;
  }
};

const decodeSecurityCompletionBody = async (
  request: Request,
): Promise<boolean> => {
  try {
    decodeOnboardingSecurityCompletionWrite(await request.json());
    return true;
  } catch {
    return false;
  }
};

export const createOnboardingProfileHandler =
  (layer: Layer.Layer<Requirements, unknown>, browserOrigin: string) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.pathname !== ONBOARDING_PROFILE_ROUTE ||
      request.headers.get("origin") !== browserOrigin
    ) {
      return json({ error: "not_found" }, 404);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: headers(browserOrigin),
        status: 204,
      });
    }
    if (
      request.method !== "GET" &&
      request.method !== "PATCH" &&
      request.method !== "PUT"
    ) {
      return json({ error: "not_found" }, 404, browserOrigin);
    }

    let writeBody: OnboardingProfileWrite | null = null;
    if (request.method === "PUT") {
      writeBody = await decodeWriteBody(request);
      if (writeBody === null) {
        return json({ error: "invalid_request" }, 400, browserOrigin);
      }
    }
    if (
      request.method === "PATCH" &&
      !(await decodeSecurityCompletionBody(request))
    ) {
      return json({ error: "invalid_request" }, 400, browserOrigin);
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* HumanIdentity;
        const clerkUserId = yield* identity.verify(request);
        const persistence = yield* OnboardingProfilePersistence;
        if (request.method === "GET") {
          const lookup = yield* persistence.get({ clerkUserId });
          return { operation: "get" as const, lookup };
        }
        const clock = yield* OnboardingProfileClock;
        if (request.method === "PATCH") {
          const profile = yield* persistence.markSecurityCompleted({
            clerkUserId,
            completedAt: yield* clock.now,
          });
          return {
            operation: "security" as const,
            lookup:
              profile === null
                ? ({ accessible: false } as const)
                : ({ accessible: true, profile } as const),
          };
        }
        if (writeBody === null) {
          return yield* Effect.die("missing onboarding profile write");
        }
        const profile = yield* persistence.upsert({
          clerkUserId,
          intendedMcpClient: writeBody.intended_mcp_client,
          primaryUseCase: writeBody.primary_use_case,
          researchCallInterest: writeBody.research_call_interest,
          role: writeBody.role,
          updatedAt: yield* clock.now,
          whatsappUsageContext: writeBody.whatsapp_usage_context,
        });
        const telemetry = yield* SafeTelemetry;
        yield* telemetry.emit({
          event: "onboarding_profile.upsert.completed",
          outcome: profile === null ? "not_found" : "success",
          service: "api",
        });
        return {
          operation: "upsert" as const,
          lookup:
            profile === null
              ? ({ accessible: false } as const)
              : ({ accessible: true, profile } as const),
        };
      }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            hasFailureTag(failure, "InvalidHumanIdentity")
              ? json({ error: "not_found" }, 404, browserOrigin)
              : json({ error: "unavailable" }, 503, browserOrigin),
          onSuccess: (result) => {
            if (!result.lookup.accessible) {
              return json({ error: "not_found" }, 404, browserOrigin);
            }
            return json(
              {
                profile:
                  result.lookup.profile === null
                    ? null
                    : profileJson(result.lookup.profile),
              },
              200,
              browserOrigin,
            );
          },
        }),
      ),
    );
  };

export const isOnboardingProfileRequest = (request: Request): boolean =>
  new URL(request.url).pathname === ONBOARDING_PROFILE_ROUTE;
