import type {
  ProviderControlResult,
  SessionDeletionObservation,
  SessionReconciliation,
} from "@whatsapp-mcp/contracts/provider-control";
import type { ConnectionSetupCleanupClaim } from "@whatsapp-mcp/db/connection-setup";
import { Context, Data, Effect, type Layer } from "effect";
import { hasExactKeys } from "./record";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const RETRY_DELAY_SECONDS = 30;
const cleanupMessageKind = "connection_setup.cleanup";
const setupIdPattern = /^cst_[A-Za-z0-9_-]{21}$/u;

export class ConnectionSetupCleanupPersistenceError extends Data.TaggedError(
  "ConnectionSetupCleanupPersistenceError",
) {}

export interface ConnectionSetupCleanupPersistenceService {
  readonly claim: (input: {
    readonly claimedAt: string;
    readonly setupId: string;
    readonly workerId: string;
  }) => Effect.Effect<
    ConnectionSetupCleanupClaim,
    ConnectionSetupCleanupPersistenceError
  >;
  readonly finish: (input: {
    readonly observedAt: string;
    readonly setupId: string;
    readonly workerId: string;
  }) => Effect.Effect<boolean, ConnectionSetupCleanupPersistenceError>;
  readonly listCandidates: (input: {
    readonly limit: number;
    readonly observedAt: string;
  }) => Effect.Effect<
    ReadonlyArray<string>,
    ConnectionSetupCleanupPersistenceError
  >;
  readonly release: (input: {
    readonly failureCode: string;
    readonly observedAt: string;
    readonly setupId: string;
    readonly workerId: string;
  }) => Effect.Effect<boolean, ConnectionSetupCleanupPersistenceError>;
  readonly renew: (input: {
    readonly observedAt: string;
    readonly setupId: string;
    readonly workerId: string;
  }) => Effect.Effect<boolean, ConnectionSetupCleanupPersistenceError>;
}

export const ConnectionSetupCleanupPersistence =
  Context.GenericTag<ConnectionSetupCleanupPersistenceService>(
    "@whatsapp-mcp/api/ConnectionSetupCleanupPersistence",
  );

export interface ConnectionSetupCleanupProviderService {
  readonly delete: (input: {
    readonly session: string;
  }) => Effect.Effect<ProviderControlResult<SessionDeletionObservation>>;
  readonly reconcile: (input: {
    readonly setupMarker: string;
  }) => Effect.Effect<ProviderControlResult<SessionReconciliation>>;
}

export const ConnectionSetupCleanupProvider =
  Context.GenericTag<ConnectionSetupCleanupProviderService>(
    "@whatsapp-mcp/api/ConnectionSetupCleanupProvider",
  );

export interface ConnectionSetupCleanupClockService {
  readonly now: Effect.Effect<string>;
}

export const ConnectionSetupCleanupClock =
  Context.GenericTag<ConnectionSetupCleanupClockService>(
    "@whatsapp-mcp/api/ConnectionSetupCleanupClock",
  );

export interface ConnectionSetupCleanupIdentifiersService {
  readonly nextWorkerId: Effect.Effect<string>;
}

export const ConnectionSetupCleanupIdentifiers =
  Context.GenericTag<ConnectionSetupCleanupIdentifiersService>(
    "@whatsapp-mcp/api/ConnectionSetupCleanupIdentifiers",
  );

export type ConnectionSetupCleanupRequirements =
  | ConnectionSetupCleanupClockService
  | ConnectionSetupCleanupIdentifiersService
  | ConnectionSetupCleanupPersistenceService
  | ConnectionSetupCleanupProviderService
  | SafeTelemetryService;

export type ConnectionSetupCleanupAttempt =
  | { readonly outcome: "complete" | "ignored" }
  | { readonly delaySeconds: number; readonly outcome: "retry" };

export interface ConnectionSetupCleanupMessage {
  readonly kind: typeof cleanupMessageKind;
  readonly setup_id: string;
  readonly version: 1;
}

