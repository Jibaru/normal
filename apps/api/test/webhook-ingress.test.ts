import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";
import {
  createWebhookIngressHandler,
  WebhookIngressClock,
  WebhookIngressIdentifiers,
  WebhookIngressObjectStore,
  WebhookIngressObjectStoreError,
  WebhookIngressPersistence,
  WebhookIngressPersistenceError,
  WebhookIngressQueue,
  WebhookIngressQueueError,
  type WebhookIngressQueueMessage,
} from "../src/webhook-ingress";

const encoder = new TextEncoder();
const ingressId = "30000000-0000-4000-8000-000000000032";
const accountId = "10000000-0000-4000-8000-000000000032";
const connectionId = "20000000-0000-4000-8000-000000000032";
const objectId = "40000000-0000-4000-8000-000000000032";
const endpoint = `https://api.example.test/webhooks/wasender/${ingressId}`;
const authority = encoder.encode(
  JSON.stringify({
    sessionCredential: "session-credential",
    webhookVerificationSecret: "connection-webhook-secret",
  }),
);
const validPayload = encoder.encode(
  JSON.stringify({
    data: { messages: [] },
    event: "messages.upsert",
    sessionId: "session-credential",
  }),
);

const ingressMaterial = {
  accountKey: {
    ciphertext: "AQI=",
    keyVersion: 1,
    kmsKeyId: "kms-content-root",
    personalAccountId: accountId,
    version: 1 as const,
  },
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: "AwQ=",
    connectionId,
    keyVersion: 2,
    nonce: "BQY=",
    personalAccountId: accountId,
    version: 1 as const,
  },
  personalAccountId: accountId,
  providerAuthority: {
    ciphertext: "Bwg=",
    keyVersion: 2,
    nonce: "CQo=",
    version: 1 as const,
  },
  whatsappConnectionId: connectionId,
};

const makeHarness = (
  options: {
    readonly persistenceUnavailable?: boolean;
    readonly queueUnavailable?: boolean;
    readonly storeUnavailable?: boolean;
    readonly unknownIngress?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  const encryptedPlaintexts: Uint8Array[] = [];
  const plaintextReferences: Uint8Array[] = [];
  const events: SafeTelemetryEvent[] = [];
  const objects: Array<{
    readonly body: Uint8Array;
    readonly customMetadata: Readonly<Record<string, string>>;
    readonly objectKey: string;
  }> = [];
  const queueMessages: WebhookIngressQueueMessage[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(WebhookIngressPersistence, {
      resolve: () =>
        options.persistenceUnavailable
          ? Effect.fail(new WebhookIngressPersistenceError())
          : Effect.succeed(options.unknownIngress ? null : ingressMaterial),
    }),
    Layer.succeed(WebhookIngressClock, {
      now: Effect.succeed("2026-07-31T12:00:00.000Z"),
    }),
    Layer.succeed(WebhookIngressIdentifiers, {
      nextObjectId: Effect.succeed(objectId),
    }),
    Layer.succeed(WebhookIngressObjectStore, {
      put: (input) =>
        Effect.sync(() => {
          calls.push("r2");
          if (options.storeUnavailable) {
            throw new WebhookIngressObjectStoreError();
          }
          objects.push(input);
        }).pipe(
          Effect.catchAllDefect((error) =>
            error instanceof WebhookIngressObjectStoreError
              ? Effect.fail(error)
              : Effect.die(error),
          ),
        ),
    }),
    Layer.succeed(WebhookIngressQueue, {
      publish: (message) =>
        Effect.sync(() => {
          calls.push("queue");
          if (options.queueUnavailable) {
            throw new WebhookIngressQueueError();
          }
          queueMessages.push(message);
        }).pipe(
          Effect.catchAllDefect((error) =>
            error instanceof WebhookIngressQueueError
              ? Effect.fail(error)
              : Effect.die(error),
          ),
        ),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("not used"),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ context }) =>
        context.fieldOrObjectPurpose === "provider-session-authority"
          ? Effect.succeed(authority.slice())
          : Effect.die("unexpected decryption"),
      encrypt: ({ context, plaintext }) =>
        Effect.sync(() => {
          expect(context).toEqual({
            accountId,
            connectionId,
            entity: "webhook-event",
            fieldOrObjectPurpose: "original-request",
            recordId: objectId,
          });
          encryptedPlaintexts.push(plaintext.slice());
          plaintextReferences.push(plaintext);
          return {
            ciphertext: "CwwNDg==",
            keyVersion: 2,
            nonce: "DxAREhMUFRYXGA==",
            version: 1 as const,
          };
        }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    }),
  );
  return {
    calls,
    encryptedPlaintexts,
    events,
    handler: createWebhookIngressHandler(layer),
    objects,
    plaintextReferences,
    queueMessages,
  };
};

