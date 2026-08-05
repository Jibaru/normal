import type {
  ProviderControlFailure,
  ProviderControlResult,
  SessionReconciliation,
} from "@whatsapp-mcp/contracts/provider-control";
import type { ConnectionHealthCandidate } from "@whatsapp-mcp/db/connection-health";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  ConnectionHealthClock,
  ConnectionHealthPersistence,
  type ConnectionHealthPersistenceService,
  ConnectionHealthProvider,
  type ConnectionHealthProviderService,
  reconcileConnectionHealth,
} from "../src/connection-health";
import { createProductionScheduledHandler } from "../src/production";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const candidate: ConnectionHealthCandidate = {
  claimId: "50000000-0000-4000-8000-000000000036",
  connectionId: "20000000-0000-4000-8000-000000000036",
  setupMarker: "cst_000000000000000000036",
  webhookIngressId: "30000000-0000-4000-8000-000000000036",
};
const checkedAt = "2026-07-31T12:05:30.000Z";
const startedAt = "2026-07-31T12:05:00.000Z";

const success = <Value>(value: Value): ProviderControlResult<Value> => ({
  ok: true,
  value,
});

const failure = (
  code: ProviderControlFailure["code"],
): ProviderControlResult<SessionReconciliation> => ({
  error: {
    _tag: "ProviderControlFailure",
    code,
    operation: "safe-read",
    retryAfterMs: null,
    retryDecision: "do_not_retry",
  },
  ok: false,
});

const session = (
  connectionState:
    | "connected"
    | "connecting"
    | "degraded"
    | "disconnected"
    | "reconnect_required",
  suffix = "s",
) => ({
  authority: "narrow-session-authority",
  connectionState,
  session: `wsl_${suffix.repeat(43)}`,
});

