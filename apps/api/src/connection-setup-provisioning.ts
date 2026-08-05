import type {
  LifecycleSession,
  ProviderControlResult,
  SessionReconciliation,
} from "@whatsapp-mcp/contracts/provider-control";
import type {
  ConnectionSetupProvisioningClaim,
  EncryptedConnectionSetupProviderSession,
  FinishConnectionSetupProvisioningInput,
} from "@whatsapp-mcp/db/connection-setup";
import { Context, Data, Effect, type Layer } from "effect";
import { decodeBase64 } from "./base64-url";
import {
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import { handleQueueBatch } from "./queue-batch";
import { hasExactKeys } from "./record";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const RETRY_DELAY_SECONDS = 30;
const provisioningMessageKind = "connection_setup.provision";
const setupIdPattern = /^cst_[A-Za-z0-9_-]{21}$/u;

export class ConnectionSetupProvisioningPersistenceError extends Data.TaggedError(
  "ConnectionSetupProvisioningPersistenceError",
) {}

export class ConnectionSetupProvisioningQueueError extends Data.TaggedError(
  "ConnectionSetupProvisioningQueueError",
) {}

export interface ConnectionSetupProvisioningQueueService {
  readonly enqueue: (
    setupId: string,
  ) => Effect.Effect<void, ConnectionSetupProvisioningQueueError>;
  readonly enqueueCleanup: (
    setupId: string,
  ) => Effect.Effect<void, ConnectionSetupProvisioningQueueError>;
}

export const ConnectionSetupProvisioningQueue =
  Context.GenericTag<ConnectionSetupProvisioningQueueService>(
    "@whatsapp-mcp/api/ConnectionSetupProvisioningQueue",
  );

export interface ConnectionSetupProvisioningPersistenceService {
  readonly claim: (input: {
    readonly claimedAt: string;
    readonly setupId: string;
    readonly workerId: string;
  }) => Effect.Effect<
    ConnectionSetupProvisioningClaim,
    ConnectionSetupProvisioningPersistenceError
  >;
  readonly finish: (
    input: FinishConnectionSetupProvisioningInput,
  ) => Effect.Effect<boolean, ConnectionSetupProvisioningPersistenceError>;
  readonly fail: (input: {
    readonly failureCode: string;
    readonly observedAt: string;
    readonly setupId: string;
    readonly workerId: string;
  }) => Effect.Effect<boolean, ConnectionSetupProvisioningPersistenceError>;
  readonly listCandidates: (input: {
    readonly limit: number;
    readonly observedAt: string;
  }) => Effect.Effect<
    ReadonlyArray<string>,
    ConnectionSetupProvisioningPersistenceError
  >;
  readonly release: (input: {
    readonly failureCode: string;
    readonly observedAt: string;
    readonly setupId: string;
    readonly workerId: string;
  }) => Effect.Effect<boolean, ConnectionSetupProvisioningPersistenceError>;
  readonly renew: (input: {
    readonly observedAt: string;
    readonly setupId: string;
    readonly workerId: string;
  }) => Effect.Effect<boolean, ConnectionSetupProvisioningPersistenceError>;
}

export const ConnectionSetupProvisioningPersistence =
  Context.GenericTag<ConnectionSetupProvisioningPersistenceService>(
    "@whatsapp-mcp/api/ConnectionSetupProvisioningPersistence",
  );

export interface ConnectionSetupProvisioningProviderService {
  readonly create: (input: {
    readonly phoneNumber: string;
    readonly setupMarker: string;
    readonly webhookUrl: string;
  }) => Effect.Effect<ProviderControlResult<LifecycleSession>>;
  readonly reconcile: (input: {
    readonly setupMarker: string;
    readonly webhookUrl: string;
  }) => Effect.Effect<ProviderControlResult<SessionReconciliation>>;
}

export const ConnectionSetupProvisioningProvider =
  Context.GenericTag<ConnectionSetupProvisioningProviderService>(
    "@whatsapp-mcp/api/ConnectionSetupProvisioningProvider",
  );

export interface ConnectionSetupProvisioningWebhookService {
  readonly urlFor: (webhookIngressId: string) => Effect.Effect<string>;
}

export const ConnectionSetupProvisioningWebhook =
  Context.GenericTag<ConnectionSetupProvisioningWebhookService>(
    "@whatsapp-mcp/api/ConnectionSetupProvisioningWebhook",
  );

export interface ConnectionSetupProvisioningClockService {
  readonly now: Effect.Effect<string>;
}

export const ConnectionSetupProvisioningClock =
  Context.GenericTag<ConnectionSetupProvisioningClockService>(
    "@whatsapp-mcp/api/ConnectionSetupProvisioningClock",
  );

export interface ConnectionSetupProvisioningIdentifiersService {
  readonly nextWorkerId: Effect.Effect<string>;
}

export const ConnectionSetupProvisioningIdentifiers =
  Context.GenericTag<ConnectionSetupProvisioningIdentifiersService>(
    "@whatsapp-mcp/api/ConnectionSetupProvisioningIdentifiers",
  );

export type ConnectionSetupProvisioningRequirements =
  | ConnectionSetupProvisioningClockService
  | ConnectionSetupProvisioningIdentifiersService
  | ConnectionSetupProvisioningPersistenceService
  | ConnectionSetupProvisioningProviderService
  | ConnectionSetupProvisioningWebhookService
  | EnvelopeEncryption
  | SafeTelemetryService;

export type ConnectionSetupProvisioningAttempt =
  | {
      readonly outcome: "failed" | "ignored" | "provisioned" | "quarantined";
    }
  | {
      readonly delaySeconds: number;
      readonly outcome: "retry";
    };

export interface ConnectionSetupProvisioningMessage {
  readonly kind: typeof provisioningMessageKind;
  readonly setup_id: string;
  readonly version: 1;
}

export const connectionSetupProvisioningMessage = (
  setupId: string,
): ConnectionSetupProvisioningMessage => ({
  kind: provisioningMessageKind,
  setup_id: setupId,
  version: 1,
});

export const isConnectionSetupProvisioningMessage = (
  value: unknown,
): value is ConnectionSetupProvisioningMessage => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value, ["kind", "setup_id", "version"])
  ) {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    message.kind === provisioningMessageKind &&
    message.version === 1 &&
    typeof message.setup_id === "string" &&
    setupIdPattern.test(message.setup_id)
  );
};

