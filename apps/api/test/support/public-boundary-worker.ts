import { Effect, Layer } from "effect";
import {
  HumanIdentity,
  InvalidHumanIdentity as InvalidHumanIdentityRequest,
} from "../../src/auth/human-identity";
import { EnvelopeEncryptionService } from "../../src/encryption/envelope";
import type { Env } from "../../src/index";
import {
  PersonalAccountIdentifiers,
  PersonalAccountPersistence,
  PrivateBetaConfig,
} from "../../src/personal-account";
import { createProductionHandler } from "../../src/production";
import {
  BoundaryClock,
  BoundaryIdentifiers,
  BoundaryIdentity,
  BoundaryProvider,
  BoundaryResource,
  ControlledBoundaryFailure,
  InvalidBoundaryIdentity,
} from "../../src/public-boundary";
import { createPublicBoundaryWorker } from "../../src/public-boundary-worker";
import { SafeTelemetry } from "../../src/services";

const TEST_LAYER_SENTINEL = "TEST_LAYER_SENTINEL_DO_NOT_INCLUDE_IN_PRODUCTION";
const TEST_FAULT_INJECTOR_SENTINEL =
  "TEST_FAULT_INJECTOR_DO_NOT_INCLUDE_IN_PRODUCTION";

const browserOrigin = "http://127.0.0.1:3000";
const personalAccounts = new Map<string, string>();

type FailureTarget = "identity" | "provider";

const failWhenSelected = (
  selected: FailureTarget | undefined,
  target: FailureTarget,
) =>
  selected === target
    ? Effect.fail(new ControlledBoundaryFailure({ target }))
    : Effect.void;

const makeTestLayer = (failure: FailureTarget | undefined) => {
  void TEST_LAYER_SENTINEL;
  void TEST_FAULT_INJECTOR_SENTINEL;

  return Layer.mergeAll(
    Layer.succeed(BoundaryIdentity, {
      verify: (authorization) =>
        Effect.gen(function* () {
          yield* failWhenSelected(failure, "identity");
          if (authorization !== "Bearer signed-test-user") {
            return yield* Effect.fail(new InvalidBoundaryIdentity());
          }
          return "user_test_public_boundary";
        }),
    }),
    Layer.succeed(HumanIdentity, {
      verify: (request) => {
        const authorization = request.headers.get("authorization");
        if (authorization === "Bearer signed-test-user") {
          return Effect.succeed("user_test_public_boundary");
        }
        if (authorization === "Bearer signed-waitlisted-user") {
          return Effect.succeed("user_waitlisted_public_boundary");
        }
        return Effect.fail(new InvalidHumanIdentityRequest());
      },
    }),
    Layer.succeed(BoundaryProvider, {
      observeConnection: failWhenSelected(failure, "provider").pipe(
        Effect.as("connected" as const),
      ),
    }),
    Layer.succeed(BoundaryClock, {
      now: Effect.succeed("2026-01-02T03:04:05.000Z"),
    }),
    Layer.succeed(BoundaryIdentifiers, {
      authorizationCode: Effect.succeed("oauth_test_code"),
      connection: Effect.succeed("con_0123456789abcdefghijk"),
    }),
    Layer.succeed(BoundaryResource, {
      read: Effect.succeed(new TextEncoder().encode("protected boundary")),
    }),
    Layer.succeed(PersonalAccountIdentifiers, {
      next: Effect.succeed("10000000-0000-4000-8000-000000000018"),
    }),
    Layer.succeed(PrivateBetaConfig, {
      providerApprovedSessionCapacity: 3,
    }),
    Layer.succeed(PersonalAccountPersistence, {
      create: (input) =>
        Effect.sync(() => {
          if (input.clerkUserId === "user_waitlisted_public_boundary") {
            return { admissionState: "waitlisted" as const };
          }
          const existing = personalAccounts.get(input.clerkUserId);
          if (existing) {
            return {
              admissionState: "active" as const,
              created: false,
              messageRetentionDays: 30,
              personalAccountId: existing,
              storedMediaLimitBytes: 5_368_709_120,
              whatsappConnectionLimit: 3,
            };
          }
          personalAccounts.set(input.clerkUserId, input.personalAccountId);
          return {
            admissionState: "active" as const,
            created: true,
            messageRetentionDays: 30,
            personalAccountId: input.personalAccountId,
            storedMediaLimitBytes: 5_368_709_120,
            whatsappConnectionLimit: 3,
          };
        }),
      resolve: (clerkUserId) =>
        Effect.sync(() => {
          if (clerkUserId === "user_waitlisted_public_boundary") {
            return { admissionState: "waitlisted" as const };
          }
          const existing = personalAccounts.get(clerkUserId);
          return existing
            ? {
                admissionState: "active" as const,
                keyAvailable: true,
                messageRetentionDays: 30,
                personalAccountId: existing,
                storedMediaLimitBytes: 5_368_709_120,
                whatsappConnectionLimit: 3,
              }
            : null;
        }),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createPersonalAccountKey: ({ accountId, keyVersion }) =>
        Effect.succeed({
          ciphertext: "AQID",
          keyVersion,
          kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
          personalAccountId: accountId,
          version: 1 as const,
        }),
      createConnectionKey: () => Effect.die("not used"),
      decrypt: () => Effect.die("not used"),
      encrypt: () => Effect.die("not used"),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: () => Effect.void,
    }),
  );
};

const selectedFailure = (request: Request): FailureTarget | undefined => {
  const value = request.headers.get("x-test-failure");
  return value === "identity" || value === "provider" ? value : undefined;
};

const worker = createPublicBoundaryWorker({
  browserOrigin,
  fallback: (request, environment) =>
    createProductionHandler(environment as Env)(request),
  layerFor: (request) => makeTestLayer(selectedFailure(request)),
});

export default worker;
