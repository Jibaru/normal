import type { DeploymentEnvironment } from "@whatsapp-mcp/domain/deployment";
import { Context, Data, Effect } from "effect";
import { decodeBase64, encodeBase64 } from "../base64-url";
import type {
  ConnectionKeyEnvelope,
  EnvelopeEncryption,
  PersonalAccountKeyEnvelope,
  VersionedCiphertext,
} from "./envelope";

const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const AES_KEY_BYTES = 32;
const ALGORITHM_AES_256_GCM = 1;
const TEXT_ENCODER = new TextEncoder();
const CONTAINER_MAGIC = TEXT_ENCODER.encode("WAMR2ENC");
const CONTAINER_VERSION = 1 as const;
const DATA_FRAME = 0;
const FRAME_HEADER_BYTES = 21;
const HEADER_FIXED_BYTES = 34;
const MAX_CHUNK_INDEX = 0xffff_ffff;
const MAX_WRAPPED_KEY_BYTES = 4_096;
const R2_OBJECT_KEY_MAX_BYTES = 1_024;
const R2_MULTIPART_PART_BYTES = 5 * 1_048_576;
const TERMINAL_FRAME = 1;

export const MEDIA_CONTAINER_CHUNK_BYTES = 1_048_576;

export type StoredMediaContainerOperation = "read" | "write";
export type StoredMediaContainerFailure =
  | "authentication-failed"
  | "cancelled"
  | "invalid-input"
  | "not-found"
  | "storage-failed"
  | "unsupported-version";

export class StoredMediaContainerError extends Data.TaggedError(
  "StoredMediaContainerError",
)<{
  readonly operation: StoredMediaContainerOperation;
  readonly reason: StoredMediaContainerFailure;
}> {}

export interface StoredMediaContext {
  readonly connectionId: string;
  readonly mediaObjectId: string;
  readonly personalAccountId: string;
}

export interface StoredMediaContainerEvent {
  readonly chunkCount: number;
  readonly containerVersion: typeof CONTAINER_VERSION;
  readonly event: "stored-media.container.completed";
  readonly operation: StoredMediaContainerOperation;
  readonly outcome: StoredMediaContainerFailure | "success";
  readonly plaintextBytes: number;
  readonly service: "api";
}

export interface StoredMediaWriteResult {
  readonly chunkCount: number;
  readonly containerVersion: typeof CONTAINER_VERSION;
  readonly keyVersion: number;
  readonly plaintextBytes: number;
}

interface StoredMediaInput {
  readonly accountKey: PersonalAccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly context: StoredMediaContext;
  readonly objectKey: string;
}

export interface StoredMediaContainer {
  readonly read: (
    input: StoredMediaInput,
  ) => Effect.Effect<ReadableStream<Uint8Array>, StoredMediaContainerError>;
  readonly write: (
    input: StoredMediaInput & {
      readonly plaintext: ReadableStream<Uint8Array>;
    },
  ) => Effect.Effect<StoredMediaWriteResult, StoredMediaContainerError>;
}

export const StoredMediaContainerService =
  Context.GenericTag<StoredMediaContainer>(
    "@whatsapp-mcp/api/StoredMediaContainer",
  );

interface StoredMediaContainerOptions {
  readonly bucket: Pick<R2Bucket, "createMultipartUpload" | "get">;
  readonly chunkSize?: number | undefined;
  readonly encryption: EnvelopeEncryption;
  readonly environment: DeploymentEnvironment;
  readonly randomBytes?: ((length: number) => Uint8Array) | undefined;
  readonly telemetry: (event: StoredMediaContainerEvent) => void;
}

interface MutableStats {
  chunkCount: number;
  plaintextBytes: number;
}

interface ParsedHeader {
  readonly chunkSize: number;
  readonly keyVersion: number;
  readonly wrappedKey: VersionedCiphertext;
}

const hasText = (value: string) =>
  typeof value === "string" && value.length > 0;

const hasControlCharacter = (value: string) =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const isOpaqueObjectKey = (value: string) =>
  hasText(value) &&
  value.length <= R2_OBJECT_KEY_MAX_BYTES &&
  TEXT_ENCODER.encode(value).byteLength <= R2_OBJECT_KEY_MAX_BYTES &&
  !hasControlCharacter(value);

