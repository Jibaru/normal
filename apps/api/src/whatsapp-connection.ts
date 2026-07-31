import type {
  LifecycleSession,
  ProviderControlResult,
  QrCodeObservation,
  SessionReconciliation,
} from "@whatsapp-mcp/contracts/provider-control";
import type {
  ActivateWhatsAppConnectionInput,
  ConnectionSetupActivation,
  WhatsAppConnectionLifecycleAction,
  WhatsAppConnectionLifecycleClaim,
  WhatsAppConnectionRecord,
} from "@whatsapp-mcp/db/whatsapp-connection";
import type { WhatsAppConnectionState } from "@whatsapp-mcp/domain/whatsapp-connection";
import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import {
  type EncryptionError,
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const CONNECTIONS_ROUTE = "/v1/whatsapp-connections";
const qrRoutePattern =
  /^\/v1\/connection-setups\/(cst_[A-Za-z0-9_-]{21})\/qr$/u;
const lifecycleRoutePattern =
  /^\/v1\/whatsapp-connections\/(con_[A-Za-z0-9_-]{21})\/(disconnect|reconnect)$/u;

export class WhatsAppConnectionPersistenceError extends Data.TaggedError(
  "WhatsAppConnectionPersistenceError",
) {}

export class WhatsAppConnectionNotAccessible extends Data.TaggedError(
  "WhatsAppConnectionNotAccessible",
) {}

export class WhatsAppConnectionProviderError extends Data.TaggedError(
  "WhatsAppConnectionProviderError",
) {}

export class WhatsAppConnectionActivationError extends Data.TaggedError(
  "WhatsAppConnectionActivationError",
) {}

export interface WhatsAppConnectionPersistenceService {
  readonly activate: (
    input: ActivateWhatsAppConnectionInput,
  ) => Effect.Effect<
    WhatsAppConnectionRecord,
    WhatsAppConnectionPersistenceError
  >;
  readonly list: (
    clerkUserId: string,
  ) => Effect.Effect<
    ReadonlyArray<WhatsAppConnectionRecord>,
    WhatsAppConnectionPersistenceError
  >;
  readonly claimLifecycle: (input: {
    readonly action: WhatsAppConnectionLifecycleAction;
    readonly claimId: string;
    readonly clerkUserId: string;
    readonly publicId: string;
    readonly requestedAt: string;
  }) => Effect.Effect<
    WhatsAppConnectionLifecycleClaim | null,
    WhatsAppConnectionPersistenceError
  >;
  readonly finishLifecycle: (input: {
    readonly claimId: string;
    readonly clerkUserId: string;
    readonly observedAt: string;
    readonly publicId: string;
    readonly state: Exclude<WhatsAppConnectionState, "deleting">;
  }) => Effect.Effect<
    WhatsAppConnectionRecord | null,
    WhatsAppConnectionPersistenceError
  >;
  readonly loadSetup: (input: {
    readonly clerkUserId: string;
    readonly observedAt: string;
    readonly setupId: string;
  }) => Effect.Effect<
    ConnectionSetupActivation | null,
    WhatsAppConnectionPersistenceError
  >;
}

export const WhatsAppConnectionPersistence =
  Context.GenericTag<WhatsAppConnectionPersistenceService>(
    "@whatsapp-mcp/api/WhatsAppConnectionPersistence",
  );

export interface WhatsAppConnectionProviderService {
  readonly connect: (input: {
    readonly session: string;
  }) => Effect.Effect<ProviderControlResult<LifecycleSession>>;
  readonly disconnect: (input: {
    readonly session: string;
  }) => Effect.Effect<ProviderControlResult<LifecycleSession>>;
  readonly getQrCode: (input: {
    readonly session: string;
  }) => Effect.Effect<ProviderControlResult<QrCodeObservation>>;
  readonly reconcile: (input: {
    readonly setupMarker: string;
  }) => Effect.Effect<ProviderControlResult<SessionReconciliation>>;
}

export const WhatsAppConnectionProvider =
  Context.GenericTag<WhatsAppConnectionProviderService>(
    "@whatsapp-mcp/api/WhatsAppConnectionProvider",
  );

export interface WhatsAppConnectionClockService {
  readonly now: Effect.Effect<string>;
}

export const WhatsAppConnectionClock =
  Context.GenericTag<WhatsAppConnectionClockService>(
    "@whatsapp-mcp/api/WhatsAppConnectionClock",
  );

export interface WhatsAppConnectionIdentifiersService {
  readonly nextConnectionId: Effect.Effect<string>;
  readonly nextLifecycleClaimId: Effect.Effect<string>;
  readonly nextPublicId: Effect.Effect<string>;
  readonly nextWebhookIngressId: Effect.Effect<string>;
  readonly nextWebhookSecret: Effect.Effect<Uint8Array>;
}

export const WhatsAppConnectionIdentifiers =
  Context.GenericTag<WhatsAppConnectionIdentifiersService>(
    "@whatsapp-mcp/api/WhatsAppConnectionIdentifiers",
  );

export type WhatsAppConnectionRequirements =
  | EnvelopeEncryption
  | HumanIdentityService
  | SafeTelemetryService
  | WhatsAppConnectionClockService
  | WhatsAppConnectionIdentifiersService
  | WhatsAppConnectionPersistenceService
  | WhatsAppConnectionProviderService;

type SetupObservation =
  | {
      readonly outcome: "connected";
      readonly connection: WhatsAppConnectionRecord;
    }
  | {
      readonly outcome: "qr_available";
      readonly expiresAt: string | null;
      readonly image: Uint8Array;
    }
  | {
      readonly outcome:
        | "connecting"
        | "pending"
        | "provisioning_failed"
        | "provisioning_quarantined";
    };

type LifecycleObservation =
  | {
      readonly action: WhatsAppConnectionLifecycleAction;
      readonly connection: WhatsAppConnectionRecord;
      readonly outcome: "complete" | "in_progress" | "recovery_required";
    }
  | {
      readonly action: "reconnect";
      readonly connection: WhatsAppConnectionRecord;
      readonly expiresAt: string | null;
      readonly image: Uint8Array;
      readonly outcome: "qr_available";
    };

const decodeBase64 = (value: string): Uint8Array => {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const withZeroedBytes = <Value, Error, Requirements>(
  bytes: Uint8Array,
  use: (value: Uint8Array) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.acquireUseRelease(Effect.succeed(bytes), use, (value) =>
    Effect.sync(() => {
      value.fill(0);
    }),
  );

const encryptConnectionValue = (
  setup: Extract<
    ConnectionSetupActivation,
    { readonly outcome: "provisioned" }
  >["setup"],
  connectionId: string,
  connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: string;
    readonly connectionId: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly personalAccountId: string;
    readonly version: 1;
  },
  purpose: string,
  plaintext: Uint8Array,
) =>
  Effect.gen(function* () {
    const encryption = yield* EnvelopeEncryptionService;
    return yield* encryption.encrypt({
      accountKey: setup.accountKey,
      connectionKey,
      context: {
        accountId: setup.personalAccountId,
        connectionId,
        entity: "whatsapp-connection",
        fieldOrObjectPurpose: purpose,
        recordId: connectionId,
      },
      plaintext,
    });
  });

const activate = (
  setup: Extract<
    ConnectionSetupActivation,
    { readonly outcome: "provisioned" }
  >["setup"],
  providerSession: LifecycleSession,
) =>
  Effect.gen(function* () {
    const identifiers = yield* WhatsAppConnectionIdentifiers;
    const connectionId = yield* identifiers.nextConnectionId;
    const publicId = yield* identifiers.nextPublicId;
    const webhookIngressId = yield* identifiers.nextWebhookIngressId;
    const webhookSecret = yield* identifiers.nextWebhookSecret;
    if (webhookSecret.byteLength !== 32) {
      return yield* Effect.fail(new WhatsAppConnectionActivationError());
    }
    return yield* withZeroedBytes(webhookSecret, (secretPlaintext) =>
      Effect.gen(function* () {
        const clock = yield* WhatsAppConnectionClock;
        const connectedAt = yield* clock.now;
        const encryption = yield* EnvelopeEncryptionService;
        const connectionKey = yield* encryption.createConnectionKey({
          accountId: setup.personalAccountId,
          accountKey: setup.accountKey,
          connectionId,
          keyVersion: 1,
        });
        const numberBytes = yield* encryption.decrypt({
          accountKey: setup.accountKey,
          ciphertext: setup.numberCiphertext,
          connectionKey: setup.setupKey,
          context: {
            accountId: setup.personalAccountId,
            connectionId: setup.setupId,
            entity: "connection-setup",
            fieldOrObjectPurpose: "whatsapp-number",
            recordId: setup.setupId,
          },
        });

        return yield* withZeroedBytes(numberBytes, (numberPlaintext) =>
          Effect.gen(function* () {
            const number = new TextDecoder().decode(numberPlaintext);
            const numberSuffix = number.slice(-4);
            if (
              !/^\+[1-9]\d{7,14}$/u.test(number) ||
              !/^[0-9]{4}$/u.test(numberSuffix)
            ) {
              return yield* Effect.fail(
                new WhatsAppConnectionActivationError(),
              );
            }
            const locator = yield* encryptConnectionValue(
              setup,
              connectionId,
              connectionKey,
              "provider-session-locator",
              new TextEncoder().encode(providerSession.session),
            );
            const authority = yield* encryptConnectionValue(
              setup,
              connectionId,
              connectionKey,
              "provider-session-authority",
              new TextEncoder().encode(providerSession.authority),
            );
            const secret = yield* encryptConnectionValue(
              setup,
              connectionId,
              connectionKey,
              "webhook-verification-secret",
              secretPlaintext,
            );
            const persistence = yield* WhatsAppConnectionPersistence;
            return yield* persistence.activate({
              accountKeyVersion: connectionKey.accountKeyVersion,
              authorityCiphertext: decodeBase64(authority.ciphertext),
              authorityCiphertextVersion: authority.version,
              authorityKeyVersion: authority.keyVersion,
              authorityNonce: decodeBase64(authority.nonce),
              connectionId,
              connectionKeyCiphertext: decodeBase64(connectionKey.ciphertext),
              connectionKeyNonce: decodeBase64(connectionKey.nonce),
              connectionKeyVersion: connectionKey.keyVersion,
              connectedAt,
              locatorCiphertext: decodeBase64(locator.ciphertext),
              locatorCiphertextVersion: locator.version,
              locatorKeyVersion: locator.keyVersion,
              locatorNonce: decodeBase64(locator.nonce),
              numberSuffix,
              personalAccountId: setup.personalAccountId,
              publicId,
              setupId: setup.setupId,
              webhookIngressId,
              webhookSecretCiphertext: decodeBase64(secret.ciphertext),
              webhookSecretCiphertextVersion: secret.version,
              webhookSecretKeyVersion: secret.keyVersion,
              webhookSecretNonce: decodeBase64(secret.nonce),
            });
          }),
        );
      }),
    );
  });

const providerValue = <Value>(
  result: ProviderControlResult<Value>,
): Effect.Effect<Value, WhatsAppConnectionProviderError> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(new WhatsAppConnectionProviderError());

export const observeConnectionSetup = (
  clerkUserId: string,
  setupId: string,
): Effect.Effect<
  SetupObservation,
  | EncryptionError
  | WhatsAppConnectionActivationError
  | WhatsAppConnectionNotAccessible
  | WhatsAppConnectionPersistenceError
  | WhatsAppConnectionProviderError,
  | EnvelopeEncryption
  | WhatsAppConnectionClockService
  | WhatsAppConnectionIdentifiersService
  | WhatsAppConnectionPersistenceService
  | WhatsAppConnectionProviderService
> =>
  Effect.gen(function* () {
    const persistence = yield* WhatsAppConnectionPersistence;
    const clock = yield* WhatsAppConnectionClock;
    const observedAt = yield* clock.now;
    const loaded = yield* persistence.loadSetup({
      clerkUserId,
      observedAt,
      setupId,
    });
    if (loaded === null) {
      return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
    }
    if (loaded.outcome === "activated") {
      return { connection: loaded.connection, outcome: "connected" };
    }
    if (loaded.outcome !== "provisioned") {
      return { outcome: loaded.outcome };
    }

    const provider = yield* WhatsAppConnectionProvider;
    const reconciliation = yield* providerValue(
      yield* provider.reconcile({ setupMarker: setupId }),
    );
    if (reconciliation.outcome !== "present") {
      return yield* Effect.fail(new WhatsAppConnectionProviderError());
    }

    let session = reconciliation.session;
    if (
      session.connectionState !== "connected" &&
      session.connectionState !== "connecting"
    ) {
      session = yield* providerValue(
        yield* provider.connect({ session: session.session }),
      );
    }
    if (session.connectionState === "connected") {
      return {
        connection: yield* activate(loaded.setup, session),
        outcome: "connected",
      };
    }

    const qr = yield* providerValue(
      yield* provider.getQrCode({ session: session.session }),
    );
    return qr.state === "available"
      ? {
          expiresAt: qr.expiresAt,
          image: qr.image,
          outcome: "qr_available",
        }
      : { outcome: "connecting" };
  });

const lifecycleState = (
  action: WhatsAppConnectionLifecycleAction,
  reconciliation: SessionReconciliation,
): {
  readonly session: LifecycleSession | null;
  readonly state: Exclude<WhatsAppConnectionState, "deleting">;
} => {
  if (reconciliation.outcome === "duplicates") {
    return { session: null, state: "degraded" };
  }
  if (reconciliation.outcome === "absent") {
    return {
      session: null,
      state: action === "disconnect" ? "disconnected" : "reconnect_required",
    };
  }
  return {
    session: reconciliation.session,
    state: reconciliation.session.connectionState,
  };
};

export const reconcileWhatsAppConnectionLifecycle = (
  clerkUserId: string,
  publicId: string,
  action: WhatsAppConnectionLifecycleAction,
): Effect.Effect<
  LifecycleObservation,
  WhatsAppConnectionNotAccessible | WhatsAppConnectionPersistenceError,
  | WhatsAppConnectionClockService
  | WhatsAppConnectionIdentifiersService
  | WhatsAppConnectionPersistenceService
  | WhatsAppConnectionProviderService
> =>
  Effect.gen(function* () {
    const identifiers = yield* WhatsAppConnectionIdentifiers;
    const clock = yield* WhatsAppConnectionClock;
    const persistence = yield* WhatsAppConnectionPersistence;
    const claimId = yield* identifiers.nextLifecycleClaimId;
    const requestedAt = yield* clock.now;
    const claim = yield* persistence.claimLifecycle({
      action,
      claimId,
      clerkUserId,
      publicId,
      requestedAt,
    });
    if (claim === null) {
      return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
    }
    if (claim.outcome !== "claimed") {
      return {
        action,
        connection: claim.connection,
        outcome: claim.outcome,
      };
    }

    const provider = yield* WhatsAppConnectionProvider;
    let providerSession: LifecycleSession | null = null;
    let state: Exclude<WhatsAppConnectionState, "deleting"> = "degraded";
    const reconciled = yield* provider.reconcile({
      setupMarker: claim.setupMarker,
    });
    if (reconciled.ok) {
      ({ session: providerSession, state } = lifecycleState(
        action,
        reconciled.value,
      ));
    }

    const needsWrite =
      providerSession !== null &&
      (action === "disconnect"
        ? providerSession.connectionState === "connected" ||
          providerSession.connectionState === "connecting"
        : providerSession.connectionState === "disconnected" ||
          providerSession.connectionState === "reconnect_required");

    if (needsWrite && providerSession !== null) {
      const written =
        action === "disconnect"
          ? yield* provider.disconnect({ session: providerSession.session })
          : yield* provider.connect({ session: providerSession.session });
      if (written.ok) {
        providerSession = written.value;
        state =
          action === "disconnect" &&
          written.value.connectionState === "reconnect_required"
            ? "disconnected"
            : written.value.connectionState;
      } else {
        const afterAmbiguousWrite = yield* provider.reconcile({
          setupMarker: claim.setupMarker,
        });
        if (afterAmbiguousWrite.ok) {
          ({ session: providerSession, state } = lifecycleState(
            action,
            afterAmbiguousWrite.value,
          ));
        } else {
          providerSession = null;
          state = "degraded";
        }
      }
    }

    if (
      action === "disconnect" &&
      state !== "disconnected" &&
      state !== "reconnect_required"
    ) {
      state = "degraded";
    }
    if (action === "disconnect" && state === "reconnect_required") {
      state = "disconnected";
    }

    const observedAt = yield* clock.now;
    const connection = yield* persistence.finishLifecycle({
      claimId,
      clerkUserId,
      observedAt,
      publicId,
      state,
    });
    if (connection === null) {
      return {
        action,
        connection: claim.connection,
        outcome: "in_progress",
      };
    }

    if (
      action === "reconnect" &&
      providerSession !== null &&
      state === "connecting"
    ) {
      const qr = yield* provider.getQrCode({
        session: providerSession.session,
      });
      if (qr.ok && qr.value.state === "available") {
        return {
          action,
          connection,
          expiresAt: qr.value.expiresAt,
          image: qr.value.image,
          outcome: "qr_available",
        };
      }
    }

    const complete =
      (action === "disconnect" && connection.state === "disconnected") ||
      (action === "reconnect" && connection.state === "connected");
    return {
      action,
      connection,
      outcome: complete
        ? "complete"
        : connection.state === "connecting"
          ? "in_progress"
          : "recovery_required",
    };
  });

const corsHeaders = (browserOrigin: string): HeadersInit => ({
  "access-control-allow-headers": "authorization",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-origin": browserOrigin,
  vary: "Origin",
});

const jsonResponse = (
  body: unknown,
  status: number,
  browserOrigin?: string,
): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      ...(browserOrigin === undefined ? {} : corsHeaders(browserOrigin)),
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });

