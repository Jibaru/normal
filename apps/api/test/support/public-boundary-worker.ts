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
import {
  WhatsAppConnectionClock,
  WhatsAppConnectionIdentifiers,
  WhatsAppConnectionPersistence,
  WhatsAppConnectionProvider,
} from "../../src/whatsapp-connection";

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
      readonly state: "provisioning_pending";
    };
  }
>();
let nextConnectionSetupId = 0;
const provisioningLeases = new Map<string, string>();
const provisionedSetups = new Set<string>();
const providerObservations: string[] = [];
const qrObservations = new Map<string, number>();
const whatsAppConnections: Array<{
  readonly displayName: null;
  readonly numberSuffix: string;
  readonly publicId: string;
  readonly state: "connected";
  readonly stateChangedAt: string;
}> = [];

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
    Layer.succeed(ConnectionSetupPersistence, {
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
    Layer.succeed(WhatsAppConnectionClock, {
      now: Effect.succeed("2026-01-02T03:06:00.000Z"),
    }),
    Layer.succeed(WhatsAppConnectionIdentifiers, {
      nextConnectionId: Effect.succeed("20000000-0000-4000-8000-000000000018"),
      nextPublicId: Effect.succeed("con_000000000000000000018"),
      nextWebhookIngressId: Effect.succeed(
        "30000000-0000-4000-8000-000000000018",
      ),
      nextWebhookSecret: Effect.succeed(new Uint8Array(32).fill(18)),
    }),
    Layer.succeed(WhatsAppConnectionPersistence, {
      activate: (input) =>
        Effect.sync(() => {
          const existing = whatsAppConnections[0];
          if (existing !== undefined) return existing;
          const connection = {
            displayName: null,
            numberSuffix: input.numberSuffix,
            publicId: input.publicId,
            state: "connected" as const,
            stateChangedAt: input.connectedAt,
          };
          whatsAppConnections.push(connection);
          return connection;
        }),
      list: (clerkUserId) =>
        Effect.succeed(
          clerkUserId === "user_test_public_boundary"
            ? whatsAppConnections
            : [],
        ),
      loadSetup: ({ clerkUserId, setupId }) =>
        Effect.sync(() => {
          if (clerkUserId !== "user_test_public_boundary") return null;
          const exists = [...connectionSetups.values()].some(
            ({ setup }) => setup.setupId === setupId,
          );
          if (!exists) return null;
          const connection = whatsAppConnections[0];
          if (connection !== undefined) {
            return { connection, outcome: "activated" as const };
          }
          return {
            outcome: "provisioned" as const,
            setup: {
              accountKey: {
                ciphertext: "AQID",
                keyVersion: 1,
                kmsKeyId:
                  "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
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
              setupKey: {
                accountKeyVersion: 1,
                ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                connectionId: setupId,
                keyVersion: 1,
                nonce: "AQIDBAUGBwgJCgsM",
                personalAccountId: "10000000-0000-4000-8000-000000000018",
                version: 1 as const,
              },
            },
          };
        }),
    }),
    Layer.succeed(WhatsAppConnectionProvider, {
      connect: () =>
        Effect.sync(() => {
          providerObservations.push("connectSession");
          return {
            ok: true as const,
            value: {
              authority: "test-session-authority",
              connectionState: "connecting" as const,
              session: "wsl_0000000000000000000000000000000000000000000",
            },
          };
        }),
      getQrCode: ({ session }) =>
        Effect.sync(() => {
          providerObservations.push("getQrCode");
          qrObservations.set(session, (qrObservations.get(session) ?? 0) + 1);
          return {
            ok: true as const,
            value: {
              expiresAt: null,
              image: new TextEncoder().encode(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
              ),
              state: "available" as const,
            },
          };
        }),
      reconcile: () =>
        Effect.sync(() => {
          providerObservations.push("reconcileSession");
          const session = "wsl_0000000000000000000000000000000000000000000";
          return {
            ok: true as const,
            value: {
              outcome: "present" as const,
              session: {
                authority: "test-session-authority",
                connectionState:
                  (qrObservations.get(session) ?? 0) > 0
                    ? ("connected" as const)
                    : ("disconnected" as const),
                session,
              },
            },
          };
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
    new URL(request.url).pathname === "/test/provider-observations"
      ? Promise.resolve(
          new Response(JSON.stringify(providerObservations), {
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json; charset=utf-8",
            },
          }),
        )
      : createProductionHandler(environment as Env)(request),
  layerFor: (request) => makeTestLayer(selectedFailure(request)),
  provisioningLayer: makeTestLayer(undefined),
});

export default worker;
