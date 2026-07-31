import type { WebhookEventProcessingMaterial } from "@whatsapp-mcp/db/webhook-event";
import type { NormalizedWebhookDelivery } from "@whatsapp-mcp/wasender/webhook";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";
import {
  handleWebhookEventBatch,
  WebhookEventClock,
  WebhookEventNormalization,
  WebhookEventObjectStore,
  WebhookEventPersistence,
  WebhookEventPersistenceError,
  type WebhookEventQueueMessage,
} from "../src/webhook-event";

const encoder = new TextEncoder();
const message: WebhookEventQueueMessage = {
  ciphertext_sha256:
    "9b209e3192476f6747c3239d13de46ee2951bb8fc09468f7d2bb9cf0d82d1de0",
  object_id: "40000000-0000-4000-8000-000000000033",
  payload_bytes: 128,
  personal_account_id: "10000000-0000-4000-8000-000000000033",
  received_at: "2026-07-31T12:10:00.000Z",
  version: 1,
  whatsapp_connection_id: "20000000-0000-4000-8000-000000000033",
};
const storedCiphertext = encoder.encode(
  JSON.stringify({
    ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
    key_version: 1,
    nonce: "AQIDBAUGBwgJCgsM",
    version: 1,
  }),
);
const identityKey = new Uint8Array(32).fill(33);

const material: WebhookEventProcessingMaterial = {
  accountKey: {
    ciphertext: "AQI=",
    keyVersion: 1,
    kmsKeyId: "kms-content-root",
    personalAccountId: message.personal_account_id,
    version: 1,
  },
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
    connectionId: message.whatsapp_connection_id,
    keyVersion: 1,
    nonce: "AwMDAwMDAwMDAwMD",
    personalAccountId: message.personal_account_id,
    version: 1,
  },
  identityKey: {
    ciphertext: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
    keyVersion: 1,
    nonce: "BgYGBgYGBgYGBgYG",
    version: 1,
  },
};

const delivery: NormalizedWebhookDelivery = {
  items: [
    {
      classification: "invalid_item_shape",
      itemIndex: 0,
      kind: "malformed",
    },
    {
      evidence: {
        occurredAt: "2026-07-31T12:09:00.000Z",
        version: "wv1.test.signature" as never,
      },
      itemIdentity: `wi1_${"connection_state".padEnd(43, "0")}` as never,
      itemIndex: 1,
      kind: "connection_state",
      state: "connected",
    },
    {
      classification: "unsupported_item_kind",
      itemIndex: 2,
      kind: "unsupported",
    },
  ],
};

interface HarnessOptions {
  readonly persistenceUnavailable?: boolean;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const calls: string[] = [];
  const telemetry: SafeTelemetryEvent[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(WebhookEventObjectStore, {
      load: () =>
        Effect.succeed({
          body: storedCiphertext,
          customMetadata: {
            ciphertextSha256: message.ciphertext_sha256,
            payloadBytes: String(message.payload_bytes),
            personalAccountId: message.personal_account_id,
            receivedAt: message.received_at,
            version: "1",
            whatsappConnectionId: message.whatsapp_connection_id,
          },
        }),
    }),
    Layer.succeed(WebhookEventPersistence, {
      complete: () =>
        Effect.sync(() => {
          calls.push("complete");
        }),
      prepare: () =>
        options.persistenceUnavailable
          ? Effect.fail(new WebhookEventPersistenceError())
          : Effect.sync(() => {
              calls.push("prepare");
              return material;
            }),
      projectConnectionState: (_input, compareVersions) =>
        Effect.promise(async () => {
          calls.push("project");
          expect(
            await compareVersions("wv1.test.signature", "wv1.test.signature"),
          ).toBe("equal");
          return "applied" as const;
        }),
      quarantine: (input) =>
        Effect.sync(() => {
          calls.push(`quarantine:${input.classification}`);
        }),
    }),
    Layer.succeed(WebhookEventClock, {
      now: Effect.succeed("2026-07-31T12:10:01.000Z"),
    }),
    Layer.succeed(WebhookEventNormalization, {
      make: (key) =>
        Effect.sync(() => {
          expect(key).toEqual(identityKey);
          return {
            compareVersions: () => Effect.succeed("equal" as const),
            normalize: () => Effect.succeed(delivery),
          };
        }),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("not used"),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ context }) =>
        context.fieldOrObjectPurpose === "webhook-identity-key"
          ? Effect.succeed(identityKey.slice())
          : Effect.succeed(new Uint8Array(message.payload_bytes)),
      encrypt: () => Effect.die("not used"),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          telemetry.push(event);
        }),
    }),
  );
  return { calls, layer, telemetry };
};

const queueMessage = (body: unknown) => {
  const acknowledgements: string[] = [];
  const retries: number[] = [];
  return {
    acknowledgements,
    message: {
      ack: () => acknowledgements.push("ack"),
      attempts: 1,
      body,
      id: "webhook-event-message",
      retry: (options?: { readonly delaySeconds?: number }) =>
        retries.push(options?.delaySeconds ?? 0),
      timestamp: new Date(message.received_at),
    } as unknown as Message,
    retries,
  };
};

describe("Webhook Event processing", () => {
  test("independently quarantines permanent siblings and projects connection state", async () => {
    const harness = makeHarness();
    const queued = queueMessage(message);

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual([
      "prepare",
      "quarantine:invalid_item_shape",
      "project",
      "quarantine:unsupported_item_kind",
      "complete",
    ]);
    expect(queued.acknowledgements).toEqual(["ack"]);
    expect(queued.retries).toEqual([]);
    expect(harness.telemetry).toContainEqual({
      appliedCount: 1,
      duplicateCount: 0,
      event: "webhook_event.processing.completed",
      outcome: "completed",
      quarantinedCount: 2,
      service: "api",
      supersededCount: 0,
    });
  });

  test("retries transient processing failures without acknowledging", async () => {
    const harness = makeHarness({ persistenceUnavailable: true });
    const queued = queueMessage(message);

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(queued.acknowledgements).toEqual([]);
    expect(queued.retries).toEqual([10_800]);
    expect(harness.telemetry).toContainEqual({
      appliedCount: 0,
      duplicateCount: 0,
      event: "webhook_event.processing.completed",
      outcome: "retry",
      quarantinedCount: 0,
      service: "api",
      supersededCount: 0,
    });
  });

  test("acknowledges a permanently invalid Queue envelope without touching data", async () => {
    const harness = makeHarness();
    const queued = queueMessage({ object_id: "not-an-event" });

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual([]);
    expect(queued.acknowledgements).toEqual(["ack"]);
    expect(queued.retries).toEqual([]);
    expect(harness.telemetry).toContainEqual({
      appliedCount: 0,
      duplicateCount: 0,
      event: "webhook_event.processing.completed",
      outcome: "invalid_message",
      quarantinedCount: 0,
      service: "api",
      supersededCount: 0,
    });
  });
});
