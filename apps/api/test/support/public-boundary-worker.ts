import { Effect, Layer } from "effect";
import {
  HumanIdentity,
  InvalidHumanIdentity as InvalidHumanIdentityRequest,
} from "../../src/auth/human-identity";
import {
  ConnectionSetupClock,
  ConnectionSetupIdentifiers,
  ConnectionSetupNumberTokens,
  ConnectionSetupPersistence,
} from "../../src/connection-setup";
import {
  ConnectionSetupProvisioningClock,
  ConnectionSetupProvisioningIdentifiers,
  ConnectionSetupProvisioningPersistence,
  ConnectionSetupProvisioningProvider,
  ConnectionSetupProvisioningQueue,
} from "../../src/connection-setup-provisioning";
import { EnvelopeEncryptionService } from "../../src/encryption/envelope";
import type { Env } from "../../src/index";
import {
  McpAuthorizationClock,
  McpAuthorizationPersistence,
} from "../../src/mcp-authorization";
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
const connectionSetups = new Map<
  string,
  {
    readonly numberToken: string;
    readonly setup: {
      readonly createdAt: string;
      readonly expiresAt: string;
      readonly setupId: string;
      readonly state: "cancelled" | "expired" | "provisioning_pending";
    };
  }
>();
let nextConnectionSetupId = 0;
const provisioningLeases = new Map<string, string>();
const provisionedSetups = new Set<string>();
let authorizationRevokedAt: Date | null = null;
const testAuthorizationId = "mca_123456789012345678901";

