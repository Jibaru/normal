import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";
import type { WebhookEventQueueMessage } from "../src/webhook-event";
import {
  handleWebhookReplayBatch,
  handleWebhookSourceRetention,
  WebhookReplayClock,
  WebhookReplayPersistence,
  WebhookReplayPersistenceError,
  WebhookReplayQueue,
  WebhookReplayQueueError,
  type WebhookReplayRequest,
  WebhookSourceObjectStore,
  WebhookSourceObjectStoreError,
} from "../src/webhook-replay";

const canonicalMessage: WebhookEventQueueMessage = {
  ciphertext_sha256: "a".repeat(64),
  object_id: "40000000-0000-4000-8000-000000000035",
  payload_bytes: 128,
  personal_account_id: "10000000-0000-4000-8000-000000000035",
  received_at: "2026-07-31T12:10:00.000Z",
  version: 1,
  whatsapp_connection_id: "20000000-0000-4000-8000-000000000035",
};

const request: WebhookReplayRequest = {
  incident_reference: "50000000-0000-4000-8000-000000000035",
  operator_reference: "b".repeat(64),
  reason_code: "dependency_recovered",
  request_id: "60000000-0000-4000-8000-000000000035",
  requested_at: "2026-08-01T12:10:00.000Z",
  version: 1,
};

const queued = (body: unknown) => {
  const acknowledgements: string[] = [];
  const retries: number[] = [];
  return {
    acknowledgements,
    message: {
      ack: () => acknowledgements.push("ack"),
      attempts: 1,
      body,
      id: "replay-request",
      retry: (options?: { readonly delaySeconds?: number }) =>
        retries.push(options?.delaySeconds ?? 0),
      timestamp: new Date(request.requested_at),
    } as unknown as Message,
    retries,
  };
};