const retry = (): ConnectionSetupProvisioningAttempt => ({
  delaySeconds: RETRY_DELAY_SECONDS,
  outcome: "retry",
});

const encryptProviderSession = (
  setup: Extract<
    ConnectionSetupProvisioningClaim,
    { readonly outcome: "claimed" }
  >["setup"],
  providerSession: LifecycleSession,
  ordinal: number,
): Effect.Effect<
  EncryptedConnectionSetupProviderSession,
  unknown,
  EnvelopeEncryption
> =>
  Effect.gen(function* () {
    const encryption = yield* EnvelopeEncryptionService;
    const recordId = `${setup.setupId}:${ordinal}`;
    const locator = yield* encryption.encrypt({
      accountKey: setup.accountKey,
      connectionKey: setup.connectionKey,
      context: {
        accountId: setup.personalAccountId,
        connectionId: setup.setupId,
        entity: "connection-setup-provider-session",
        fieldOrObjectPurpose: "provider-session-locator",
        recordId,
      },
      plaintext: new TextEncoder().encode(providerSession.session),
    });
    const authority = yield* encryption.encrypt({
      accountKey: setup.accountKey,
      connectionKey: setup.connectionKey,
      context: {
        accountId: setup.personalAccountId,
        connectionId: setup.setupId,
        entity: "connection-setup-provider-session",
        fieldOrObjectPurpose: "provider-session-authority",
        recordId,
      },
      plaintext: new TextEncoder().encode(providerSession.authority),
    });
    return {
      authorityCiphertext: decodeBase64(authority.ciphertext),
      authorityCiphertextVersion: authority.version,
      authorityKeyVersion: authority.keyVersion,
      authorityNonce: decodeBase64(authority.nonce),
      locatorCiphertext: decodeBase64(locator.ciphertext),
      locatorCiphertextVersion: locator.version,
      locatorKeyVersion: locator.keyVersion,
      locatorNonce: decodeBase64(locator.nonce),
      ordinal,
    };
  });

const emit = (
  outcome: "failed" | "ignored" | "provisioned" | "quarantined" | "retry",
  failureCode?: string,
) =>
  Effect.gen(function* () {
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      event: "connection_setup.provision.completed",
      ...(failureCode === undefined ? {} : { failureCode }),
      outcome,
      service: "api",
    });
  });

const releaseForRetry = (
  setupId: string,
  workerId: string,
  failureCode: string,
) =>
  Effect.gen(function* () {
    const clock = yield* ConnectionSetupProvisioningClock;
    const persistence = yield* ConnectionSetupProvisioningPersistence;
    yield* persistence.release({
      failureCode,
      observedAt: yield* clock.now,
      setupId,
      workerId,
    });
    yield* emit("retry", failureCode);
    return retry();
  });

const failDefinitively = (
  setupId: string,
  workerId: string,
  failureCode: string,
) =>
  Effect.gen(function* () {
    const clock = yield* ConnectionSetupProvisioningClock;
    const persistence = yield* ConnectionSetupProvisioningPersistence;
    const failed = yield* persistence.fail({
      failureCode,
      observedAt: yield* clock.now,
      setupId,
      workerId,
    });
    if (!failed) {
      yield* emit("retry", "lease_lost");
      return retry();
    }
    yield* emit("failed", failureCode);
    return { outcome: "failed" } as const;
  });

const finish = (
  setup: Extract<
    ConnectionSetupProvisioningClaim,
    { readonly outcome: "claimed" }
  >["setup"],
  workerId: string,
  outcome: "provisioned" | "quarantined",
  providerSessions: ReadonlyArray<LifecycleSession>,
) =>
  Effect.gen(function* () {
    const encryptedSessions = yield* Effect.forEach(
      providerSessions,
      (providerSession, ordinal) =>
        encryptProviderSession(setup, providerSession, ordinal),
      { concurrency: 1 },
    );
    const clock = yield* ConnectionSetupProvisioningClock;
    const persistence = yield* ConnectionSetupProvisioningPersistence;
    const committed = yield* persistence.finish({
      observedAt: yield* clock.now,
      outcome,
      sessions: encryptedSessions,
      setupId: setup.setupId,
      workerId,
    });
    if (!committed) {
      yield* emit("retry", "lease_lost");
      return retry();
    }
    yield* emit(outcome);
    return { outcome } as const;
  });