const isChunkSize = (value: number) =>
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= MEDIA_CONTAINER_CHUNK_BYTES;

const isContainerKeyVersion = (value: number) =>
  Number.isSafeInteger(value) && value > 0 && value <= MAX_CHUNK_INDEX;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;

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

const error = (
  operation: StoredMediaContainerOperation,
  reason: StoredMediaContainerFailure,
) => new StoredMediaContainerError({ operation, reason });

const normalizeError = (
  operation: StoredMediaContainerOperation,
  cause: unknown,
  fallback: StoredMediaContainerFailure,
) =>
  cause instanceof StoredMediaContainerError
    ? cause
    : error(operation, fallback);

const validateInput = (input: StoredMediaInput) =>
  isOpaqueObjectKey(input.objectKey) &&
  hasText(input.context.personalAccountId) &&
  hasText(input.context.connectionId) &&
  hasText(input.context.mediaObjectId) &&
  input.accountKey.personalAccountId === input.context.personalAccountId &&
  input.connectionKey.personalAccountId === input.context.personalAccountId &&
  input.connectionKey.connectionId === input.context.connectionId &&
  input.connectionKey.accountKeyVersion === input.accountKey.keyVersion &&
  isContainerKeyVersion(input.connectionKey.keyVersion);

const mediaKeyContext = (context: StoredMediaContext): EncryptionContext => ({
  accountId: context.personalAccountId,
  connectionId: context.connectionId,
  entity: "stored-media",
  fieldOrObjectPurpose: "media-data-key",
  recordId: context.mediaObjectId,
});

interface EncryptionContext {
  readonly accountId: string;
  readonly connectionId: string;
  readonly entity: string;
  readonly fieldOrObjectPurpose: string;
  readonly recordId: string;
}

const frameAdditionalData = (
  environment: DeploymentEnvironment,
  context: StoredMediaContext,
  chunkSize: number,
  keyVersion: number,
  chunkIndex: number,
  plaintextLength: number,
  role: "data" | "terminal",
) =>
  TEXT_ENCODER.encode(
    JSON.stringify({
      algorithm: "AES-256-GCM",
      chunkIndex,
      chunkSize,
      connectionId: context.connectionId,
      containerVersion: CONTAINER_VERSION,
      environment,
      keyVersion,
      mediaObjectId: context.mediaObjectId,
      personalAccountId: context.personalAccountId,
      plaintextLength,
      role,
    }),
  );

const importMediaKey = async (
  operation: StoredMediaContainerOperation,
  keyBytes: Uint8Array,
) => {
  if (keyBytes.byteLength !== AES_KEY_BYTES) {
    throw error(
      operation,
      operation === "read" ? "authentication-failed" : "invalid-input",
    );
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(keyBytes),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw error(
      operation,
      operation === "read" ? "authentication-failed" : "invalid-input",
    );
  }
};

const checkedRandomBytes = (
  randomBytes: (length: number) => Uint8Array,
  length: number,
) => {
  const value = randomBytes(length);
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw error("write", "invalid-input");
  }
  return value;
};

const serializeHeader = (
  chunkSize: number,
  keyVersion: number,
  wrappedKey: VersionedCiphertext,
) => {
  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    nonce = decodeBase64(wrappedKey.nonce);
    ciphertext = decodeBase64(wrappedKey.ciphertext);
  } catch {
    throw error("write", "invalid-input");
  }
  if (
    wrappedKey.version !== CONTAINER_VERSION ||
    wrappedKey.keyVersion !== keyVersion ||
    nonce.byteLength !== AES_GCM_NONCE_BYTES ||
    ciphertext.byteLength !== AES_KEY_BYTES + AES_GCM_TAG_BYTES ||
    ciphertext.byteLength > MAX_WRAPPED_KEY_BYTES
  ) {
    throw error("write", "invalid-input");
  }

  const fixed = new Uint8Array(HEADER_FIXED_BYTES);
  fixed.set(CONTAINER_MAGIC, 0);
  const view = new DataView(fixed.buffer);
  view.setUint8(8, CONTAINER_VERSION);
  view.setUint8(9, ALGORITHM_AES_256_GCM);
  view.setUint16(10, 0);
  view.setUint32(12, chunkSize);
  view.setUint32(16, keyVersion);
  fixed.set(nonce, 20);
  view.setUint16(32, ciphertext.byteLength);
  return concat(fixed, ciphertext);
};