export const connectionSetupCleanupMessage = (
  setupId: string,
): ConnectionSetupCleanupMessage => ({
  kind: cleanupMessageKind,
  setup_id: setupId,
  version: 1,
});

export const isConnectionSetupCleanupMessage = (
  value: unknown,
): value is ConnectionSetupCleanupMessage => {
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
    message.kind === cleanupMessageKind &&
    message.version === 1 &&
    typeof message.setup_id === "string" &&
    setupIdPattern.test(message.setup_id)
  );
};

const retry = (): ConnectionSetupCleanupAttempt => ({
  delaySeconds: RETRY_DELAY_SECONDS,
  outcome: "retry",
});

const emit = (
  outcome: "complete" | "ignored" | "retry",
  failureCode?: string,
) =>
  Effect.gen(function* () {
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      event: "connection_setup.cleanup.completed",
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
    const clock = yield* ConnectionSetupCleanupClock;
    const persistence = yield* ConnectionSetupCleanupPersistence;
    yield* persistence.release({
      failureCode,
      observedAt: yield* clock.now,
      setupId,
      workerId,
    });
    yield* emit("retry", failureCode);
    return retry();
  });

const deleteOne = (setupId: string, workerId: string, session: string) =>
  Effect.gen(function* () {
    const clock = yield* ConnectionSetupCleanupClock;
    const persistence = yield* ConnectionSetupCleanupPersistence;
    const renewed = yield* persistence.renew({
      observedAt: yield* clock.now,
      setupId,
      workerId,
    });
    if (!renewed) {
      yield* emit("retry", "lease_lost");
      return retry();
    }
    const provider = yield* ConnectionSetupCleanupProvider;
    const deleted = yield* provider.delete({ session });
    return yield* releaseForRetry(
      setupId,
      workerId,
      deleted.ok ? "presence_unconfirmed" : deleted.error.code,
    );
  });

export const cleanupConnectionSetup = (
  setupId: string,
): Effect.Effect<
  ConnectionSetupCleanupAttempt,
  unknown,
  ConnectionSetupCleanupRequirements
> =>
  Effect.gen(function* () {
    const clock = yield* ConnectionSetupCleanupClock;
    const identifiers = yield* ConnectionSetupCleanupIdentifiers;
    const persistence = yield* ConnectionSetupCleanupPersistence;
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
    if (claim.outcome === "complete") {
      yield* emit("complete");
      return { outcome: "complete" };
    }
    if (claim.outcome !== "claimed") {
      yield* emit("ignored");
      return { outcome: "ignored" };
    }

    const provider = yield* ConnectionSetupCleanupProvider;
    const reconciliation = yield* provider.reconcile({
      setupMarker: setupId,
    });
    if (!reconciliation.ok) {
      return yield* releaseForRetry(
        setupId,
        workerId,
        reconciliation.error.code,
      );
    }
    if (reconciliation.value.outcome === "absent") {
      const finished = yield* persistence.finish({
        observedAt: yield* clock.now,
        setupId,
        workerId,
      });
      if (!finished) {
        yield* emit("retry", "lease_lost");
        return retry();
      }
      yield* emit("complete");
      return { outcome: "complete" };
    }
    const session =
      reconciliation.value.outcome === "present"
        ? reconciliation.value.session
        : reconciliation.value.sessions[0];
    return yield* deleteOne(setupId, workerId, session.session);
  });

export const handleConnectionSetupCleanupBatch = async (
  batch: MessageBatch,
  layer: Layer.Layer<ConnectionSetupCleanupRequirements, unknown>,
): Promise<void> => {
  for (const message of batch.messages) {
    if (!isConnectionSetupCleanupMessage(message.body)) {
      message.ack();
      continue;
    }
    try {
      const result = await Effect.runPromise(
        cleanupConnectionSetup(message.body.setup_id).pipe(
          Effect.provide(layer),
        ),
      );
      if (result.outcome === "retry") {
        message.retry({ delaySeconds: result.delaySeconds });
      } else {
        message.ack();
      }
    } catch {
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
};
