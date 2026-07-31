import type {
  PrepareWebhookReplayResult,
  WebhookReplayReasonCode,
} from "@whatsapp-mcp/db/webhook-replay";
import { Context, Data, Effect, type Layer } from "effect";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";
import type { WebhookEventQueueMessage } from "./webhook-event";

export interface WebhookReplayRequest {
  readonly incident_reference: string;
  readonly operator_reference: string;
  readonly reason_code: WebhookReplayReasonCode;
  readonly request_id: string;
  readonly requested_at: string;
  readonly version: 1;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const reasons = new Set<WebhookReplayReasonCode>([
  "dependency_recovered",
  "schema_support_deployed",
  "transient_incident_resolved",
]);

const isCanonicalTimestamp = (value: string): boolean => {
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value
  );
};

export const isWebhookReplayRequest = (
  value: unknown,
): value is WebhookReplayRequest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).length === 6 &&
    request.version === 1 &&
    typeof request.request_id === "string" &&
    uuidPattern.test(request.request_id) &&
    typeof request.incident_reference === "string" &&
    uuidPattern.test(request.incident_reference) &&
    typeof request.operator_reference === "string" &&
    /^[a-f0-9]{64}$/u.test(request.operator_reference) &&
    typeof request.reason_code === "string" &&
    reasons.has(request.reason_code as WebhookReplayReasonCode) &&
    typeof request.requested_at === "string" &&
    isCanonicalTimestamp(request.requested_at)
  );
};

export class WebhookReplayPersistenceError extends Data.TaggedError(
  "WebhookReplayPersistenceError",
) {}

export class WebhookReplayQueueError extends Data.TaggedError(
  "WebhookReplayQueueError",
) {}

export class WebhookSourceObjectStoreError extends Data.TaggedError(
  "WebhookSourceObjectStoreError",
) {}

export interface WebhookReplayPersistenceService {
  readonly complete: (input: {
    readonly dispatchedAt: string;
    readonly requestId: string;
  }) => Effect.Effect<void, WebhookReplayPersistenceError>;
  readonly finalizeExpiredSource: (input: {
    readonly eventId: string;
    readonly observedAt: string;
  }) => Effect.Effect<boolean, WebhookReplayPersistenceError>;
  readonly listExpiredSources: (input: {
    readonly limit: number;
    readonly observedAt: string;
  }) => Effect.Effect<ReadonlyArray<string>, WebhookReplayPersistenceError>;
  readonly prepare: (input: {
    readonly observedAt: string;
    readonly request: WebhookReplayRequest;
  }) => Effect.Effect<
    PrepareWebhookReplayResult,
    WebhookReplayPersistenceError
  >;
}

export const WebhookReplayPersistence =
  Context.GenericTag<WebhookReplayPersistenceService>(
    "@whatsapp-mcp/api/WebhookReplayPersistence",
  );

export interface WebhookReplayQueueService {
  readonly publish: (
    message: WebhookEventQueueMessage,
  ) => Effect.Effect<void, WebhookReplayQueueError>;
}

export const WebhookReplayQueue = Context.GenericTag<WebhookReplayQueueService>(
  "@whatsapp-mcp/api/WebhookReplayQueue",
);

export interface WebhookReplayClockService {
  readonly now: Effect.Effect<string>;
}

export const WebhookReplayClock = Context.GenericTag<WebhookReplayClockService>(
  "@whatsapp-mcp/api/WebhookReplayClock",
);

export interface WebhookSourceObjectStoreService {
  readonly delete: (
    eventId: string,
  ) => Effect.Effect<void, WebhookSourceObjectStoreError>;
}

export const WebhookSourceObjectStore =
  Context.GenericTag<WebhookSourceObjectStoreService>(
    "@whatsapp-mcp/api/WebhookSourceObjectStore",
  );

type ReplayOutcome =
  | "already_dispatched"
  | "dispatched"
  | "invalid_message"
  | "source_unavailable";

const emitReplay = (attemptReference: string | null, outcome: ReplayOutcome) =>
  Effect.gen(function* () {
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      attemptReference,
      event: "webhook_event.replay.completed",
      outcome,
      service: "api",
    });
  });

export type WebhookReplayRequirements =
  | SafeTelemetryService
  | WebhookReplayClockService
  | WebhookReplayPersistenceService
  | WebhookReplayQueueService;

export const handleWebhookReplayBatch = (
  batch: MessageBatch,
  layer: Layer.Layer<WebhookReplayRequirements, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.forEach(
      batch.messages,
      (queued) => {
        const request = queued.body;
        if (!isWebhookReplayRequest(request)) {
          return emitReplay(null, "invalid_message").pipe(
            Effect.tap(() => Effect.sync(() => queued.ack())),
          );
        }
        return Effect.gen(function* () {
          const persistence = yield* WebhookReplayPersistence;
          const clock = yield* WebhookReplayClock;
          const prepared = yield* persistence.prepare({
            observedAt: yield* clock.now,
            request,
          });
          if (prepared.outcome === "source_unavailable") {
            yield* emitReplay(request.request_id, "source_unavailable");
            return;
          }
          if (prepared.outcome === "already_dispatched") {
            yield* emitReplay(request.request_id, "already_dispatched");
            return;
          }
          const queue = yield* WebhookReplayQueue;
          yield* queue.publish(prepared.message);
          yield* persistence.complete({
            dispatchedAt: yield* clock.now,
            requestId: request.request_id,
          });
          yield* emitReplay(request.request_id, "dispatched");
        }).pipe(
          Effect.tap(() => Effect.sync(() => queued.ack())),
          Effect.catchAll(() =>
            Effect.sync(() => queued.retry({ delaySeconds: 300 })),
          ),
        );
      },
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.provide(layer)),
  );

export type WebhookSourceRetentionRequirements =
  | SafeTelemetryService
  | WebhookReplayPersistenceService
  | WebhookSourceObjectStoreService;

export const handleWebhookSourceRetention = (
  observedAt: string,
  layer: Layer.Layer<WebhookSourceRetentionRequirements, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (!Number.isFinite(Date.parse(observedAt))) {
        return yield* Effect.die("invalid Webhook Event retention time");
      }
      const persistence = yield* WebhookReplayPersistence;
      const objects = yield* WebhookSourceObjectStore;
      let deletedCount = 0;
      while (true) {
        const expired = yield* persistence.listExpiredSources({
          limit: 100,
          observedAt,
        });
        for (const eventId of expired) {
          yield* objects.delete(eventId);
          const finalized = yield* persistence.finalizeExpiredSource({
            eventId,
            observedAt,
          });
          if (finalized) deletedCount += 1;
        }
        if (expired.length < 100) break;
      }
      const telemetry = yield* SafeTelemetry;
      yield* telemetry.emit({
        deletedCount,
        event: "webhook_event.source_retention.completed",
        service: "api",
      });
    }).pipe(Effect.provide(layer)),
  );