const notFound = (browserOrigin?: string): Response =>
  jsonResponse({ error: "not_found" }, 404, browserOrigin);

const stateResponse = (
  state: "connecting" | "pending",
  browserOrigin: string,
): Response =>
  new Response(null, {
    headers: {
      ...corsHeaders(browserOrigin),
      "cache-control": "no-store",
      "x-connection-setup-state": state,
    },
    status: 202,
  });

const qrResponse = (
  image: Uint8Array,
  expiresAt: string | null,
  browserOrigin: string,
): Response =>
  new Response(image, {
    headers: {
      ...corsHeaders(browserOrigin),
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "content-type": "image/svg+xml",
      ...(expiresAt === null
        ? {}
        : { "x-connection-setup-qr-expires-at": expiresAt }),
      "x-content-type-options": "nosniff",
    },
    status: 200,
  });

const reconnectQrResponse = (
  observation: Extract<LifecycleObservation, { outcome: "qr_available" }>,
  browserOrigin: string,
): Response =>
  new Response(observation.image, {
    headers: {
      ...corsHeaders(browserOrigin),
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "content-type": "image/svg+xml",
      ...(observation.expiresAt === null
        ? {}
        : { "x-whatsapp-connection-qr-expires-at": observation.expiresAt }),
      "x-content-type-options": "nosniff",
      "x-whatsapp-connection-state": observation.connection.state,
    },
    status: 200,
  });