const serializeFrame = (
  type: typeof DATA_FRAME | typeof TERMINAL_FRAME,
  index: number,
  plaintextLength: number,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
) => {
  const header = new Uint8Array(FRAME_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint8(0, type);
  view.setUint32(1, index);
  view.setUint32(5, plaintextLength);
  header.set(nonce, 9);
  return concat(header, ciphertext);
};

class BoundedStreamReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #current: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #offset = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async readExact(length: number): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.#offset >= this.#current.byteLength) {
        const next = await this.#reader.read();
        if (next.done) {
          throw error("read", "authentication-failed");
        }
        if (!(next.value instanceof Uint8Array)) {
          throw error("read", "authentication-failed");
        }
        this.#current = next.value;
        this.#offset = 0;
        if (this.#current.byteLength === 0) {
          continue;
        }
      }

      const available = this.#current.byteLength - this.#offset;
      const copied = Math.min(available, length - written);
      output.set(
        this.#current.subarray(this.#offset, this.#offset + copied),
        written,
      );
      this.#offset += copied;
      written += copied;
    }
    return output;
  }

  async isEnd(): Promise<boolean> {
    if (this.#offset < this.#current.byteLength) {
      return false;
    }
    while (true) {
      const next = await this.#reader.read();
      if (next.done) {
        return true;
      }
      if (!(next.value instanceof Uint8Array)) {
        return false;
      }
      if (next.value.byteLength > 0) {
        this.#current = next.value;
        this.#offset = 0;
        return false;
      }
    }
  }

  cancel() {
    return this.#reader.cancel().catch(() => undefined);
  }
}

const parseHeader = async (
  reader: BoundedStreamReader,
): Promise<ParsedHeader> => {
  const fixed = await reader.readExact(HEADER_FIXED_BYTES);
  if (!CONTAINER_MAGIC.every((byte, index) => fixed[index] === byte)) {
    throw error("read", "authentication-failed");
  }

  const view = new DataView(fixed.buffer);
  if (view.getUint8(8) !== CONTAINER_VERSION) {
    throw error("read", "unsupported-version");
  }
  const chunkSize = view.getUint32(12);
  const keyVersion = view.getUint32(16);
  const wrappedKeyLength = view.getUint16(32);
  if (
    view.getUint8(9) !== ALGORITHM_AES_256_GCM ||
    view.getUint16(10) !== 0 ||
    !isChunkSize(chunkSize) ||
    !isContainerKeyVersion(keyVersion) ||
    wrappedKeyLength !== AES_KEY_BYTES + AES_GCM_TAG_BYTES ||
    wrappedKeyLength > MAX_WRAPPED_KEY_BYTES
  ) {
    throw error("read", "authentication-failed");
  }

  const nonce = fixed.slice(20, 20 + AES_GCM_NONCE_BYTES);
  const ciphertext = await reader.readExact(wrappedKeyLength);
  return {
    chunkSize,
    keyVersion,
    wrappedKey: {
      ciphertext: encodeBase64(ciphertext),
      keyVersion,
      nonce: encodeBase64(nonce),
      version: CONTAINER_VERSION,
    },
  };
};

