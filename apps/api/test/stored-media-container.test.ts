import { env, reset } from "cloudflare:test";
import type { DeploymentEnvironment } from "@whatsapp-mcp/domain/deployment";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  type ConnectionKeyEnvelope,
  type EnvelopeEncryption,
  type KmsKeyService,
  makeEnvelopeEncryption,
  type PersonalAccountKeyEnvelope,
} from "../src/encryption/envelope";
import {
  makeStoredMediaContainer,
  type StoredMediaContainer,
  type StoredMediaContainerEvent,
  type StoredMediaContext,
} from "../src/encryption/stored-media-container";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const canonicalContext = (context: Readonly<Record<string, string>>) =>
  textEncoder.encode(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(context).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    ),
  );

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;

const makeTestKms = () => {
  const rootKeys = new Map<string, CryptoKey>();

  const rootKey = async (keyId: string) => {
    const existing = rootKeys.get(keyId);
    if (existing) {
      return existing;
    }

    const created = (await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    )) as CryptoKey;
    rootKeys.set(keyId, created);
    return created;
  };

  return {
    decrypt: ({ ciphertext, encryptionContext, keyId }) =>
      Effect.tryPromise({
        try: async () => {
          const plaintext = await crypto.subtle.decrypt(
            {
              additionalData: toArrayBuffer(
                canonicalContext(encryptionContext),
              ),
              iv: toArrayBuffer(ciphertext.slice(0, 12)),
              name: "AES-GCM",
            },
            await rootKey(keyId),
            toArrayBuffer(ciphertext.slice(12)),
          );
          return new Uint8Array(plaintext);
        },
        catch: () => new Error("test KMS rejected ciphertext"),
      }),
    generateDataKey: ({ encryptionContext, keyId }) =>
      Effect.tryPromise({
        try: async () => {
          const plaintext = crypto.getRandomValues(new Uint8Array(32));
          const nonce = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
              {
                additionalData: toArrayBuffer(
                  canonicalContext(encryptionContext),
                ),
                iv: toArrayBuffer(nonce),
                name: "AES-GCM",
              },
              await rootKey(keyId),
              toArrayBuffer(plaintext),
            ),
          );
          return {
            ciphertext: concat(nonce, ciphertext),
            plaintext,
          };
        },
        catch: () => new Error("test KMS could not generate a data key"),
      }),
  } satisfies KmsKeyService;
};

interface Setup {
  readonly accountKey: PersonalAccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly container: StoredMediaContainer;
  readonly context: StoredMediaContext;
  readonly encryption: EnvelopeEncryption;
  readonly events: Array<StoredMediaContainerEvent>;
  readonly generatedMediaKeys: Array<Uint8Array>;
}

const setup = async (
  options: {
    readonly bucket?: Pick<R2Bucket, "createMultipartUpload" | "get">;
    readonly chunkSize?: number;
    readonly environment?: DeploymentEnvironment;
  } = {},
): Promise<Setup> => {
  const environment = options.environment ?? "preview";
  const encryption = makeEnvelopeEncryption({
    contentRootKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
    environment,
    kms: makeTestKms(),
  });
  const accountKey = await Effect.runPromise(
    encryption.createPersonalAccountKey({
      accountId: "pa_account_one",
      keyVersion: 1,
    }),
  );
  const connectionKey = await Effect.runPromise(
    encryption.createConnectionKey({
      accountId: "pa_account_one",
      accountKey,
      connectionId: "wac_connection_one",
      keyVersion: 4,
    }),
  );
  const events: Array<StoredMediaContainerEvent> = [];
  const generatedMediaKeys: Array<Uint8Array> = [];
  let randomByte = 0;
  const container = makeStoredMediaContainer({
    bucket: options.bucket ?? env.STORED_MEDIA,
    chunkSize: options.chunkSize,
    encryption,
    environment,
    randomBytes: (length) => {
      const bytes = Uint8Array.from({ length }, () => (randomByte++ % 251) + 1);
      if (length === 32) {
        generatedMediaKeys.push(bytes);
      }
      return bytes;
    },
    telemetry: (event) => {
      events.push(event);
    },
  });

  return {
    accountKey,
    connectionKey,
    container,
    context: {
      connectionId: "wac_connection_one",
      mediaObjectId: "media_object_one",
      personalAccountId: "pa_account_one",
    },
    encryption,
    events,
    generatedMediaKeys,
  };
};