const makeHarness = (
  options: {
    readonly alreadyDispatched?: boolean;
    readonly persistenceUnavailable?: boolean;
    readonly publishUnavailable?: boolean;
    readonly sourceUnavailable?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  const events: SafeTelemetryEvent[] = [];
  const published: WebhookEventQueueMessage[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(WebhookReplayClock, {
      now: Effect.succeed("2026-08-01T12:10:01.000Z"),
    }),
    Layer.succeed(WebhookReplayPersistence, {
      complete: ({ requestId }) =>
        Effect.sync(() => {
          calls.push(`complete:${requestId}`);
        }),
      finalizeExpiredSource: ({ eventId }) =>
        Effect.sync(() => {
          calls.push(`finalize:${eventId}`);
          return true;
        }),
      listExpiredSources: () => Effect.succeed([]),
      prepare: ({ request: input }) =>
        options.persistenceUnavailable
          ? Effect.fail(new WebhookReplayPersistenceError())
          : Effect.sync(() => {
              calls.push(`prepare:${input.request_id}`);
              if (options.sourceUnavailable) {
                return { outcome: "source_unavailable" as const };
              }
              return {
                message: canonicalMessage,
                outcome: options.alreadyDispatched
                  ? ("already_dispatched" as const)
                  : ("pending" as const),
              };
            }),
    }),
    Layer.succeed(WebhookReplayQueue, {
      publish: (message) =>
        options.publishUnavailable
          ? Effect.fail(new WebhookReplayQueueError())
          : Effect.sync(() => {
              calls.push("publish");
              published.push(message);
            }),
    }),
    Layer.succeed(WebhookSourceObjectStore, {
      delete: (eventId) =>
        Effect.sync(() => {
          calls.push(`delete:${eventId}`);
        }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    }),
  );
  return { calls, events, layer, published };
};

describe("immutable Webhook Event replay", () => {
  test("audits the opaque request before publishing the canonical normal-ingestion envelope", async () => {
    const harness = makeHarness();
    const work = queued(request);

    await handleWebhookReplayBatch(
      {
        messages: [work.message],
        queue: "whatsapp-mcp-ingestion-replay",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(Object.keys(request).sort()).toEqual([
      "incident_reference",
      "operator_reference",
      "reason_code",
      "request_id",
      "requested_at",
      "version",
    ]);
    expect(JSON.stringify(request)).not.toContain("payload");
    expect(harness.calls).toEqual([
      `prepare:${request.request_id}`,
      "publish",
      `complete:${request.request_id}`,
    ]);
    expect(harness.published).toEqual([canonicalMessage]);
    expect(work.acknowledgements).toEqual(["ack"]);
    expect(work.retries).toEqual([]);
    expect(harness.events).toContainEqual({
      attemptReference: request.request_id,
      event: "webhook_event.replay.completed",
      outcome: "dispatched",
      service: "api",
    });
  });

  test("acknowledges an already-dispatched attempt without publishing twice", async () => {
    const harness = makeHarness({ alreadyDispatched: true });
    const work = queued(request);

    await handleWebhookReplayBatch(
      { messages: [work.message] } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual([`prepare:${request.request_id}`]);
    expect(harness.published).toEqual([]);
    expect(work.acknowledgements).toEqual(["ack"]);
    expect(harness.events).toContainEqual({
      attemptReference: request.request_id,
      event: "webhook_event.replay.completed",
      outcome: "already_dispatched",
      service: "api",
    });
  });

  test("retries without acknowledgement when audit or ingestion publication fails", async () => {
    for (const harness of [
      makeHarness({ persistenceUnavailable: true }),
      makeHarness({ publishUnavailable: true }),
    ]) {
      const work = queued(request);
      await handleWebhookReplayBatch(
        { messages: [work.message] } as unknown as MessageBatch,
        harness.layer,
      );
      expect(work.acknowledgements).toEqual([]);
      expect(work.retries).toEqual([300]);
    }
  });

  test("rejects unavailable immutable sources and malformed requests without dispatch", async () => {
    const unavailable = makeHarness({ sourceUnavailable: true });
    const unavailableWork = queued(request);
    await handleWebhookReplayBatch(
      { messages: [unavailableWork.message] } as unknown as MessageBatch,
      unavailable.layer,
    );
    expect(unavailable.published).toEqual([]);
    expect(unavailableWork.acknowledgements).toEqual(["ack"]);
    expect(unavailable.events).toContainEqual({
      attemptReference: request.request_id,
      event: "webhook_event.replay.completed",
      outcome: "source_unavailable",
      service: "api",
    });

    const malformed = makeHarness();
    const malformedWork = queued({ ...request, payload: "edited" });
    await handleWebhookReplayBatch(
      { messages: [malformedWork.message] } as unknown as MessageBatch,
      malformed.layer,
    );
    expect(malformed.calls).toEqual([]);
    expect(malformedWork.acknowledgements).toEqual(["ack"]);
  });

  test("acknowledges a replay request with an invalid timestamp without failing its batch", async () => {
    const harness = makeHarness();
    const invalid = queued({ ...request, requested_at: "not-a-timestamp" });
    const valid = queued(request);

    await handleWebhookReplayBatch(
      { messages: [invalid.message, valid.message] } as unknown as MessageBatch,
      harness.layer,
    );

    expect(invalid.acknowledgements).toEqual(["ack"]);
    expect(valid.acknowledgements).toEqual(["ack"]);
    expect(harness.published).toEqual([canonicalMessage]);
    expect(harness.events).toContainEqual({
      attemptReference: null,
      event: "webhook_event.replay.completed",
      outcome: "invalid_message",
      service: "api",
    });
  });
});

describe("Webhook Event source retention", () => {
  test("deletes expired ciphertext before dropping source and quarantine references", async () => {
    const first = canonicalMessage.object_id;
    const second = "40000000-0000-4000-8000-000000000036";
    const calls: string[] = [];
    const events: SafeTelemetryEvent[] = [];
    let listed = false;
    const layer = Layer.mergeAll(
      Layer.succeed(WebhookReplayPersistence, {
        complete: () => Effect.die("not used"),
        finalizeExpiredSource: ({ eventId }) =>
          Effect.sync(() => {
            calls.push(`finalize:${eventId}`);
            return true;
          }),
        listExpiredSources: () =>
          Effect.sync(() => {
            if (listed) return [];
            listed = true;
            return [first, second];
          }),
        prepare: () => Effect.die("not used"),
      }),
      Layer.succeed(WebhookSourceObjectStore, {
        delete: (eventId) =>
          Effect.sync(() => {
            calls.push(`delete:${eventId}`);
          }),
      }),
      Layer.succeed(SafeTelemetry, {
        emit: (event) => Effect.sync(() => events.push(event)),
      }),
    );

    await handleWebhookSourceRetention("2026-08-07T12:10:00.000Z", layer);

    expect(calls).toEqual([
      `delete:${first}`,
      `finalize:${first}`,
      `delete:${second}`,
      `finalize:${second}`,
    ]);
    expect(events).toEqual([
      {
        deletedCount: 2,
        event: "webhook_event.source_retention.completed",
        service: "api",
      },
    ]);
  });

  test("does not drop the database reference when R2 deletion fails", async () => {
    const harness = makeHarness();
    const layer = Layer.mergeAll(
      harness.layer,
      Layer.succeed(WebhookReplayPersistence, {
        complete: () => Effect.die("not used"),
        finalizeExpiredSource: ({ eventId }) =>
          Effect.sync(() => {
            harness.calls.push(`finalize:${eventId}`);
            return true;
          }),
        listExpiredSources: () => Effect.succeed([canonicalMessage.object_id]),
        prepare: () => Effect.die("not used"),
      }),
      Layer.succeed(WebhookSourceObjectStore, {
        delete: () => Effect.fail(new WebhookSourceObjectStoreError()),
      }),
    );

    await expect(
      handleWebhookSourceRetention("2026-08-07T12:10:00.000Z", layer),
    ).rejects.toBeDefined();
    expect(harness.calls).not.toContain(
      `finalize:${canonicalMessage.object_id}`,
    );
  });
});