const makeHarness = (
  observation: ProviderControlResult<SessionReconciliation>,
  applied = true,
) => {
  const finishes: Array<
    Parameters<ConnectionHealthPersistenceService["finish"]>[0]
  > = [];
  const providerInputs: Array<
    Parameters<ConnectionHealthProviderService["reconcile"]>[0]
  > = [];
  const repairInputs: Array<
    Parameters<ConnectionHealthProviderService["repair"]>[0]
  > = [];
  const events: Array<SafeTelemetryEvent> = [];
  let clockCall = 0;
  const layer = Layer.mergeAll(
    Layer.succeed(ConnectionHealthClock, {
      now: Effect.sync(() => (clockCall++ === 0 ? startedAt : checkedAt)),
    }),
    Layer.succeed(ConnectionHealthPersistence, {
      finish: (input) =>
        Effect.sync(() => {
          finishes.push(input);
          return applied;
        }),
    }),
    Layer.succeed(ConnectionHealthProvider, {
      reconcile: (input) =>
        Effect.sync(() => {
          providerInputs.push(input);
          return observation;
        }),
      repair: (input) =>
        Effect.sync(() => {
          repairInputs.push(input);
          return success(session("connected"));
        }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    }),
  );
  return { events, finishes, layer, providerInputs, repairInputs };
};

describe("five-minute connection health reconciliation", () => {
  test.each([
    {
      expected: {
        gapEvidence: "healthy",
        state: "connected",
        webhookConfigurationHealthy: true,
      },
      name: "confirmed healthy provider and webhook configuration",
      observation: success({
        outcome: "present" as const,
        session: session("connected"),
      }),
    },
    {
      expected: {
        gapEvidence: "connection_unavailable",
        state: "disconnected",
        webhookConfigurationHealthy: true,
      },
      name: "confirmed provider disconnection",
      observation: success({
        outcome: "present" as const,
        session: session("disconnected"),
      }),
    },
    {
      expected: {
        gapEvidence: "connection_unavailable",
        state: "reconnect_required",
        webhookConfigurationHealthy: false,
      },
      name: "confirmed absent provider session",
      observation: success({ outcome: "absent" as const }),
    },
    {
      expected: {
        gapEvidence: "connection_unavailable",
        state: "reconnect_required",
        webhookConfigurationHealthy: true,
      },
      name: "provider reconnect requirement",
      observation: success({
        outcome: "present" as const,
        session: session("reconnect_required"),
      }),
    },
    {
      expected: {
        gapEvidence: "connection_unavailable",
        state: "degraded",
        webhookConfigurationHealthy: true,
      },
      name: "provider degraded state",
      observation: success({
        outcome: "present" as const,
        session: session("degraded"),
      }),
    },
    {
      expected: {
        gapEvidence: "connection_unavailable",
        state: "degraded",
        webhookConfigurationHealthy: true,
      },
      name: "provider state still connecting at reconciliation",
      observation: success({
        outcome: "present" as const,
        session: session("connecting"),
      }),
    },
    {
      expected: {
        gapEvidence: "connection_unavailable",
        state: "degraded",
        webhookConfigurationHealthy: false,
      },
      name: "duplicate provider sessions",
      observation: success({
        outcome: "duplicates" as const,
        sessions: [
          session("connected", "a"),
          session("connected", "b"),
        ] as const,
      }),
    },
    {
      expected: {
        gapEvidence: "healthy",
        state: "connected",
        webhookConfigurationHealthy: true,
      },
      name: "confirmed webhook configuration drift",
      observation: failure("integrity_failed"),
    },
    {
      expected: {
        gapEvidence: "unknown",
        state: "degraded",
        webhookConfigurationHealthy: false,
      },
      name: "unavailable safe read",
      observation: failure("unavailable"),
    },
  ])("records $name without using inactivity as evidence", async (example) => {
    const harness = makeHarness(example.observation);

    const result = await Effect.runPromise(
      reconcileConnectionHealth(candidate, "https://api.example.test").pipe(
        Effect.provide(harness.layer),
      ),
    );

    expect(result).toEqual({ outcome: "applied" });
    expect(harness.providerInputs).toEqual([
      {
        setupMarker: candidate.setupMarker,
        webhookUrl:
          "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000036",
      },
    ]);
    expect(harness.repairInputs).toEqual(
      example.name === "confirmed webhook configuration drift"
        ? harness.providerInputs
        : [],
    );
    expect(harness.finishes).toEqual([
      {
        checkedAt,
        claimId: candidate.claimId,
        connectionId: candidate.connectionId,
        startedAt,
        ...example.expected,
      },
    ]);
    expect(harness.events).toEqual([
      {
        event: "connection_health.reconciliation.completed",
        gapEvidence: example.expected.gapEvidence,
        outcome: "applied",
        service: "api",
        state: example.expected.state,
      },
    ]);
    expect(JSON.stringify(harness.events)).not.toContain(
      candidate.connectionId,
    );
    expect(JSON.stringify(harness.events)).not.toContain(candidate.setupMarker);
  });

  test("does not let a stale claim regress newer evidence", async () => {
    const harness = makeHarness(
      success({ outcome: "present", session: session("disconnected") }),
      false,
    );

    const result = await Effect.runPromise(
      reconcileConnectionHealth(candidate, "https://api.example.test").pipe(
        Effect.provide(harness.layer),
      ),
    );

    expect(result).toEqual({ outcome: "superseded" });
    expect(harness.events).toEqual([
      {
        event: "connection_health.reconciliation.completed",
        gapEvidence: "connection_unavailable",
        outcome: "superseded",
        service: "api",
        state: "disconnected",
      },
    ]);
  });

  test("records the safe-read start so evidence received during the check wins", async () => {
    const order: Array<string> = [];
    const harness = makeHarness(
      success({ outcome: "present", session: session("connected") }),
    );
    let clockCall = 0;
    const layer = Layer.mergeAll(
      harness.layer,
      Layer.succeed(ConnectionHealthClock, {
        now: Effect.sync(() => {
          order.push("clock");
          return clockCall++ === 0 ? startedAt : checkedAt;
        }),
      }),
      Layer.succeed(ConnectionHealthProvider, {
        reconcile: () =>
          Effect.sync(() => {
            order.push("provider");
            return success({
              outcome: "present" as const,
              session: session("connected"),
            });
          }),
        repair: () => Effect.die("repair should not run"),
      }),
    );

    await Effect.runPromise(
      reconcileConnectionHealth(candidate, "https://api.example.test").pipe(
        Effect.provide(layer),
      ),
    );

    expect(order).toEqual(["clock", "provider", "clock"]);
    expect(harness.finishes[0]).toMatchObject({ checkedAt, startedAt });
  });

  test("the five-minute scheduled boundary claims and checks due Connections", async () => {
    const providerInputs: Array<unknown> = [];
    const finishes: Array<unknown> = [];
    const claims: Array<unknown> = [];
    const directoryClaims: Array<unknown> = [];
    const handler = createProductionScheduledHandler(
      {
        DEPLOYMENT_ENVIRONMENT: "development",
        HYPERDRIVE: { connectionString: "test-connection-string" },
        NEON_BRANCH_ID: "br-test",
        OAUTH_ISSUER: "https://api.example.test",
        PROVIDER_CONTROL: {
          reconcileSession: async (input: unknown) => {
            providerInputs.push(input);
            return success({
              outcome: "present" as const,
              session: session("connected"),
            });
          },
          repairSessionConfiguration: async () => success(session("connected")),
        },
      },
      {
        makeConnectionHealthRepository: () => ({
          claim: async (input: unknown) => {
            claims.push(input);
            return [candidate];
          },
          finish: async (input: unknown) => {
            finishes.push(input);
            return true;
          },
        }),
        makeDirectoryRepository: () => ({
          claimContactReconciliations: async (input) => {
            directoryClaims.push(input);
            return [];
          },
          failContactReconciliation: async () => true,
          finishContactReconciliation: async () => true,
        }),
        now: () => checkedAt,
      },
    );

    await handler({
      cron: "*/5 * * * *",
      scheduledTime: Date.parse("2026-07-31T12:05:00.000Z"),
    } as ScheduledController);

    expect(providerInputs).toHaveLength(1);
    expect(claims).toEqual([{ claimedAt: checkedAt, limit: 100 }]);
    expect(directoryClaims).toEqual([{ claimedAt: checkedAt, limit: 100 }]);
    expect(finishes).toEqual([
      {
        checkedAt,
        claimId: candidate.claimId,
        connectionId: candidate.connectionId,
        gapEvidence: "healthy",
        startedAt: checkedAt,
        state: "connected",
        webhookConfigurationHealthy: true,
      },
    ]);
  });
});