const makeEncryptionStream = (options: {
  readonly chunkSize: number;
  readonly context: StoredMediaContext;
  readonly cryptoKey: CryptoKey;
  readonly environment: DeploymentEnvironment;
  readonly header: Uint8Array;
  readonly keyVersion: number;
  readonly plaintext: ReadableStream<Uint8Array>;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly stats: MutableStats;
}) => {
  const source = options.plaintext.getReader();
  let current: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let currentOffset = 0;
  let headerSent = false;
  let terminalSent = false;
  let index = 0;

  const nextPlaintextChunk = async () => {
    const chunk = new Uint8Array(options.chunkSize);
    let written = 0;
    while (written < options.chunkSize) {
      if (currentOffset >= current.byteLength) {
        const next = await source.read();
        if (next.done) {
          break;
        }
        if (!(next.value instanceof Uint8Array)) {
          throw error("write", "invalid-input");
        }
        current = next.value;
        currentOffset = 0;
        if (current.byteLength === 0) {
          continue;
        }
      }
      const copied = Math.min(
        current.byteLength - currentOffset,
        options.chunkSize - written,
      );
      chunk.set(
        current.subarray(currentOffset, currentOffset + copied),
        written,
      );
      currentOffset += copied;
      written += copied;
    }
    return written === 0 ? undefined : chunk.slice(0, written);
  };

  return new ReadableStream<Uint8Array>({
    async cancel() {
      await source.cancel().catch(() => undefined);
    },
    async pull(controller) {
      try {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(options.header);
          return;
        }
        if (terminalSent) {
          controller.close();
          return;
        }

        const plaintext = await nextPlaintextChunk();
        const role = plaintext ? "data" : "terminal";
        if (index > MAX_CHUNK_INDEX) {
          throw error("write", "invalid-input");
        }
        const nonce = checkedRandomBytes(
          options.randomBytes,
          AES_GCM_NONCE_BYTES,
        );
        const plaintextLength = plaintext?.byteLength ?? 0;
        const encrypted = new Uint8Array(
          await crypto.subtle.encrypt(
            {
              additionalData: toArrayBuffer(
                frameAdditionalData(
                  options.environment,
                  options.context,
                  options.chunkSize,
                  options.keyVersion,
                  index,
                  plaintextLength,
                  role,
                ),
              ),
              iv: toArrayBuffer(nonce),
              name: "AES-GCM",
            },
            options.cryptoKey,
            toArrayBuffer(plaintext ?? new Uint8Array()),
          ),
        );

        controller.enqueue(
          serializeFrame(
            plaintext ? DATA_FRAME : TERMINAL_FRAME,
            index,
            plaintextLength,
            nonce,
            encrypted,
          ),
        );
        if (plaintext) {
          options.stats.chunkCount += 1;
          options.stats.plaintextBytes += plaintextLength;
          if (!Number.isSafeInteger(options.stats.plaintextBytes)) {
            throw error("write", "invalid-input");
          }
          index += 1;
        } else {
          terminalSent = true;
          controller.close();
        }
      } catch (cause) {
        await source.cancel().catch(() => undefined);
        controller.error(normalizeError("write", cause, "storage-failed"));
      }
    },
  });
};

const uploadEncryptedStream = async (
  bucket: Pick<R2Bucket, "createMultipartUpload">,
  objectKey: string,
  body: ReadableStream<Uint8Array>,
) => {
  const upload = await bucket.createMultipartUpload(objectKey);
  const reader = body.getReader();
  const uploadedParts: Array<R2UploadedPart> = [];
  let part = new Uint8Array(R2_MULTIPART_PART_BYTES);
  let partBytes = 0;
  let partNumber = 1;

  const uploadPart = async () => {
    if (partBytes === 0) {
      return;
    }
    uploadedParts.push(
      await upload.uploadPart(
        partNumber,
        toArrayBuffer(part.slice(0, partBytes)),
      ),
    );
    part = new Uint8Array(R2_MULTIPART_PART_BYTES);
    partBytes = 0;
    partNumber += 1;
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw error("write", "storage-failed");
      }
      let offset = 0;
      while (offset < next.value.byteLength) {
        const copied = Math.min(
          part.byteLength - partBytes,
          next.value.byteLength - offset,
        );
        part.set(next.value.subarray(offset, offset + copied), partBytes);
        offset += copied;
        partBytes += copied;
        if (partBytes === part.byteLength) {
          await uploadPart();
        }
      }
    }
    await uploadPart();
    await upload.complete(uploadedParts);
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    await upload.abort().catch(() => undefined);
    throw cause;
  }
};