const connectionJson = (connection: WhatsAppConnectionRecord) => ({
  display_name: connection.displayName,
  id: connection.publicId,
  number_suffix: connection.numberSuffix,
  state: connection.state,
  state_changed_at: connection.stateChangedAt,
});

export const createWhatsAppConnectionHandler =
  (
    layer: Layer.Layer<WhatsAppConnectionRequirements, unknown>,
    browserOrigin: string,
  ) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const qrMatch = qrRoutePattern.exec(url.pathname);
    const lifecycleMatch = lifecycleRoutePattern.exec(url.pathname);
    if (
      (url.pathname !== CONNECTIONS_ROUTE &&
        qrMatch === null &&
        lifecycleMatch === null) ||
      request.headers.get("origin") !== browserOrigin
    ) {
      return notFound();
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(browserOrigin),
        status: 204,
      });
    }
    if (
      (lifecycleMatch === null && request.method !== "GET") ||
      (lifecycleMatch !== null && request.method !== "POST")
    ) {
      return notFound(browserOrigin);
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* HumanIdentity;
        const clerkUserId = yield* identity.verify(request);
        if (lifecycleMatch !== null) {
          const publicId = lifecycleMatch[1];
          const action = lifecycleMatch[2];
          if (
            publicId === undefined ||
            (action !== "disconnect" && action !== "reconnect")
          ) {
            return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
          }
          const observation = yield* reconcileWhatsAppConnectionLifecycle(
            clerkUserId,
            publicId,
            action,
          );
          const telemetry = yield* SafeTelemetry;
          yield* telemetry.emit({
            event: "whatsapp_connection.lifecycle.completed",
            operation: action,
            outcome: observation.outcome,
            service: "api",
          });
          return { kind: "lifecycle" as const, observation };
        }
        if (qrMatch !== null) {
          const setupId = qrMatch[1];
          if (setupId === undefined) {
            return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
          }
          const observation = yield* observeConnectionSetup(
            clerkUserId,
            setupId,
          );
          const telemetry = yield* SafeTelemetry;
          yield* telemetry.emit({
            event: "connection_setup.qr.completed",
            outcome: observation.outcome,
            service: "api",
          });
          return { kind: "observation" as const, observation };
        }
        const persistence = yield* WhatsAppConnectionPersistence;
        const connections = yield* persistence.list(clerkUserId);
        const telemetry = yield* SafeTelemetry;
        yield* telemetry.emit({
          connectionCount: connections.length,
          event: "whatsapp_connection.list.completed",
          service: "api",
        });
        return { connections, kind: "connections" as const };
      }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            typeof failure === "object" &&
            failure !== null &&
            "_tag" in failure &&
            (failure._tag === "InvalidHumanIdentity" ||
              failure._tag === "WhatsAppConnectionNotAccessible")
              ? notFound(browserOrigin)
              : jsonResponse({ error: "unavailable" }, 503, browserOrigin),
          onSuccess: (result) => {
            if (result.kind === "lifecycle") {
              const observation = result.observation;
              if (observation.outcome === "qr_available") {
                return reconnectQrResponse(observation, browserOrigin);
              }
              return jsonResponse(
                {
                  lifecycle: {
                    action: observation.action,
                    outcome: observation.outcome,
                  },
                  whatsapp_connection: connectionJson(observation.connection),
                },
                observation.outcome === "complete"
                  ? 200
                  : observation.outcome === "in_progress"
                    ? 202
                    : 409,
                browserOrigin,
              );
            }
            if (result.kind === "connections") {
              return jsonResponse(
                {
                  whatsapp_connections: result.connections.map(connectionJson),
                },
                200,
                browserOrigin,
              );
            }
            const observation = result.observation;
            switch (observation.outcome) {
              case "connected":
                return new Response(null, {
                  headers: {
                    ...corsHeaders(browserOrigin),
                    "cache-control": "no-store",
                    "x-connection-setup-state": "connected",
                  },
                  status: 204,
                });
              case "qr_available":
                return qrResponse(
                  observation.image,
                  observation.expiresAt,
                  browserOrigin,
                );
              case "connecting":
              case "pending":
                return stateResponse(observation.outcome, browserOrigin);
              case "provisioning_failed":
              case "provisioning_quarantined":
                return jsonResponse(
                  { error: observation.outcome },
                  409,
                  browserOrigin,
                );
            }
          },
        }),
      ),
    );
  };

export const isWhatsAppConnectionRequest = (request: Request): boolean => {
  const path = new URL(request.url).pathname;
  return (
    path === CONNECTIONS_ROUTE ||
    qrRoutePattern.test(path) ||
    lifecycleRoutePattern.test(path)
  );
};