const streamFrom = (...chunks: ReadonlyArray<Uint8Array>) => {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
  });
};

const readBytes = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());

const write = (setupValue: Setup, objectKey: string, plaintext: Uint8Array) =>
  Effect.runPromise(
    setupValue.container.write({
      accountKey: setupValue.accountKey,
      connectionKey: setupValue.connectionKey,
      context: setupValue.context,
      objectKey,
      plaintext: streamFrom(
        plaintext.slice(0, 7),
        plaintext.slice(7, 31),
        plaintext.slice(31),
      ),
    }),
  );

const read = async (
  setupValue: Setup,
  objectKey: string,
  context: StoredMediaContext = setupValue.context,
  connectionKey: ConnectionKeyEnvelope = setupValue.connectionKey,
) => {
  const body = await Effect.runPromise(
    setupValue.container.read({
      accountKey: setupValue.accountKey,
      connectionKey,
      context,
      objectKey,
    }),
  );
  return readBytes(body);
};

const expectReadAuthenticationFailure = async (
  setupValue: Setup,
  objectKey: string,
  context: StoredMediaContext = setupValue.context,
  connectionKey: ConnectionKeyEnvelope = setupValue.connectionKey,
) => {
  const result = await Effect.runPromise(
    Effect.either(
      setupValue.container.read({
        accountKey: setupValue.accountKey,
        connectionKey,
        context,
        objectKey,
      }),
    ),
  );
  if (result._tag === "Left") {
    expect(result.left).toMatchObject({
      _tag: "StoredMediaContainerError",
      operation: "read",
      reason: "authentication-failed",
    });
    return;
  }
  await expect(readBytes(result.right)).rejects.toMatchObject({
    _tag: "StoredMediaContainerError",
    operation: "read",
    reason: "authentication-failed",
  });
};

const storedBytes = async (objectKey: string) => {
  const object = await env.STORED_MEDIA.get(objectKey);
  if (!object) {
    throw new Error("expected Stored Media test object");
  }
  return new Uint8Array(await object.arrayBuffer());
};

const replaceStoredBytes = (objectKey: string, bytes: Uint8Array) =>
  env.STORED_MEDIA.put(objectKey, bytes);

const firstFrameOffset = (container: Uint8Array) =>
  34 + new DataView(toArrayBuffer(container)).getUint16(32);

const frameLength = (container: Uint8Array, offset: number) =>
  21 + new DataView(toArrayBuffer(container)).getUint32(offset + 5) + 16;

afterEach(async () => {
  await reset();
});

