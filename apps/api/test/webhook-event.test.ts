import type { WebhookEventProcessingMaterial } from "@whatsapp-mcp/db/webhook-event";
import type { NormalizedWebhookDelivery } from "@whatsapp-mcp/wasender/webhook";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  EncryptionError,
  EnvelopeEncryptionService,
} from "../src/encryption/envelope";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";
import {
  handleWebhookDeadLetterBatch,
  handleWebhookEventBatch,
  jitteredWebhookRetryDelaySeconds,
  WebhookEventClock,
  WebhookEventIdentifiers,
  WebhookEventNormalization,
  WebhookEventNormalizationError,
  WebhookEventObjectStore,
  WebhookEventObjectStoreError,
  WebhookEventPersistence,
  WebhookEventPersistenceError,
  type WebhookEventQueueMessage,
  WebhookEventRetrySchedule,
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
const incidentReference = "50000000-0000-4000-8000-000000000033";

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
      contact: {
        active: true,
        displayName: "Ada",
        identity: `wi1_${"i".repeat(43)}` as never,
        phoneNumber: "+15550199",
        recipient: `wi1_${"r".repeat(43)}` as never,
      },
      evidence: {
        occurredAt: "2026-07-31T12:09:30.000Z",
        version: "wv1.test.signature" as never,
      },
      itemIdentity: `wi1_${"directory_contact".padEnd(43, "0")}` as never,
      itemIndex: 2,
      kind: "directory_contact",
    },
    {
      classification: "unsupported_item_kind",
      itemIndex: 3,
      kind: "unsupported",
    },
  ],
};