const makeDecryptionStream = (options: {
  readonly accountKey: PersonalAccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly context: StoredMediaContext;
  readonly encryption: EnvelopeEncryption;
  readonly environment: DeploymentEnvironment;
  readonly source: ReadableStream<Uint8Array>;
  readonly telemetry: (event: StoredMediaContainerEvent) => void;
}) => {
  const reader = new BoundedStreamReader(options.source);
  const stats: MutableStats = { chunkCount: 0, plaintextBytes: 0 };
  let cryptoKey: CryptoKey | undefined;
  let header: ParsedHeader | undefined;
  let index = 0;
  let sawShortChunk = false;
  let finished = false;

  const emit = (outcome: StoredMediaContainerFailure | "success") => {
    options.telemetry({
      chunkCount: stats.chunkCount,
      containerVersion: CONTAINER_VERSION,
      event: "stored-media.container.completed",
      operation: "read",
      outcome,
      plaintextBytes: stats.plaintextBytes,
      service: "api",
    });
  };

  const initialize = async () => {
    const parsed = await parseHeader(reader);
    if (parsed.keyVersion !== options.connectionKey.keyVersion) {
      throw error("read", "authentication-failed");
    }
    const mediaKey = await Effect.runPromise(
      options.encryption
        .decrypt({
          accountKey: options.accountKey,
          ciphertext: parsed.wrappedKey,
          connectionKey: options.connectionKey,
          context: mediaKeyContext(options.context),
        })
        .pipe(Effect.mapError(() => error("read", "authentication-failed"))),
    );
    try {
      cryptoKey = await importMediaKey("read", mediaKey);
      header = parsed;
    } finally {
      mediaKey.fill(0);
    }
  };

  return new ReadableStream<Uint8Array>({
    async cancel() {
      if (!finished) {
        finished = true;
        emit("cancelled");
      }
      await reader.cancel();
    },
    async pull(controller) {
      try {
        if (!header || !cryptoKey) {
          await initialize();
        }
        if (!header || !cryptoKey) {
          throw error("read", "authentication-failed");
        }

        const frameHeader = await reader.readExact(FRAME_HEADER_BYTES);
        const view = new DataView(frameHeader.buffer);
        const type = view.getUint8(0);
        const frameIndex = view.getUint32(1);
        const plaintextLength = view.getUint32(5);
        const nonce = frameHeader.slice(9);
        if (
          frameIndex !== index ||
          (type !== DATA_FRAME && type !== TERMINAL_FRAME) ||
          (type === DATA_FRAME &&
            (plaintextLength === 0 ||
              plaintextLength > header.chunkSize ||
              sawShortChunk)) ||
          (type === TERMINAL_FRAME && plaintextLength !== 0)
        ) {
          throw error("read", "authentication-failed");
        }

        const ciphertext = await reader.readExact(
          plaintextLength + AES_GCM_TAG_BYTES,
        );
        const role = type === DATA_FRAME ? "data" : "terminal";
        let decrypted: Uint8Array;
        try {
          decrypted = new Uint8Array(
            await crypto.subtle.decrypt(
              {
                additionalData: toArrayBuffer(
                  frameAdditionalData(
                    options.environment,
                    options.context,
                    header.chunkSize,
                    header.keyVersion,
                    index,
                    plaintextLength,
                    role,
                  ),
                ),
                iv: toArrayBuffer(nonce),
                name: "AES-GCM",
              },
              cryptoKey,
              toArrayBuffer(ciphertext),
            ),
          );
        } catch {
          throw error("read", "authentication-failed");
        }
        if (decrypted.byteLength !== plaintextLength) {
          throw error("read", "authentication-failed");
        }

        if (type === TERMINAL_FRAME) {
          if (!(await reader.isEnd())) {
            throw error("read", "authentication-failed");
          }
          finished = true;
          emit("success");
          controller.close();
          return;
        }

        sawShortChunk = plaintextLength < header.chunkSize;
        stats.chunkCount += 1;
        stats.plaintextBytes += plaintextLength;
        if (!Number.isSafeInteger(stats.plaintextBytes)) {
          throw error("read", "authentication-failed");
        }
        index += 1;
        controller.enqueue(decrypted);
      } catch (cause) {
        const failure = normalizeError("read", cause, "authentication-failed");
        if (!finished) {
          finished = true;
          emit(failure.reason);
        }
        await reader.cancel();
        controller.error(failure);
      }
    },
  });
};

const drain = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Authenticate and discard one bounded plaintext chunk.
    }
  } finally {
    reader.releaseLock();
  }
};

const isR2ObjectBody = (value: unknown): value is R2ObjectBody => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    readonly body?: unknown;
    readonly etag?: unknown;
  };
  return (
    typeof candidate.etag === "string" &&
    candidate.etag.length > 0 &&
    candidate.body instanceof ReadableStream
  );
};

