import type {
  LifecycleSession,
  ProviderControlResult,
  SessionReconciliation,
} from "@whatsapp-mcp/contracts/provider-control";
import type {
  ConnectionHealthCandidate,
  ConnectionHealthGapEvidence,
  ReconciledConnectionHealthState,
} from "@whatsapp-mcp/db/connection-health";
import { Context, Data, Effect } from "effect";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

export class ConnectionHealthPersistenceError extends Data.TaggedError(
  "ConnectionHealthPersistenceError",
) {}

export interface ConnectionHealthPersistenceService {
  readonly finish: (input: {
    readonly checkedAt: string;
    readonly claimId: string;
    readonly connectionId: string;
    readonly gapEvidence: ConnectionHealthGapEvidence;
    readonly startedAt: string;
    readonly state: ReconciledConnectionHealthState;
    readonly webhookConfigurationHealthy: boolean;
  }) => Effect.Effect<boolean, ConnectionHealthPersistenceError>;
}

export const ConnectionHealthPersistence =
  Context.GenericTag<ConnectionHealthPersistenceService>(
    "@whatsapp-mcp/api/ConnectionHealthPersistence",
  );

export interface ConnectionHealthProviderService {
  readonly reconcile: (input: {
    readonly setupMarker: string;
    readonly webhookUrl: string;
  }) => Effect.Effect<ProviderControlResult<SessionReconciliation>>;
  readonly repair: (input: {
    readonly setupMarker: string;
    readonly webhookUrl: string;
  }) => Effect.Effect<ProviderControlResult<LifecycleSession>>;
}

export const ConnectionHealthProvider =
  Context.GenericTag<ConnectionHealthProviderService>(
    "@whatsapp-mcp/api/ConnectionHealthProvider",
  );

export interface ConnectionHealthClockService {
  readonly now: Effect.Effect<string>;
}

export const ConnectionHealthClock =
  Context.GenericTag<ConnectionHealthClockService>(
    "@whatsapp-mcp/api/ConnectionHealthClock",
  );

type ConnectionHealthRequirements =
  | ConnectionHealthClockService
  | ConnectionHealthPersistenceService
  | ConnectionHealthProviderService
  | SafeTelemetryService;

interface NormalizedHealthObservation {
  readonly gapEvidence: ConnectionHealthGapEvidence;
  readonly state: ReconciledConnectionHealthState;
  readonly webhookConfigurationHealthy: boolean;
}

const normalize = (
  result: ProviderControlResult<SessionReconciliation>,
): NormalizedHealthObservation => {
  if (!result.ok) {
    return result.error.code === "integrity_failed"
      ? {
          gapEvidence: "webhook_configuration",
          state: "degraded",
          webhookConfigurationHealthy: false,
        }
      : {
          gapEvidence: "unknown",
          state: "degraded",
          webhookConfigurationHealthy: false,
        };
  }
  if (result.value.outcome === "absent") {
    return {
      gapEvidence: "connection_unavailable",
      state: "reconnect_required",
      webhookConfigurationHealthy: false,
    };
  }
  if (result.value.outcome === "duplicates") {
    return {
      gapEvidence: "connection_unavailable",
      state: "degraded",
      webhookConfigurationHealthy: false,
    };
  }
  switch (result.value.session.connectionState) {
    case "connected":
      return {
        gapEvidence: "healthy",
        state: "connected",
        webhookConfigurationHealthy: true,
      };
    case "disconnected":
      return {
        gapEvidence: "connection_unavailable",
        state: "disconnected",
        webhookConfigurationHealthy: true,
      };
    case "reconnect_required":
      return {
        gapEvidence: "connection_unavailable",
        state: "reconnect_required",
        webhookConfigurationHealthy: true,
      };
    case "connecting":
    case "degraded":
      return {
        gapEvidence: "connection_unavailable",
        state: "degraded",
        webhookConfigurationHealthy: true,
      };
  }
};

const normalizeRepair = (
  result: ProviderControlResult<LifecycleSession>,
): NormalizedHealthObservation =>
  result.ok
    ? normalize({
        ok: true,
        value: { outcome: "present", session: result.value },
      })
    : {
        gapEvidence: "webhook_configuration",
        state: "degraded",
        webhookConfigurationHealthy: false,
      };

const webhookUrl = (apiOrigin: string, webhookIngressId: string): string => {
  const origin = new URL(apiOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== apiOrigin ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      webhookIngressId,
    )
  ) {
    throw new Error("invalid connection health webhook endpoint");
  }
  return `${apiOrigin}/webhooks/wasender/${webhookIngressId}`;
};

export const reconcileConnectionHealth = (
  candidate: ConnectionHealthCandidate,
  apiOrigin: string,
): Effect.Effect<
  { readonly outcome: "applied" | "superseded" },
  unknown,
  ConnectionHealthRequirements
> =>
  Effect.gen(function* () {
    const provider = yield* ConnectionHealthProvider;
    const persistence = yield* ConnectionHealthPersistence;
    const clock = yield* ConnectionHealthClock;
    const telemetry = yield* SafeTelemetry;
    const startedAt = yield* clock.now;
    const input = {
      setupMarker: candidate.setupMarker,
      webhookUrl: webhookUrl(apiOrigin, candidate.webhookIngressId),
    };
    const result = yield* provider.reconcile(input);
    const observation =
      !result.ok && result.error.code === "integrity_failed"
        ? normalizeRepair(yield* provider.repair(input))
        : normalize(result);
    const checkedAt = yield* clock.now;
    const applied = yield* persistence.finish({
      checkedAt,
      claimId: candidate.claimId,
      connectionId: candidate.connectionId,
      startedAt,
      gapEvidence: observation.gapEvidence,
      state: observation.state,
      webhookConfigurationHealthy: observation.webhookConfigurationHealthy,
    });
    const outcome = applied ? "applied" : "superseded";
    yield* telemetry.emit({
      event: "connection_health.reconciliation.completed",
      gapEvidence: observation.gapEvidence,
      outcome,
      service: "api",
      state: observation.state,
    });
    return { outcome };
  });