interface HarnessOptions {
  readonly deadLetterUnavailable?: boolean;
  readonly decryptionUnavailable?: boolean;
  readonly normalizationUnavailable?: boolean;
  readonly permanentlyInvalidSource?: boolean;
  readonly objectStoreUnavailable?: boolean;
  readonly persistenceUnavailable?: boolean;
  readonly delivery?: NormalizedWebhookDelivery;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const calls: string[] = [];
  const telemetry: SafeTelemetryEvent[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(WebhookEventObjectStore, {
      load: () =>
        options.objectStoreUnavailable
          ? Effect.fail(new WebhookEventObjectStoreError())
          : Effect.succeed({
              body: storedCiphertext,
              customMetadata: {
                ciphertextSha256: options.permanentlyInvalidSource
                  ? "f".repeat(64)
                  : message.ciphertext_sha256,
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
      deadLetter: () =>
        options.deadLetterUnavailable
          ? Effect.fail(new WebhookEventPersistenceError())
          : Effect.sync(() => {
              calls.push("dead-letter");
              return {
                incidentReference,
                outcome: "gap_recorded" as const,
              };
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
      projectGroup: (input, protect) =>
        Effect.promise(async () => {
          expect(input.namePrefixIndexes).toHaveLength(4);
          expect(JSON.stringify(input.namePrefixIndexes)).not.toContain("fam");
          const protectedFields = await protect(
            "60000000-0000-4000-8000-000000000039",
          );
          expect(
            protectedFields.displayName?.ciphertext.byteLength,
          ).toBeGreaterThan(0);
          calls.push(`project-group:${input.displayName ?? "null"}`);
          return "applied" as const;
        }),
      projectDirectoryContact: (input, compareVersions) =>
        Effect.promise(async () => {
          calls.push("project-contact");
          expect(input.publicId).toBe("ctc_123456789012345678901");
          expect(input.displayNameCiphertext).not.toBeNull();
          expect(input.phoneCiphertext).not.toBeNull();
          expect(input.providerIdentityCiphertext.ciphertext).not.toContain(
            input.providerIdentityIndex,
          );
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
    Layer.succeed(WebhookEventIdentifiers, {
      nextContactId: Effect.succeed("ctc_123456789012345678901"),
    }),
    Layer.succeed(WebhookEventRetrySchedule, {
      delaySeconds: (attempt) =>
        Effect.sync(() => {
          expect(attempt).toBe(1);
          return 10_123;
        }),
    }),
    Layer.succeed(WebhookEventNormalization, {
      make: (key) =>
        options.normalizationUnavailable
          ? Effect.fail(new WebhookEventNormalizationError())
          : Effect.sync(() => {
              expect(key).toEqual(identityKey);
              return {
                compareVersions: () => Effect.succeed("equal" as const),
                normalize: () => Effect.succeed(options.delivery ?? delivery),
              };
            }),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("not used"),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ context }) =>
        options.decryptionUnavailable
          ? Effect.fail(new EncryptionError({ operation: "decrypt" }))
          : context.fieldOrObjectPurpose === "webhook-identity-key"
            ? Effect.succeed(identityKey.slice())
            : Effect.succeed(new Uint8Array(message.payload_bytes)),
      encrypt: ({ plaintext }) =>
        Effect.succeed({
          ciphertext: btoa(
            String.fromCharCode(...plaintext, ...new Uint8Array(17).fill(9)),
          ),
          keyVersion: 1,
          nonce: btoa(String.fromCharCode(...new Uint8Array(12).fill(8))),
          version: 1,
        }),
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
      "project-contact",
      "quarantine:unsupported_item_kind",
      "complete",
    ]);
    expect(queued.acknowledgements).toEqual(["ack"]);
    expect(queued.retries).toEqual([]);
    expect(harness.telemetry).toContainEqual({
      appliedCount: 2,
      duplicateCount: 0,
      event: "webhook_event.processing.completed",
      outcome: "completed",
      quarantinedCount: 2,
      service: "api",
      supersededCount: 0,
    });
  });

  test("encrypts and projects authenticated group items", async () => {
    const recipient = `wi1_${"group".padEnd(43, "0")}` as never;
    const harness = makeHarness({
      delivery: {
        items: [
          {
            evidence: {
              occurredAt: "2026-07-31T12:09:00.000Z",
              version: "wv1.test.signature" as never,
            },
            group: {
              displayName: "Family",
              identity: recipient,
              joined: true,
              recipient,
            },
            itemIdentity: `wi1_${"group-item".padEnd(43, "0")}` as never,
            itemIndex: 0,
            kind: "directory_group",
          },
        ],
      },
    });
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
      "project-group:Family",
      "complete",
    ]);
    expect(queued.acknowledgements).toEqual(["ack"]);
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
    expect(queued.retries).toEqual([10_123]);
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

  test.each([
    ["R2", { objectStoreUnavailable: true }],
    ["KMS", { decryptionUnavailable: true }],
    ["Neon", { persistenceUnavailable: true }],
    ["Worker", { normalizationUnavailable: true }],
  ] as const)(
    "retries a transient %s failure with jitter and without acknowledging",
    async (_boundary, options) => {
      const harness = makeHarness(options);
      const queued = queueMessage(message);

      await handleWebhookEventBatch(
        {
          messages: [queued.message],
          queue: "whatsapp-mcp-ingestion",
        } as unknown as MessageBatch,
        harness.layer,
      );

      expect(queued.acknowledgements).toEqual([]);
      expect(queued.retries).toEqual([10_123]);
    },
  );

  test("records a processing Ingestion Gap and alerts before acknowledging DLQ work", async () => {
    const harness = makeHarness();
    const queued = queueMessage(message);

    await handleWebhookDeadLetterBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion-dlq",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual(["dead-letter"]);
    expect(queued.acknowledgements).toEqual(["ack"]);
    expect(queued.retries).toEqual([]);
    expect(harness.telemetry).toContainEqual({
      event: "webhook_event.dead_letter.completed",
      incidentReference,
      outcome: "gap_recorded",
      service: "api",
    });
  });

  test("records and acknowledges permanent source validation failure without transient retry", async () => {
    const harness = makeHarness({ permanentlyInvalidSource: true });
    const queued = queueMessage(message);

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual(["dead-letter"]);
    expect(queued.acknowledgements).toEqual(["ack"]);
    expect(queued.retries).toEqual([]);
    expect(harness.telemetry).toContainEqual({
      event: "webhook_event.dead_letter.completed",
      incidentReference,
      outcome: "gap_recorded",
      service: "api",
    });
  });

  test("retries DLQ work without acknowledgement when the gap transaction fails", async () => {
    const harness = makeHarness({ deadLetterUnavailable: true });
    const queued = queueMessage(message);

    await handleWebhookDeadLetterBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion-dlq",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(queued.acknowledgements).toEqual([]);
    expect(queued.retries).toEqual([300]);
    expect(harness.telemetry).not.toContainEqual(
      expect.objectContaining({
        event: "webhook_event.dead_letter.completed",
      }),
    );
  });

  test("bounds jitter around three hours for the seven-retry Queue policy", () => {
    expect(jitteredWebhookRetryDelaySeconds(0)).toBe(9_900);
    expect(jitteredWebhookRetryDelaySeconds(0.5)).toBe(10_800);
    expect(jitteredWebhookRetryDelaySeconds(1)).toBe(11_700);
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