const withDecryptedNumber = <Value, Error, Requirements>(
  setup: Extract<
    ConnectionSetupProvisioningClaim,
    { readonly outcome: "claimed" }
  >["setup"],
  use: (
    normalizedWhatsAppNumber: string,
  ) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.gen(function* () {
    const encryption = yield* EnvelopeEncryptionService;
    const plaintext = yield* encryption.decrypt({
      accountKey: setup.accountKey,
      ciphertext: setup.numberCiphertext,
      connectionKey: setup.connectionKey,
      context: {
        accountId: setup.personalAccountId,
        connectionId: setup.setupId,
        entity: "connection-setup",
        fieldOrObjectPurpose: "whatsapp-number",
        recordId: setup.setupId,
      },
    });
    return yield* Effect.acquireUseRelease(
      Effect.succeed(plaintext),
      (bytes) => use(new TextDecoder().decode(bytes)),
      (bytes) =>
        Effect.sync(() => {
          bytes.fill(0);
        }),
    );
  });

const reconcileClaimedSetup = (
  setup: Extract<
    ConnectionSetupProvisioningClaim,
    { readonly outcome: "claimed" }
  >["setup"],
  workerId: string,
) =>
  Effect.gen(function* () {
    const provider = yield* ConnectionSetupProvisioningProvider;
    const webhooks = yield* ConnectionSetupProvisioningWebhook;
    const webhookUrl = yield* webhooks.urlFor(setup.webhookIngressId);
    const reconciliation = yield* provider.reconcile({
      setupMarker: setup.setupId,
      webhookUrl,
    });
    if (!reconciliation.ok) {
      if (reconciliation.error.retryDecision === "do_not_retry") {
        return yield* failDefinitively(
          setup.setupId,
          workerId,
          reconciliation.error.code,
        );
      }
      return yield* releaseForRetry(
        setup.setupId,
        workerId,
        reconciliation.error.code,
      );
    }
    switch (reconciliation.value.outcome) {
      case "present":
        return yield* finish(setup, workerId, "provisioned", [
          reconciliation.value.session,
        ]);
      case "duplicates":
        return yield* finish(
          setup,
          workerId,
          "quarantined",
          reconciliation.value.sessions,
        );
      case "absent": {
        const clock = yield* ConnectionSetupProvisioningClock;
        const persistence = yield* ConnectionSetupProvisioningPersistence;
        const renewed = yield* persistence.renew({
          observedAt: yield* clock.now,
          setupId: setup.setupId,
          workerId,
        });
        if (!renewed) {
          yield* emit("retry", "lease_lost");
          return retry();
        }
        const created = yield* withDecryptedNumber(setup, (phoneNumber) =>
          provider.create({
            phoneNumber,
            setupMarker: setup.setupId,
            webhookUrl,
          }),
        );
        if (!created.ok) {
          if (created.error.retryDecision === "do_not_retry") {
            return yield* failDefinitively(
              setup.setupId,
              workerId,
              created.error.code,
            );
          }
          return yield* releaseForRetry(
            setup.setupId,
            workerId,
            created.error.code,
          );
        }
        return yield* finish(setup, workerId, "provisioned", [created.value]);
      }
    }
  });

export const provisionConnectionSetup = (
  setupId: string,
): Effect.Effect<
  ConnectionSetupProvisioningAttempt,
  unknown,
  ConnectionSetupProvisioningRequirements
> =>
  Effect.gen(function* () {
    const clock = yield* ConnectionSetupProvisioningClock;
    const identifiers = yield* ConnectionSetupProvisioningIdentifiers;
    const persistence = yield* ConnectionSetupProvisioningPersistence;
    const workerId = yield* identifiers.nextWorkerId;
    const claim = yield* persistence.claim({
      claimedAt: yield* clock.now,
      setupId,
      workerId,
    });
    if (claim.outcome === "leased") {
      yield* emit("retry", "lease_active");
      return retry();
    }
    if (claim.outcome !== "claimed") {
      yield* emit("ignored");
      return { outcome: "ignored" };
    }
    return yield* reconcileClaimedSetup(claim.setup, workerId);
  });

export const handleConnectionSetupProvisioningBatch = (
  batch: MessageBatch,
  layer: Layer.Layer<ConnectionSetupProvisioningRequirements, unknown>,
): Promise<void> => {
  return handleQueueBatch(
    batch,
    isConnectionSetupProvisioningMessage,
    (message) =>
      Effect.runPromise(
        provisionConnectionSetup(message.setup_id).pipe(Effect.provide(layer)),
      ),
    (result) => (result.outcome === "retry" ? result.delaySeconds : null),
    RETRY_DELAY_SECONDS,
  );
};
