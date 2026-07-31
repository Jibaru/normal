import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";
import {
  WebhookIngressQueue,
  WebhookIngressQueueError,
  type WebhookIngressQueueMessage,
} from "../src/webhook-ingress";
import {
  handleWebhookIngressSweep,
  WebhookRecoveryCheckpoint,
  WebhookRecoveryObjectStore,
  WebhookRecoveryPersistence,
  WebhookRecoveryPersistenceError,
} from "../src/webhook-recovery";

const orphan: WebhookIngressQueueMessage = {
  ciphertext_sha256: "a".repeat(64),
  object_id: "40000000-0000-4000-8000-000000000034",
  payload_bytes: 128,
  personal_account_id: "10000000-0000-4000-8000-000000000034",
  received_at: "2026-07-31T12:00:00.000Z",
  version: 1,
  whatsapp_connection_id: "20000000-0000-4000-8000-000000000034",
};

const claimed: WebhookIngressQueueMessage = {
  ...orphan,
  ciphertext_sha256: "b".repeat(64),
  object_id: "40000000-0000-4000-8000-000000000035",
};

const metadataFor = (message: WebhookIngressQueueMessage) => ({
  ciphertextSha256: message.ciphertext_sha256,
  payloadBytes: String(message.payload_bytes),
  personalAccountId: message.personal_account_id,
  receivedAt: message.received_at,
  version: "1",
  whatsappConnectionId: message.whatsapp_connection_id,
});

const makeHarness = (
  options: {
    readonly persistenceUnavailable?: boolean;
    readonly queueUnavailable?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  const events: SafeTelemetryEvent[] = [];
  const published: WebhookIngressQueueMessage[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(WebhookRecoveryCheckpoint, {
      load: Effect.sync(() => {
        calls.push("checkpoint-load");
        return null;
      }),
      save: (cursor) =>
        Effect.sync(() => {
          calls.push(`checkpoint-save:${cursor ?? "root"}`);
        }),
    }),
    Layer.succeed(WebhookRecoveryObjectStore, {
      list: (cursor) =>
        Effect.sync(() => {
          calls.push(`list:${cursor ?? "root"}`);
          return {
            cursor: "next-page",
            objects: [
              {
                customMetadata: metadataFor(orphan),
                objectKey: `webhook-events/${orphan.object_id}`,
                uploadedAt: "2026-07-31T12:00:01.000Z",
              },
              {
                customMetadata: metadataFor(claimed),
                objectKey: `webhook-events/${claimed.object_id}`,
                uploadedAt: "2026-07-31T12:00:02.000Z",
              },
              {
                customMetadata: {},
                objectKey:
                  "webhook-events/40000000-0000-4000-8000-000000000036",
                uploadedAt: "2026-07-31T12:00:03.000Z",
              },
              {
                customMetadata: metadataFor({
                  ...orphan,
                  object_id: "40000000-0000-4000-8000-000000000037",
                  received_at: "2026-07-31T12:14:30.000Z",
                }),
                objectKey:
                  "webhook-events/40000000-0000-4000-8000-000000000037",
                uploadedAt: "2026-07-31T12:14:31.000Z",
              },
            ],
          };
        }),
    }),
    Layer.succeed(WebhookRecoveryPersistence, {
      filterUnclaimed: (messages) =>
        options.persistenceUnavailable
          ? Effect.fail(new WebhookRecoveryPersistenceError())
          : Effect.sync(() => {
              calls.push("claim-check");
              expect(messages).toEqual([orphan, claimed]);
              return [orphan];
            }),
    }),
    Layer.succeed(WebhookIngressQueue, {
      publish: (message) =>
        options.queueUnavailable
          ? Effect.fail(new WebhookIngressQueueError())
          : Effect.sync(() => {
              calls.push("queue");
              published.push(message);
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

describe("Webhook Event orphan recovery", () => {
  test("re-enqueues only validated, old, unclaimed encrypted ingress objects", async () => {
    const harness = makeHarness();

    await handleWebhookIngressSweep("2026-07-31T12:15:00.000Z", harness.layer);

    expect(harness.calls).toEqual([
      "checkpoint-load",
      "list:root",
      "claim-check",
      "queue",
      "checkpoint-save:next-page",
    ]);
    expect(harness.published).toEqual([orphan]);
    expect(harness.events).toContainEqual({
      candidateCount: 2,
      enqueuedCount: 1,
      event: "webhook_ingress.recovery.completed",
      invalidObjectCount: 1,
      service: "api",
    });
  });

  test("fails the scheduled attempt when Neon or Queue is transiently unavailable", async () => {
    await expect(
      handleWebhookIngressSweep(
        "2026-07-31T12:15:00.000Z",
        makeHarness({ persistenceUnavailable: true }).layer,
      ),
    ).rejects.toBeDefined();
    await expect(
      handleWebhookIngressSweep(
        "2026-07-31T12:15:00.000Z",
        makeHarness({ queueUnavailable: true }).layer,
      ),
    ).rejects.toBeDefined();
  });
});
