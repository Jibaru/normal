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
  ConnectionSetupProvisioningWebhook,
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
import {
  WebhookEventClock,
  WebhookEventObjectStore,
  WebhookEventObjectStoreError,
  WebhookEventPersistence,
  WebhookEventPersistenceError,
  WebhookEventRetrySchedule,
  wasenderWebhookEventNormalizationLayer,
} from "../../src/webhook-event";
import {
  WebhookIngressClock,
  WebhookIngressIdentifiers,
  WebhookIngressObjectStore,
  WebhookIngressObjectStoreError,
  WebhookIngressPersistence,
  WebhookIngressPersistenceError,
  WebhookIngressQueue,
  WebhookIngressQueueError,
  type WebhookIngressQueueMessage,
} from "../../src/webhook-ingress";
import {
  WebhookRecoveryCheckpoint,
  WebhookRecoveryCheckpointError,
  WebhookRecoveryObjectStore,
  WebhookRecoveryObjectStoreError,
  WebhookRecoveryPersistence,
} from "../../src/webhook-recovery";
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
      readonly state: "cancelled" | "expired" | "provisioning_pending";
    };
  }
>();
let nextConnectionSetupId = 0;
const provisioningLeases = new Map<string, string>();
const provisionedSetups = new Set<string>();
let authorizationRevokedAt: Date | null = null;
const testAuthorizationId = "mca_123456789012345678901";
const providerObservations: string[] = [];
const qrObservations = new Map<string, number>();
let providerConnectionState:
  | "connected"
  | "connecting"
  | "disconnected"
  | "reconnect_required"
  | "degraded" = "disconnected";
let lifecycleClaimId: string | null = null;
const whatsAppConnections: Array<{
  displayName: null;
  numberSuffix: string;
  publicId: string;
  state:
    | "connected"
    | "connecting"
    | "degraded"
    | "disconnected"
    | "reconnect_required";
  stateChangedAt: string;
}> = [];
const publishedWebhookMessages: WebhookIngressQueueMessage[] = [];
const encryptedWebhookPayloads = new Map<string, Uint8Array>();
const claimedWebhookItems = new Set<string>();
const claimedWebhookEvents = new Set<string>();
const deadLetteredWebhookEvents = new Set<string>();
let projectedConnectionStateVersion: string | null = null;
let projectedConnectionStateReceivedAt: string | null = null;
let nextWebhookObjectId = 0;

const tokenKey = (value: Uint8Array) => Array.from(value).join(",");

type FailureTarget =
  | "identity"
  | "provider"
  | "webhook-database"
  | "webhook-queue"
  | "webhook-r2";

const failWhenSelected = (
  selected: FailureTarget | undefined,
  target: "identity" | "provider",
) =>
  selected === target
    ? Effect.fail(new ControlledBoundaryFailure({ target }))
    : Effect.void;