const request = (
  payload = validPayload,
  headers: Readonly<Record<string, string>> = {},
) =>
  new Request(endpoint, {
    body: payload,
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": "connection-webhook-secret",
      ...headers,
    },
    method: "POST",
  });

const sha256Hex = async (value: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

describe("authenticated Webhook Event ingress", () => {
  test("stores connection-bound ciphertext and publishes only its opaque receipt before success", async () => {
    const harness = makeHarness();

    const response = await harness.handler(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(harness.calls).toEqual(["r2", "queue"]);
    expect(harness.encryptedPlaintexts).toEqual([validPayload]);
    expect(harness.plaintextReferences).toHaveLength(1);
    expect(harness.plaintextReferences[0]?.every((byte) => byte === 0)).toBe(
      true,
    );
    expect(harness.objects).toHaveLength(1);
    const stored = harness.objects[0];
    if (stored === undefined) throw new Error("missing stored object");
    const ciphertextHash = await sha256Hex(stored.body);
    expect(JSON.parse(new TextDecoder().decode(stored.body))).toEqual({
      ciphertext: "CwwNDg==",
      key_version: 2,
      nonce: "DxAREhMUFRYXGA==",
      version: 1,
    });
    expect(stored).toEqual({
      body: stored.body,
      customMetadata: {
        ciphertextSha256: ciphertextHash,
        payloadBytes: String(validPayload.byteLength),
        personalAccountId: accountId,
        receivedAt: "2026-07-31T12:00:00.000Z",
        version: "1",
        whatsappConnectionId: connectionId,
      },
      objectKey: `webhook-events/${objectId}`,
    });
    expect(harness.queueMessages).toEqual([
      {
        ciphertext_sha256: ciphertextHash,
        object_id: objectId,
        payload_bytes: validPayload.byteLength,
        personal_account_id: accountId,
        received_at: "2026-07-31T12:00:00.000Z",
        version: 1,
        whatsapp_connection_id: connectionId,
      },
    ]);
  });

  test("rejects an unknown ingress, wrong secret, session mismatch, and malformed payload without writes", async () => {
    const cases = [
      {
        harness: makeHarness({ unknownIngress: true }),
        request: request(),
      },
      {
        harness: makeHarness(),
        request: request(validPayload, {
          "x-webhook-signature": "wrong-secret",
        }),
      },
      {
        harness: makeHarness(),
        request: request(
          encoder.encode(
            JSON.stringify({
              event: "messages.update",
              sessionId: "another-session",
            }),
          ),
        ),
      },
      {
        harness: makeHarness(),
        request: request(encoder.encode("{")),
      },
    ];

    for (const testCase of cases) {
      const response = await testCase.harness.handler(testCase.request);
      expect([400, 404]).toContain(response.status);
      expect(testCase.harness.calls).toEqual([]);
      expect(testCase.harness.objects).toEqual([]);
      expect(testCase.harness.queueMessages).toEqual([]);
    }
  });

  test("enforces the declared and streamed 1 MiB limit before persistence", async () => {
    const declared = makeHarness();
    const streamed = makeHarness();

    const responses = await Promise.all([
      declared.handler(request(validPayload, { "content-length": "1048577" })),
      streamed.handler(request(new Uint8Array(1_048_577).fill(32))),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([413, 413]);
    expect(declared.calls).toEqual([]);
    expect(streamed.calls).toEqual([]);
  });

  test("returns unavailable when the request body stream fails before persistence", async () => {
    const harness = makeHarness();
    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("request body unavailable"));
      },
    });

    const response = await harness.handler(
      new Request(endpoint, {
        body: failedBody,
        duplex: "half",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": "connection-webhook-secret",
        },
        method: "POST",
      } as RequestInit),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(harness.calls).toEqual([]);
    expect(harness.events.at(-1)).toEqual({
      event: "webhook_ingress.completed",
      outcome: "unavailable",
      service: "api",
    });
  });

  test("returns failure unless both R2 persistence and Queue publication succeed", async () => {
    const r2Failure = makeHarness({ storeUnavailable: true });
    const queueFailure = makeHarness({ queueUnavailable: true });
    const databaseFailure = makeHarness({ persistenceUnavailable: true });

    const responses = await Promise.all([
      r2Failure.handler(request()),
      queueFailure.handler(request()),
      databaseFailure.handler(request()),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([503, 503, 503]);
    expect(r2Failure.calls).toEqual(["r2"]);
    expect(r2Failure.queueMessages).toEqual([]);
    expect(queueFailure.calls).toEqual(["r2", "queue"]);
    expect(queueFailure.objects).toHaveLength(1);
    expect(queueFailure.queueMessages).toEqual([]);
    expect(databaseFailure.calls).toEqual([]);
  });
});