const tokenKey = (value: Uint8Array) => Array.from(value).join(",");

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
      verifyRecently: () => Effect.die("not used"),
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
    Layer.succeed(ConnectionSetupClock, {
      now: Effect.succeed("2026-01-02T03:04:05.000Z"),
    }),
    Layer.succeed(ConnectionSetupIdentifiers, {
      next: Effect.sync(() => {
        nextConnectionSetupId += 1;
        return `cst_${String(nextConnectionSetupId).padStart(21, "0")}`;
      }),
    }),
    Layer.succeed(ConnectionSetupNumberTokens, {
      derive: (number) =>
        Effect.succeed(
          new Uint8Array(32).map(
            (_, index) => number.charCodeAt(index % number.length) % 256,
          ),
        ),
    }),
    Layer.succeed(ConnectionSetupProvisioningQueue, {
      enqueue: () => Effect.void,
      enqueueCleanup: () => Effect.void,
    }),
    Layer.succeed(ConnectionSetupProvisioningClock, {
      now: Effect.succeed("2026-01-02T03:05:00.000Z"),
    }),
    Layer.succeed(ConnectionSetupProvisioningIdentifiers, {
      nextWorkerId: Effect.succeed(
        "cspw_0000000000000000000000000000000000000000000",
      ),
    }),
    Layer.succeed(ConnectionSetupProvisioningPersistence, {
      claim: ({ setupId, workerId }) =>
        Effect.sync(() => {
          if (provisionedSetups.has(setupId)) {
            return { outcome: "not_pending" as const };
          }
          if (provisioningLeases.has(setupId)) {
            return { outcome: "leased" as const };
          }
          provisioningLeases.set(setupId, workerId);
          return {
            outcome: "claimed" as const,
            setup: {
              accountKey: {
                ciphertext: "AQID",
                keyVersion: 1,
                kmsKeyId:
                  "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
                personalAccountId: "10000000-0000-4000-8000-000000000018",
                version: 1 as const,
              },
              connectionKey: {
                accountKeyVersion: 1,
                ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                connectionId: setupId,
                keyVersion: 1,
                nonce: "AQIDBAUGBwgJCgsM",
                personalAccountId: "10000000-0000-4000-8000-000000000018",
                version: 1 as const,
              },
              numberCiphertext: {
                ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                keyVersion: 1,
                nonce: "AQIDBAUGBwgJCgsM",
                version: 1 as const,
              },
              personalAccountId: "10000000-0000-4000-8000-000000000018",
              setupId,
            },
          };
        }),
      finish: ({ setupId, workerId }) =>
        Effect.sync(() => {
          if (provisioningLeases.get(setupId) !== workerId) return false;
          provisioningLeases.delete(setupId);
          provisionedSetups.add(setupId);
          return true;
        }),
      fail: ({ setupId, workerId }) =>
        Effect.sync(() => {
          if (provisioningLeases.get(setupId) !== workerId) return false;
          provisioningLeases.delete(setupId);
          provisionedSetups.add(setupId);
          return true;
        }),
      listCandidates: () => Effect.succeed([]),
      release: ({ setupId, workerId }) =>
        Effect.sync(() => {
          if (provisioningLeases.get(setupId) !== workerId) return false;
          provisioningLeases.delete(setupId);
          return true;
        }),
      renew: ({ setupId, workerId }) =>
        Effect.sync(() => provisioningLeases.get(setupId) === workerId),
    }),
    Layer.succeed(ConnectionSetupProvisioningProvider, {
      create: () =>
        Effect.succeed({
          ok: true as const,
          value: {
            authority: "test-session-authority",
            connectionState: "disconnected" as const,
            session: "wsl_0000000000000000000000000000000000000000000",
          },
        }),
      reconcile: () =>
        Effect.succeed({
          ok: true as const,
          value: { outcome: "absent" as const },
        }),
    }),
    Layer.succeed(McpAuthorizationClock, {
      now: Effect.succeed(new Date("2026-01-02T03:05:00.000Z")),
    }),
    Layer.succeed(McpAuthorizationPersistence, {
      create: () => Effect.die("not used"),
      isActive: () => Effect.succeed(authorizationRevokedAt === null),
      list: (clerkUserId) =>
        Effect.succeed(
          clerkUserId === "user_test_public_boundary"
            ? [
                {
                  authorizationId: testAuthorizationId,
                  authorizedAt: new Date("2026-01-01T03:05:00.000Z"),
                  clientClass: "approved",
                  clientId: "approved-client",
                  clientName: "Approved MCP Client",
                  connectionIds: ["con_123456789012345678901"],
                  expired: false,
                  expiresAt: new Date("2026-04-01T03:05:00.000Z"),
                  revoked: authorizationRevokedAt !== null,
                  revokedAt: authorizationRevokedAt,
                  scopes: ["connections:read", "messages:send"] as const,
                },
              ]
            : [],
        ),
      listConnections: () => Effect.succeed([]),
      registerRefreshCredential: () => Effect.die("not used"),
      revoke: ({ authorizationId, clerkUserId, revokedAt }) =>
        Effect.sync(() => {
          if (
            clerkUserId !== "user_test_public_boundary" ||
            authorizationId !== testAuthorizationId
          ) {
            return null;
          }
          authorizationRevokedAt ??= revokedAt;
          return { revokedAt: authorizationRevokedAt };
        }),
      rotateRefreshCredential: () => Effect.die("not used"),
    }),
    Layer.succeed(ConnectionSetupPersistence, {
      cancel: ({ clerkUserId, setupId }) =>
        Effect.sync(() => {
          if (clerkUserId !== "user_test_public_boundary") return null;
          const entry = [...connectionSetups.entries()].find(
            ([, value]) => value.setup.setupId === setupId,
          );
          if (entry === undefined) return null;
          const [idempotencyKey, value] = entry;
          const replay =
            value.setup.state === "cancelled" ||
            value.setup.state === "expired";
          const state =
            value.setup.state === "expired" ? "expired" : "cancelled";
          connectionSetups.set(idempotencyKey, {
            ...value,
            setup: { ...value.setup, state },
          });
          return {
            cleanupState: "pending" as const,
            outcome: replay ? ("replay" as const) : ("cancelled" as const),
            setupId,
            state,
          };
        }),
      prepare: ({ idempotencyKey, numberToken }) =>
        Effect.sync(() => {
          const existing = connectionSetups.get(idempotencyKey);
          if (existing !== undefined) {
            return existing.numberToken === tokenKey(numberToken)
              ? { outcome: "replay" as const, setup: existing.setup }
              : { outcome: "idempotency_conflict" as const };
          }
          return {
            accountKey: {
              ciphertext: "AQID",
              keyVersion: 1,
              kmsKeyId:
                "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
              personalAccountId: "10000000-0000-4000-8000-000000000018",
              version: 1 as const,
            },
            outcome: "unbound" as const,
            whatsappConnectionLimit: 3,
          };
        }),
      start: (input) =>
        Effect.sync(() => {
          const existing = connectionSetups.get(input.idempotencyKey);
          if (existing !== undefined) {
            return existing.numberToken === tokenKey(input.numberToken)
              ? { outcome: "replay" as const, setup: existing.setup }
              : { outcome: "idempotency_conflict" as const };
          }
          const setup = {
            createdAt: input.createdAt,
            expiresAt: "2026-01-02T03:19:05.000Z",
            setupId: input.setupId,
            state: "provisioning_pending" as const,
          };
          connectionSetups.set(input.idempotencyKey, {
            numberToken: tokenKey(input.numberToken),
            setup,
          });
          return { outcome: "created" as const, setup };
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
      createConnectionKey: ({ accountId, connectionId, keyVersion }) =>
        Effect.succeed({
          accountKeyVersion: 1,
          ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
          connectionId,
          keyVersion,
          nonce: "AQIDBAUGBwgJCgsM",
          personalAccountId: accountId,
          version: 1 as const,
        }),
      decrypt: ({ context }) =>
        context.fieldOrObjectPurpose === "whatsapp-number"
          ? Effect.succeed(new TextEncoder().encode("+15550123456"))
          : Effect.die("not used"),
      encrypt: () =>
        Effect.succeed({
          ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
          keyVersion: 1,
          nonce: "AQIDBAUGBwgJCgsM",
          version: 1 as const,
        }),
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
  provisioningLayer: makeTestLayer(undefined),
});

export default worker;
