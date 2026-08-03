import { Effect, Redacted, Stream } from "effect";
import { describe, expect, test } from "vitest";
import {
  processStoredMedia,
  STORED_MEDIA_LIMITS,
} from "../src/stored-media-ingestion";

const input = {
  accountKey: {} as never,
  connectionKey: {} as never,
  id: "30000000-0000-4000-8000-000000000045",
  mediaType: "image" as const,
  objectKey: "media/random-object",
  personalAccountId: "10000000-0000-4000-8000-000000000045",
  source: Redacted.make("encrypted-provider-source") as never,
  whatsappConnectionId: "20000000-0000-4000-8000-000000000045",
};

const ciphertext = {
  ciphertext: btoa("ciphertext-value"),
  keyVersion: 1,
  nonce: btoa("123456789012"),
  version: 1 as const,
};

describe("Stored Media ingestion", () => {
  test("streams, hashes, structurally verifies, encrypts metadata, and finalizes actual bytes", async () => {
    const finalized: Array<Record<string, unknown>> = [];
    let receivedLimit = 0;
    const outcome = await processStoredMedia({
      container: {
        write: ({
          plaintext,
        }: {
          readonly plaintext: ReadableStream<Uint8Array>;
        }) =>
          Effect.promise(async () => {
            const bytes = new Uint8Array(
              await new Response(plaintext).arrayBuffer(),
            );
            expect(new TextDecoder().decode(bytes)).toBe("media-bytes");
            return {
              chunkCount: 1,
              containerVersion: 1,
              keyVersion: 1,
              plaintextBytes: bytes.byteLength,
            };
          }),
        read: () =>
          Effect.succeed(
            new Response("media-bytes").body as ReadableStream<Uint8Array>,
          ),
      },
      deleteObject: async () => {
        throw new Error("must not delete ready object");
      },
      encryption: {
        encrypt: ({ plaintext }: { readonly plaintext: Uint8Array }) => {
          expect(new TextDecoder().decode(plaintext)).toBe(
            '{"fileName":"photo.JPG","mimeType":"image/jpeg"}',
          );
          return Effect.succeed(ciphertext);
        },
      } as never,
      input,
      persistence: {
        fail: async () => false,
        finalize: async (value) => {
          finalized.push(value);
          return "ready";
        },
      },
      retrieval: {
        getMetadata: () =>
          Effect.succeed({
            expectedSizeBytes: 11,
            fileName: "photo.JPG",
            mimeType: "IMAGE/JPEG; charset=binary",
            source: Redacted.make("download") as never,
          }),
        download: ({ maxBytes }) => {
          receivedLimit = maxBytes;
          return Effect.succeed({
            maxBytes,
            stream: Stream.succeed(new TextEncoder().encode("media-bytes")),
          });
        },
      },
    });
    expect(outcome).toBe("ready");
    expect(receivedLimit).toBe(STORED_MEDIA_LIMITS.image);
    expect(finalized[0]).toMatchObject({
      plaintextSizeBytes: 11,
      sha256:
        "bd7aa67d0cee967e6fca8ef4917e3c70445a9cfe0f3d91ddd2eeff1bfe4b2069",
    });
  });

  test("rejects declared oversize media before download", async () => {
    let failureCode = "";
    const outcome = await processStoredMedia({
      container: {} as never,
      deleteObject: async () => {},
      encryption: {} as never,
      input,
      persistence: {
        fail: async ({ code }) => {
          failureCode = code;
          return true;
        },
        finalize: async () => "ready",
      },
      retrieval: {
        getMetadata: () =>
          Effect.succeed({
            expectedSizeBytes: STORED_MEDIA_LIMITS.image + 1,
            fileName: null,
            mimeType: null,
            source: Redacted.make("download") as never,
          }),
        download: () => Effect.die("must not download rejected media"),
      },
    });
    expect(outcome).toBe("rejected");
    expect(failureCode).toBe("policy_rejected");
  });

  test("removes the object when the atomic quota reservation loses", async () => {
    const deleted: string[] = [];
    const outcome = await processStoredMedia({
      container: {
        write: () =>
          Effect.succeed({
            chunkCount: 1,
            containerVersion: 1,
            keyVersion: 1,
            plaintextBytes: 1,
          }),
        read: () =>
          Effect.succeed(new Response("x").body as ReadableStream<Uint8Array>),
      },
      deleteObject: async (key) => {
        deleted.push(key);
      },
      encryption: { encrypt: () => Effect.succeed(ciphertext) } as never,
      input,
      persistence: {
        fail: async () => false,
        finalize: async () => "quota_exceeded",
      },
      retrieval: {
        getMetadata: () =>
          Effect.succeed({
            expectedSizeBytes: 1,
            fileName: null,
            mimeType: null,
            source: Redacted.make("download") as never,
          }),
        download: ({ maxBytes }) =>
          Effect.succeed({
            maxBytes,
            stream: Stream.succeed(new Uint8Array([1])),
          }),
      },
    });
    expect(outcome).toBe("quota_exceeded");
    expect(deleted).toEqual([input.objectKey]);
  });

  test("removes a partially written object when the container write fails", async () => {
    const deleted: string[] = [];
    let failureCode = "";
    const outcome = await processStoredMedia({
      container: {
        write: () => Effect.fail(new Error("partial write")),
      } as never,
      deleteObject: async (key) => {
        deleted.push(key);
      },
      encryption: {} as never,
      input,
      persistence: {
        fail: async ({ code }) => {
          failureCode = code;
          return true;
        },
        finalize: async () => "ready",
      },
      retrieval: {
        getMetadata: () =>
          Effect.succeed({
            expectedSizeBytes: 1,
            fileName: null,
            mimeType: null,
            source: Redacted.make("download") as never,
          }),
        download: ({ maxBytes }) =>
          Effect.succeed({
            maxBytes,
            stream: Stream.succeed(new Uint8Array([1])),
          }),
      },
    });
    expect(outcome).toBe("failed");
    expect(failureCode).toBe("processing_failed");
    expect(deleted).toEqual([input.objectKey]);
  });
});