describe("encrypted R2 Stored Media container", () => {
  test("round-trips bounded chunks through the R2 binding without plaintext metadata", async () => {
    const setupValue = await setup({ chunkSize: 32 });
    const plaintext = textEncoder.encode(
      "distinct media bytes: holiday-photo.jpg image/jpeg 🏖️",
    );

    const result = await write(setupValue, "objects/opaque-one", plaintext);
    const ciphertext = await storedBytes("objects/opaque-one");
    const storedObject = await env.STORED_MEDIA.head("objects/opaque-one");

    expect(await read(setupValue, "objects/opaque-one")).toEqual(plaintext);
    expect(result).toEqual({
      chunkCount: 2,
      containerVersion: 1,
      keyVersion: 4,
      plaintextBytes: plaintext.byteLength,
    });
    expect(textDecoder.decode(ciphertext)).not.toContain("holiday-photo.jpg");
    expect(textDecoder.decode(ciphertext)).not.toContain("image/jpeg");
    expect(storedObject?.customMetadata ?? {}).toEqual({});
    expect(storedObject?.httpMetadata ?? {}).toEqual({});
    expect(setupValue.events).toEqual([
      {
        chunkCount: 2,
        containerVersion: 1,
        event: "stored-media.container.completed",
        operation: "write",
        outcome: "success",
        plaintextBytes: plaintext.byteLength,
        service: "api",
      },
      {
        chunkCount: 2,
        containerVersion: 1,
        event: "stored-media.container.completed",
        operation: "read",
        outcome: "success",
        plaintextBytes: plaintext.byteLength,
        service: "api",
      },
    ]);
    expect(Array.from(setupValue.generatedMediaKeys[0] ?? [])).toEqual(
      new Array(32).fill(0),
    );
  });

  test("round-trips an empty object only when its authenticated terminal frame is present", async () => {
    const setupValue = await setup({ chunkSize: 16 });

    const result = await write(setupValue, "objects/empty", new Uint8Array());

    expect(result.chunkCount).toBe(0);
    expect(await read(setupValue, "objects/empty")).toEqual(new Uint8Array());
  });

  test.each([
    ["truncation", (bytes: Uint8Array) => bytes.slice(0, -1)],
    [
      "a bit change",
      (bytes: Uint8Array) => {
        const mutated = bytes.slice();
        const frameOffset = firstFrameOffset(mutated);
        mutated[frameOffset + 21] = (mutated[frameOffset + 21] ?? 0) ^ 1;
        return mutated;
      },
    ],
    [
      "chunk reordering",
      (bytes: Uint8Array) => {
        const firstOffset = firstFrameOffset(bytes);
        const firstLength = frameLength(bytes, firstOffset);
        const secondOffset = firstOffset + firstLength;
        const secondLength = frameLength(bytes, secondOffset);
        return concat(
          bytes.slice(0, firstOffset),
          bytes.slice(secondOffset, secondOffset + secondLength),
          bytes.slice(firstOffset, firstOffset + firstLength),
          bytes.slice(secondOffset + secondLength),
        );
      },
    ],
    [
      "bytes after the terminal frame",
      (bytes: Uint8Array) => concat(bytes, new Uint8Array([0])),
    ],
  ])("rejects %s as an authentication failure", async (_name, mutate) => {
    const setupValue = await setup({ chunkSize: 16 });
    await write(
      setupValue,
      "objects/adversarial",
      textEncoder.encode("three complete encrypted chunks plus a tail"),
    );
    await replaceStoredBytes(
      "objects/adversarial",
      mutate(await storedBytes("objects/adversarial")),
    );

    await expectReadAuthenticationFailure(setupValue, "objects/adversarial");
  });

  test("withholds every plaintext chunk until the terminal frame and EOF authenticate", async () => {
    const setupValue = await setup({ chunkSize: 16 });
    await write(
      setupValue,
      "objects/no-prefix",
      textEncoder.encode("several valid chunks followed by a missing terminal"),
    );
    const truncated = await storedBytes("objects/no-prefix");
    await replaceStoredBytes(
      "objects/no-prefix",
      truncated.slice(0, truncated.byteLength - 1),
    );

    const result = await Effect.runPromise(
      Effect.either(
        setupValue.container.read({
          accountKey: setupValue.accountKey,
          connectionKey: setupValue.connectionKey,
          context: setupValue.context,
          objectKey: "objects/no-prefix",
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "StoredMediaContainerError",
        operation: "read",
        reason: "authentication-failed",
      },
    });
  });

  test.each([
    ["Personal Account", { personalAccountId: "pa_account_two" }],
    ["WhatsApp Connection", { connectionId: "wac_connection_two" }],
    ["Stored Media object", { mediaObjectId: "media_object_two" }],
  ])("rejects the wrong %s context", async (_name, replacement) => {
    const setupValue = await setup({ chunkSize: 16 });
    await write(
      setupValue,
      "objects/context",
      textEncoder.encode("context-bound bytes"),
    );

    await expectReadAuthenticationFailure(setupValue, "objects/context", {
      ...setupValue.context,
      ...replacement,
    });
  });

  test("rejects a substituted key version", async () => {
    const setupValue = await setup({ chunkSize: 16 });
    await write(
      setupValue,
      "objects/key-version",
      textEncoder.encode("key-version-bound bytes"),
    );

    await expectReadAuthenticationFailure(
      setupValue,
      "objects/key-version",
      setupValue.context,
      { ...setupValue.connectionKey, keyVersion: 5 },
    );
  });

  test("rejects unsupported container versions before attempting decryption", async () => {
    const setupValue = await setup({ chunkSize: 16 });
    await write(
      setupValue,
      "objects/version",
      textEncoder.encode("versioned bytes"),
    );
    const mutated = await storedBytes("objects/version");
    mutated[8] = 2;
    await replaceStoredBytes("objects/version", mutated);

    const result = await Effect.runPromise(
      Effect.either(
        setupValue.container.read({
          accountKey: setupValue.accountKey,
          connectionKey: setupValue.connectionKey,
          context: setupValue.context,
          objectKey: "objects/version",
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "StoredMediaContainerError",
        operation: "read",
        reason: "unsupported-version",
      },
    });
  });

  test("encrypts and decrypts without buffering the complete object", async () => {
    const encryptedChunkSizes: Array<number> = [];
    const storedParts: Array<Uint8Array> = [];
    const bucket = {
      createMultipartUpload: async () => {
        const parts: Array<Uint8Array> = [];
        return {
          abort: async () => undefined,
          complete: async () => {
            storedParts.push(...parts);
            return {};
          },
          key: "objects/streamed",
          uploadId: "test-upload",
          uploadPart: async (partNumber: number, value: ArrayBuffer) => {
            const part = new Uint8Array(value);
            encryptedChunkSizes.push(part.byteLength);
            parts.push(part.slice());
            return { etag: `part-${partNumber}`, partNumber };
          },
        };
      },
      get: async () => ({
        body: streamFrom(...storedParts.map((part) => part.slice())),
        etag: "test-container-etag",
      }),
    } as unknown as Pick<R2Bucket, "createMultipartUpload" | "get">;
    const setupValue = await setup({
      bucket,
      chunkSize: 1_048_576,
    });
    const plaintextChunks = Array.from({ length: 20 }, (_, index) =>
      new Uint8Array(300_000).fill(index + 1),
    );
    const plaintextBytes = concat(...plaintextChunks);

    const result = await Effect.runPromise(
      setupValue.container.write({
        accountKey: setupValue.accountKey,
        connectionKey: setupValue.connectionKey,
        context: setupValue.context,
        objectKey: "objects/streamed",
        plaintext: streamFrom(...plaintextChunks),
      }),
    );
    const decrypted = await Effect.runPromise(
      setupValue.container.read({
        accountKey: setupValue.accountKey,
        connectionKey: setupValue.connectionKey,
        context: setupValue.context,
        objectKey: "objects/streamed",
      }),
    );
    const decryptedChunkSizes: Array<number> = [];
    const reader = decrypted.getReader();
    const decryptedParts: Array<Uint8Array> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      decryptedChunkSizes.push(next.value.byteLength);
      decryptedParts.push(next.value);
    }

    expect(result.chunkCount).toBe(
      Math.ceil(plaintextBytes.byteLength / 1_048_576),
    );
    expect(Math.max(...encryptedChunkSizes)).toBeLessThan(
      plaintextBytes.byteLength,
    );
    expect(Math.max(...decryptedChunkSizes)).toBeLessThanOrEqual(1_048_576);
    const decryptedBytes = concat(...decryptedParts);
    expect(decryptedBytes.byteLength).toBe(plaintextBytes.byteLength);
    expect(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", toArrayBuffer(decryptedBytes)),
      ),
    ).toEqual(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", toArrayBuffer(plaintextBytes)),
      ),
    );
  });

  test("fails closed without an R2 object and emits no sensitive context", async () => {
    const setupValue = await setup();

    const result = await Effect.runPromise(
      Effect.either(
        setupValue.container.read({
          accountKey: setupValue.accountKey,
          connectionKey: setupValue.connectionKey,
          context: setupValue.context,
          objectKey: "objects/missing",
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "StoredMediaContainerError",
        operation: "read",
        reason: "not-found",
      },
    });
    const serialized = JSON.stringify(setupValue.events);
    expect(serialized).not.toContain(setupValue.context.personalAccountId);
    expect(serialized).not.toContain(setupValue.context.connectionId);
    expect(serialized).not.toContain(setupValue.context.mediaObjectId);
    expect(serialized).not.toContain("objects/missing");
  });
});