export const makeStoredMediaContainer = ({
  bucket,
  chunkSize = MEDIA_CONTAINER_CHUNK_BYTES,
  encryption,
  environment,
  randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length)),
  telemetry,
}: StoredMediaContainerOptions): StoredMediaContainer => {
  if (!isChunkSize(chunkSize)) {
    throw error("write", "invalid-input");
  }

  return {
    read: (input) =>
      Effect.tryPromise({
        try: async () => {
          const emit = (outcome: StoredMediaContainerFailure) => {
            telemetry({
              chunkCount: 0,
              containerVersion: CONTAINER_VERSION,
              event: "stored-media.container.completed",
              operation: "read",
              outcome,
              plaintextBytes: 0,
              service: "api",
            });
          };
          if (!validateInput(input)) {
            const failure = error("read", "authentication-failed");
            emit(failure.reason);
            throw failure;
          }

          let object: Awaited<ReturnType<typeof bucket.get>>;
          try {
            object = await bucket.get(input.objectKey);
          } catch {
            const failure = error("read", "storage-failed");
            emit(failure.reason);
            throw failure;
          }
          if (!object) {
            const failure = error("read", "not-found");
            emit(failure.reason);
            throw failure;
          }

          await drain(
            makeDecryptionStream({
              accountKey: input.accountKey,
              connectionKey: input.connectionKey,
              context: input.context,
              encryption,
              environment,
              source: object.body,
              telemetry: (event) => {
                if (event.outcome !== "success") {
                  telemetry(event);
                }
              },
            }),
          );

          let verifiedObject: R2ObjectBody | R2Object | null;
          try {
            verifiedObject = await bucket.get(input.objectKey, {
              onlyIf: { etagMatches: object.etag },
            });
          } catch {
            const failure = error("read", "storage-failed");
            emit(failure.reason);
            throw failure;
          }
          if (!isR2ObjectBody(verifiedObject)) {
            const failure = error("read", "authentication-failed");
            emit(failure.reason);
            throw failure;
          }

          return makeDecryptionStream({
            accountKey: input.accountKey,
            connectionKey: input.connectionKey,
            context: input.context,
            encryption,
            environment,
            source: verifiedObject.body,
            telemetry,
          });
        },
        catch: (cause) => normalizeError("read", cause, "storage-failed"),
      }),

    write: (input) =>
      Effect.tryPromise({
        try: async () => {
          const stats: MutableStats = {
            chunkCount: 0,
            plaintextBytes: 0,
          };
          const emit = (outcome: StoredMediaContainerFailure | "success") => {
            telemetry({
              chunkCount: stats.chunkCount,
              containerVersion: CONTAINER_VERSION,
              event: "stored-media.container.completed",
              operation: "write",
              outcome,
              plaintextBytes: stats.plaintextBytes,
              service: "api",
            });
          };

          try {
            if (
              !validateInput(input) ||
              !(input.plaintext instanceof ReadableStream)
            ) {
              throw error("write", "invalid-input");
            }
            const mediaKey = checkedRandomBytes(randomBytes, AES_KEY_BYTES);
            let cryptoKey: CryptoKey;
            let wrappedKey: VersionedCiphertext;
            try {
              [cryptoKey, wrappedKey] = await Promise.all([
                importMediaKey("write", mediaKey),
                Effect.runPromise(
                  encryption
                    .encrypt({
                      accountKey: input.accountKey,
                      connectionKey: input.connectionKey,
                      context: mediaKeyContext(input.context),
                      plaintext: mediaKey,
                    })
                    .pipe(
                      Effect.mapError(() => error("write", "invalid-input")),
                    ),
                ),
              ]);
            } finally {
              mediaKey.fill(0);
            }

            const encrypted = makeEncryptionStream({
              chunkSize,
              context: input.context,
              cryptoKey,
              environment,
              header: serializeHeader(
                chunkSize,
                input.connectionKey.keyVersion,
                wrappedKey,
              ),
              keyVersion: input.connectionKey.keyVersion,
              plaintext: input.plaintext,
              randomBytes,
              stats,
            });
            await uploadEncryptedStream(bucket, input.objectKey, encrypted);
            emit("success");
            return {
              chunkCount: stats.chunkCount,
              containerVersion: CONTAINER_VERSION,
              keyVersion: input.connectionKey.keyVersion,
              plaintextBytes: stats.plaintextBytes,
            };
          } catch (cause) {
            const failure = normalizeError("write", cause, "storage-failed");
            emit(failure.reason);
            throw failure;
          }
        },
        catch: (cause) => normalizeError("write", cause, "storage-failed"),
      }),
  };
};