const makeTestLayer = (
  failure: FailureTarget | undefined,
  environment?: {
    readonly INGESTION_QUEUE: Queue;
    readonly OAUTH_KV: KVNamespace;
    readonly WEBHOOK_INGRESS: R2Bucket;
  },
) => {
  void TEST_LAYER_SENTINEL;
  void TEST_FAULT_INJECTOR_SENTINEL;

  return Layer.mergeAll(
    wasenderWebhookEventNormalizationLayer,
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
    Layer.succeed(ConnectionSetupProvisioningWebhook, {
      urlFor: (webhookIngressId) =>
        Effect.succeed(
          `https://api.example.test/webhooks/wasender/${webhookIngressId}`,
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
              webhookIngressId: "30000000-0000-4000-8000-000000000018",
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
    Layer.succeed(WhatsAppConnectionClock, {
      now: Effect.succeed("2026-01-02T03:06:00.000Z"),
    }),
    Layer.succeed(WhatsAppConnectionIdentifiers, {
      nextConnectionId: Effect.succeed("20000000-0000-4000-8000-000000000018"),
      nextLifecycleClaimId: Effect.succeed(
        "40000000-0000-4000-8000-000000000018",
      ),
      nextPublicId: Effect.succeed("con_000000000000000000018"),
      nextWebhookIdentityKey: Effect.succeed(new Uint8Array(32).fill(18)),
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
      claimLifecycle: ({
        action,
        claimId,
        clerkUserId,
        publicId,
        requestedAt,
      }) =>
        Effect.sync(() => {
          const connection = whatsAppConnections.find(
            (candidate) =>
              clerkUserId === "user_test_public_boundary" &&
              candidate.publicId === publicId,
          );
          if (connection === undefined) return null;
          const target = action === "disconnect" ? "disconnected" : "connected";
          if (connection.state === target) {
            return {
              connection: { ...connection },
              outcome: "complete" as const,
            };
          }
          if (lifecycleClaimId !== null) {
            return {
              connection: { ...connection },
              outcome: "in_progress" as const,
            };
          }
          lifecycleClaimId = claimId;
          connection.state =
            action === "disconnect" ? "degraded" : "connecting";
          connection.stateChangedAt = requestedAt;
          return {
            action,
            connection: { ...connection },
            outcome: "claimed" as const,
            setupMarker: [...connectionSetups.values()][0]?.setup.setupId ?? "",
          };
        }),
      finishLifecycle: ({
        claimId,
        clerkUserId,
        observedAt,
        publicId,
        state,
      }) =>
        Effect.sync(() => {
          const connection = whatsAppConnections.find(
            (candidate) =>
              clerkUserId === "user_test_public_boundary" &&
              candidate.publicId === publicId,
          );
          if (
            connection === undefined ||
            lifecycleClaimId === null ||
            lifecycleClaimId !== claimId
          ) {
            return null;
          }
          lifecycleClaimId = null;
          if (connection.state !== state) {
            connection.state = state;
            connection.stateChangedAt = observedAt;
          }
          return { ...connection };
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
              webhookIngressId: "30000000-0000-4000-8000-000000000018",
            },
          };
        }),
    }),
    Layer.succeed(WhatsAppConnectionProvider, {
      connect: () =>
        Effect.sync(() => {
          providerObservations.push("connectSession");
          providerConnectionState = "connecting";
          return {
            ok: true as const,
            value: {
              authority: "test-session-authority",
              connectionState: "connecting" as const,
              session: "wsl_0000000000000000000000000000000000000000000",
            },
          };
        }),
      disconnect: () =>
        Effect.sync(() => {
          providerObservations.push("disconnectSession");
          providerConnectionState = "disconnected";
          return {
            ok: true as const,
            value: {
              authority: "test-session-authority",
              connectionState: "disconnected" as const,
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
          if (
            providerConnectionState === "connecting" &&
            (qrObservations.get(session) ?? 0) > 0
          ) {
            providerConnectionState = "connected";
          }
          return {
            ok: true as const,
            value: {
              outcome: "present" as const,
              session: {
                authority: "test-session-authority",
                connectionState: providerConnectionState,
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
          : context.fieldOrObjectPurpose === "provider-session-authority"
            ? Effect.succeed(
                new TextEncoder().encode(
                  JSON.stringify({
                    sessionCredential: "test-session-credential",
                    webhookVerificationSecret: "test-webhook-secret",
                  }),
                ),
              )
            : context.fieldOrObjectPurpose === "webhook-identity-key"
              ? Effect.succeed(new Uint8Array(32).fill(18))
              : context.fieldOrObjectPurpose === "original-request"
                ? Effect.sync(() => {
                    const payload = encryptedWebhookPayloads.get(
                      context.recordId,
                    );
                    if (payload === undefined) {
                      throw new Error("missing encrypted test payload");
                    }
                    return payload.slice();
                  })
                : Effect.die("not used"),
      encrypt: ({ context, plaintext }) =>
        Effect.sync(() => {
          if (
            context.entity === "webhook-event" &&
            context.fieldOrObjectPurpose === "original-request"
          ) {
            encryptedWebhookPayloads.set(context.recordId, plaintext.slice());
          }
          return {
            ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            version: 1 as const,
          };
        }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: () => Effect.void,
    }),
    Layer.succeed(WebhookIngressPersistence, {
      resolve: (webhookIngressId) =>
        failure === "webhook-database"
          ? Effect.fail(new WebhookIngressPersistenceError())
          : Effect.succeed(
              webhookIngressId === "30000000-0000-4000-8000-000000000018"
                ? {
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
                      connectionId: "20000000-0000-4000-8000-000000000018",
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      personalAccountId: "10000000-0000-4000-8000-000000000018",
                      version: 1 as const,
                    },
                    personalAccountId: "10000000-0000-4000-8000-000000000018",
                    providerAuthority: {
                      ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      version: 1 as const,
                    },
                    whatsappConnectionId:
                      "20000000-0000-4000-8000-000000000018",
                  }
                : null,
            ),
    }),
    Layer.succeed(WebhookIngressClock, {
      now: Effect.succeed("2026-01-02T03:07:00.000Z"),
    }),
    Layer.succeed(WebhookIngressIdentifiers, {
      nextObjectId: Effect.sync(() => {
        nextWebhookObjectId += 1;
        return `40000000-0000-4000-8000-${String(nextWebhookObjectId).padStart(
          12,
          "0",
        )}`;
      }),
    }),
    Layer.succeed(WebhookIngressObjectStore, {
      put: (object) =>
        failure === "webhook-r2" || environment === undefined
          ? Effect.fail(new WebhookIngressObjectStoreError())
          : Effect.tryPromise({
              try: () =>
                environment.WEBHOOK_INGRESS.put(object.objectKey, object.body, {
                  customMetadata: { ...object.customMetadata },
                }).then(() => undefined),
              catch: () => new WebhookIngressObjectStoreError(),
            }),
    }),
    Layer.succeed(WebhookIngressQueue, {
      publish: (message) =>
        failure === "webhook-queue" || environment === undefined
          ? Effect.fail(new WebhookIngressQueueError())
          : Effect.tryPromise({
              try: async () => {
                await environment.INGESTION_QUEUE.send(message);
                publishedWebhookMessages.push(message);
              },
              catch: () => new WebhookIngressQueueError(),
            }),
    }),
    Layer.succeed(WebhookEventClock, {
      now: Effect.succeed("2026-01-02T03:07:01.000Z"),
    }),
    Layer.succeed(WebhookEventRetrySchedule, {
      delaySeconds: () => Effect.succeed(10_123),
    }),
    Layer.succeed(WebhookEventObjectStore, {
      load: (objectId) =>
        environment === undefined
          ? Effect.fail(new WebhookEventObjectStoreError())
          : Effect.tryPromise({
              try: async () => {
                const object = await environment.WEBHOOK_INGRESS.get(
                  `webhook-events/${objectId}`,
                );
                if (object === null) return null;
                return {
                  body: new Uint8Array(await object.arrayBuffer()),
                  customMetadata: { ...(object.customMetadata ?? {}) },
                };
              },
              catch: () => new WebhookEventObjectStoreError(),
            }),
    }),
    Layer.succeed(WebhookRecoveryObjectStore, {
      list: (cursor) =>
        environment === undefined
          ? Effect.fail(new WebhookRecoveryObjectStoreError())
          : Effect.tryPromise({
              try: async () => {
                const listed = await environment.WEBHOOK_INGRESS.list({
                  ...(cursor === null ? {} : { cursor }),
                  include: ["customMetadata"],
                  limit: 100,
                  prefix: "webhook-events/",
                });
                return {
                  cursor: listed.truncated ? (listed.cursor ?? null) : null,
                  objects: listed.objects.map((object) => ({
                    customMetadata: { ...(object.customMetadata ?? {}) },
                    objectKey: object.key,
                    uploadedAt: object.uploaded.toISOString(),
                  })),
                };
              },
              catch: () => new WebhookRecoveryObjectStoreError(),
            }),
    }),
    Layer.succeed(WebhookRecoveryCheckpoint, {
      load:
        environment === undefined
          ? Effect.fail(new WebhookRecoveryCheckpointError())
          : Effect.tryPromise({
              try: () =>
                environment.OAUTH_KV.get("maintenance:webhook-recovery-cursor"),
              catch: () => new WebhookRecoveryCheckpointError(),
            }),
      save: (cursor) =>
        environment === undefined
          ? Effect.fail(new WebhookRecoveryCheckpointError())
          : Effect.tryPromise({
              try: () =>
                cursor === null
                  ? environment.OAUTH_KV.delete(
                      "maintenance:webhook-recovery-cursor",
                    )
                  : environment.OAUTH_KV.put(
                      "maintenance:webhook-recovery-cursor",
                      cursor,
                    ),
              catch: () => new WebhookRecoveryCheckpointError(),
            }),
    }),
    Layer.succeed(WebhookRecoveryPersistence, {
      filterUnclaimed: (messages) =>
        Effect.succeed(
          messages.filter(
            (message) => !claimedWebhookEvents.has(message.object_id),
          ),
        ),
    }),
    Layer.succeed(WebhookEventPersistence, {
      complete: () => Effect.void,
      deadLetter: (input) =>
        Effect.sync(() => {
          deadLetteredWebhookEvents.add(input.eventId);
          return "gap_recorded" as const;
        }),
      prepare: (input) =>
        Effect.sync(() => {
          claimedWebhookEvents.add(input.eventId);
          return input.personalAccountId ===
            "10000000-0000-4000-8000-000000000018" &&
            input.whatsappConnectionId ===
              "20000000-0000-4000-8000-000000000018"
            ? {
                accountKey: {
                  ciphertext: "AQID",
                  keyVersion: 1,
                  kmsKeyId:
                    "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
                  personalAccountId: input.personalAccountId,
                  version: 1 as const,
                },
                connectionKey: {
                  accountKeyVersion: 1,
                  ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                  connectionId: input.whatsappConnectionId,
                  keyVersion: 1,
                  nonce: "AQIDBAUGBwgJCgsM",
                  personalAccountId: input.personalAccountId,
                  version: 1 as const,
                },
                identityKey: {
                  ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                  keyVersion: 1,
                  nonce: "AQIDBAUGBwgJCgsM",
                  version: 1 as const,
                },
              }
            : null;
        }),
      projectConnectionState: (input, compareVersions) =>
        Effect.tryPromise({
          try: async () => {
            if (claimedWebhookItems.has(input.itemIdentity)) {
              return "duplicate" as const;
            }
            claimedWebhookItems.add(input.itemIdentity);
            let apply = projectedConnectionStateVersion === null;
            if (
              input.evidence.version !== null &&
              projectedConnectionStateVersion !== null
            ) {
              const comparison = await compareVersions(
                input.evidence.version,
                projectedConnectionStateVersion,
              );
              apply =
                comparison === "after" ||
                (comparison === "equal" &&
                  input.receivedAt >
                    (projectedConnectionStateReceivedAt ?? ""));
            } else if (input.evidence.version === null) {
              apply = projectedConnectionStateVersion === null;
            }
            if (!apply) return "superseded" as const;
            const connection = whatsAppConnections[0];
            if (connection === undefined) {
              throw new Error("missing test WhatsApp Connection");
            }
            if (connection.state !== input.state) {
              connection.state = input.state;
              connection.stateChangedAt =
                input.evidence.occurredAt ?? input.receivedAt;
            }
            projectedConnectionStateVersion = input.evidence.version;
            projectedConnectionStateReceivedAt = input.receivedAt;
            return "applied" as const;
          },
          catch: () => new WebhookEventPersistenceError(),
        }),
      quarantine: () => Effect.void,
    }),
  );
};

const selectedFailure = (request: Request): FailureTarget | undefined => {
  const value = request.headers.get("x-test-failure");
  return value === "identity" ||
    value === "provider" ||
    value === "webhook-database" ||
    value === "webhook-queue" ||
    value === "webhook-r2"
    ? value
    : undefined;
};

const worker = createPublicBoundaryWorker({
  browserOrigin,
  fallback: (request, environment) =>
    new URL(request.url).pathname === "/test/webhook-queue"
      ? Promise.resolve(
          new Response(JSON.stringify(publishedWebhookMessages), {
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json; charset=utf-8",
            },
          }),
        )
      : new URL(request.url).pathname === "/test/webhook-dead-letters"
        ? Promise.resolve(
            new Response(JSON.stringify([...deadLetteredWebhookEvents]), {
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json; charset=utf-8",
              },
            }),
          )
        : new URL(request.url).pathname === "/test/provider-observations"
          ? Promise.resolve(
              new Response(JSON.stringify(providerObservations), {
                headers: {
                  "cache-control": "no-store",
                  "content-type": "application/json; charset=utf-8",
                },
              }),
            )
          : createProductionHandler({
              ...environment,
              WEBHOOK_HYPERDRIVE: {
                connectionString:
                  "postgresql://webhook-runtime@hyperdrive.test/database",
              },
            } as Env)(request),
  layerFor: (request, environment) =>
    makeTestLayer(selectedFailure(request), environment),
  provisioningLayer: makeTestLayer(undefined),
  webhookEventLayer: (environment) => makeTestLayer(undefined, environment),
  webhookRecoveryLayer: (environment) => makeTestLayer(undefined, environment),
});

export default worker;
