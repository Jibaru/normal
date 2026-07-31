import type { DeploymentEnvironment } from "@whatsapp-mcp/domain/deployment";
import { Effect } from "effect";
import { type DeletionObjectBucket, DeletionPrimitiveError } from "./marker";

const capsulePrefix = "capsules/v1/";
const capsuleVersion = 1 as const;

export interface ProviderCleanupIdentifiers {
  readonly sessionLocator: string;
}

export interface DeletionCapsuleKmsInput {
  readonly ciphertext: Uint8Array;
  readonly encryptionContext: Readonly<Record<string, string>>;
  readonly keyId: string;
}

export interface DeletionCapsuleKmsWriter {
  readonly encrypt: (input: {
    readonly encryptionContext: Readonly<Record<string, string>>;
    readonly keyId: string;
    readonly plaintext: Uint8Array;
  }) => Effect.Effect<Uint8Array, unknown>;
}

export interface DeletionCapsuleKmsReader {
  readonly decrypt: (
    input: DeletionCapsuleKmsInput,
  ) => Effect.Effect<Uint8Array, unknown>;
}

interface StoredDeletionCapsule {
  readonly ciphertext: Uint8Array;
  readonly deletionMarkerId: string;
  readonly encryptionContext: Readonly<Record<string, string>>;
  readonly keyId: string;
  readonly keyVersion: number;
}

export interface DeletionCapsuleStore {
  readonly create: (input: {
    readonly deletionMarkerId: string;
    readonly keyVersion: number;
    readonly providerCleanupIdentifiers: ProviderCleanupIdentifiers;
  }) => Effect.Effect<StoredDeletionCapsule, DeletionPrimitiveError>;
  readonly destroy: (input: {
    readonly deletionMarkerId: string;
  }) => Effect.Effect<void, DeletionPrimitiveError>;
  readonly read: (input: {
    readonly deletionMarkerId: string;
  }) => Effect.Effect<StoredDeletionCapsule | null, DeletionPrimitiveError>;
}

export interface DeletionCapsuleWriter {
  readonly create: DeletionCapsuleStore["create"];
}

type DeletionCapsuleWriteBucket = Pick<DeletionObjectBucket, "get" | "put">;

const operationError = (
  operation:
    | "create-capsule"
    | "decrypt-capsule"
    | "destroy-capsule"
    | "read-capsule"
    | "reconcile-provider",
) => new DeletionPrimitiveError({ operation });

const hasMarkerId = (value: string) => /^[a-f0-9]{64}$/u.test(value);

const hasKeyVersion = (value: number) =>
  Number.isSafeInteger(value) && value > 0;

const hasSessionLocator = (value: string) =>
  /^wsl_[A-Za-z0-9_-]{1,508}$/u.test(value);

const contextFor = (
  environment: DeploymentEnvironment,
  deletionMarkerId: string,
  keyVersion: number,
) => ({
  deletionMarkerId,
  environment,
  keyVersion: String(keyVersion),
  purpose: "deletion-capsule",
});

const objectKeyFor = (deletionMarkerId: string) =>
  `${capsulePrefix}${deletionMarkerId}.json`;

const encodeBase64 = (value: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const serializePlaintext = (identifiers: ProviderCleanupIdentifiers) =>
  JSON.stringify({
    providerCleanupIdentifiers: {
      sessionLocator: identifiers.sessionLocator,
    },
    version: capsuleVersion,
  });

const parsePlaintext = (plaintext: Uint8Array): ProviderCleanupIdentifiers => {
  const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "providerCleanupIdentifiers,version"
  ) {
    throw operationError("decrypt-capsule");
  }
  const record = value as Record<string, unknown>;
  const identifiers = record.providerCleanupIdentifiers;
  if (
    record.version !== capsuleVersion ||
    typeof identifiers !== "object" ||
    identifiers === null ||
    Array.isArray(identifiers) ||
    Object.keys(identifiers).join(",") !== "sessionLocator"
  ) {
    throw operationError("decrypt-capsule");
  }
  const sessionLocator = (identifiers as Record<string, unknown>)
    .sessionLocator;
  if (
    typeof sessionLocator !== "string" ||
    !hasSessionLocator(sessionLocator)
  ) {
    throw operationError("decrypt-capsule");
  }
  return { sessionLocator };
};

const parseEnvelope = (
  body: string,
  deletionMarkerId: string,
  environment: DeploymentEnvironment,
  keyId: string,
): StoredDeletionCapsule => {
  const value: unknown = JSON.parse(body);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "ciphertext,keyVersion,version"
  ) {
    throw operationError("read-capsule");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== capsuleVersion ||
    typeof record.keyVersion !== "number" ||
    !hasKeyVersion(record.keyVersion) ||
    typeof record.ciphertext !== "string" ||
    record.ciphertext.length === 0
  ) {
    throw operationError("read-capsule");
  }
  let ciphertext: Uint8Array;
  try {
    ciphertext = decodeBase64(record.ciphertext);
  } catch {
    throw operationError("read-capsule");
  }
  if (ciphertext.byteLength === 0) throw operationError("read-capsule");
  return {
    ciphertext,
    deletionMarkerId,
    encryptionContext: contextFor(
      environment,
      deletionMarkerId,
      record.keyVersion,
    ),
    keyId,
    keyVersion: record.keyVersion,
  };
};

const makeCapsuleReader =
  ({
    bucket,
    environment,
    keyId,
  }: {
    readonly bucket: Pick<DeletionObjectBucket, "get">;
    readonly environment: DeploymentEnvironment;
    readonly keyId: string;
  }) =>
  ({
    deletionMarkerId,
  }: {
    readonly deletionMarkerId: string;
  }): Effect.Effect<StoredDeletionCapsule | null, DeletionPrimitiveError> => {
    if (!hasMarkerId(deletionMarkerId)) {
      return Effect.fail(operationError("read-capsule"));
    }
    return Effect.tryPromise({
      try: async () => {
        const object = await bucket.get(objectKeyFor(deletionMarkerId));
        return object
          ? parseEnvelope(
              await object.text(),
              deletionMarkerId,
              environment,
              keyId,
            )
          : null;
      },
      catch: () => operationError("read-capsule"),
    });
  };

const makeCapsuleCreator = ({
  bucket,
  environment,
  keyId,
  kmsWriter,
  read,
}: {
  readonly bucket: DeletionCapsuleWriteBucket;
  readonly environment: DeploymentEnvironment;
  readonly keyId: string;
  readonly kmsWriter: DeletionCapsuleKmsWriter;
  readonly read: DeletionCapsuleStore["read"];
}): DeletionCapsuleStore["create"] => {
  return (input) => {
    if (
      !hasMarkerId(input.deletionMarkerId) ||
      !hasKeyVersion(input.keyVersion) ||
      !hasSessionLocator(input.providerCleanupIdentifiers.sessionLocator)
    ) {
      return Effect.fail(operationError("create-capsule"));
    }
    return read({ deletionMarkerId: input.deletionMarkerId }).pipe(
      Effect.flatMap((existing) => {
        if (existing) {
          return existing.keyVersion === input.keyVersion
            ? Effect.succeed(existing)
            : Effect.fail(operationError("create-capsule"));
        }
        const encryptionContext = contextFor(
          environment,
          input.deletionMarkerId,
          input.keyVersion,
        );
        const plaintext = new TextEncoder().encode(
          serializePlaintext(input.providerCleanupIdentifiers),
        );
        return Effect.acquireUseRelease(
          Effect.succeed(plaintext),
          (scopedPlaintext) =>
            kmsWriter.encrypt({
              encryptionContext,
              keyId,
              plaintext: scopedPlaintext,
            }),
          (scopedPlaintext) =>
            Effect.sync(() => {
              scopedPlaintext.fill(0);
            }),
        ).pipe(
          Effect.mapError(() => operationError("create-capsule")),
          Effect.flatMap((ciphertext) =>
            Effect.tryPromise({
              try: async () => {
                if (ciphertext.byteLength === 0) {
                  throw operationError("create-capsule");
                }
                const body = JSON.stringify({
                  ciphertext: encodeBase64(ciphertext),
                  keyVersion: input.keyVersion,
                  version: capsuleVersion,
                });
                const stored = await bucket.put(
                  objectKeyFor(input.deletionMarkerId),
                  body,
                  { onlyIf: { etagDoesNotMatch: "*" } },
                );
                if (stored === null) {
                  const concurrent = await bucket.get(
                    objectKeyFor(input.deletionMarkerId),
                  );
                  if (!concurrent) {
                    throw operationError("create-capsule");
                  }
                  const concurrentEnvelope = parseEnvelope(
                    await concurrent.text(),
                    input.deletionMarkerId,
                    environment,
                    keyId,
                  );
                  if (concurrentEnvelope.keyVersion !== input.keyVersion) {
                    throw operationError("create-capsule");
                  }
                  return concurrentEnvelope;
                }
                return {
                  ciphertext,
                  deletionMarkerId: input.deletionMarkerId,
                  encryptionContext,
                  keyId,
                  keyVersion: input.keyVersion,
                };
              },
              catch: () => operationError("create-capsule"),
            }),
          ),
        );
      }),
    );
  };
};

export const makeDeletionCapsuleWriter = ({
  bucket,
  environment,
  keyId,
  kmsWriter,
}: {
  readonly bucket: DeletionCapsuleWriteBucket;
  readonly environment: DeploymentEnvironment;
  readonly keyId: string;
  readonly kmsWriter: DeletionCapsuleKmsWriter;
}): DeletionCapsuleWriter => {
  const read = makeCapsuleReader({ bucket, environment, keyId });
  return {
    create: makeCapsuleCreator({
      bucket,
      environment,
      keyId,
      kmsWriter,
      read,
    }),
  };
};

export const makeDeletionCapsuleStore = ({
  bucket,
  environment,
  keyId,
  kmsWriter,
}: {
  readonly bucket: DeletionObjectBucket;
  readonly environment: DeploymentEnvironment;
  readonly keyId: string;
  readonly kmsWriter: DeletionCapsuleKmsWriter;
}): DeletionCapsuleStore => {
  const read = makeCapsuleReader({ bucket, environment, keyId });
  return {
    create: makeCapsuleCreator({
      bucket,
      environment,
      keyId,
      kmsWriter,
      read,
    }),
    destroy: ({ deletionMarkerId }) => {
      if (!hasMarkerId(deletionMarkerId)) {
        return Effect.fail(operationError("destroy-capsule"));
      }
      return Effect.tryPromise({
        try: () => bucket.delete(objectKeyFor(deletionMarkerId)),
        catch: () => operationError("destroy-capsule"),
      });
    },
    read,
  };
};

export interface DeletionCapsuleCoordinator {
  readonly reconcile: (input: {
    readonly deletionMarkerId: string;
  }) => Effect.Effect<
    { readonly state: "complete" | "pending" },
    DeletionPrimitiveError
  >;
}

type CoordinatorObservation = {
  readonly state: "complete" | "pending";
};

export const makeDeletionCapsuleCoordinator = ({
  capsuleStore,
  kmsReader,
  reconcileProviderAbsence,
}: {
  readonly capsuleStore: DeletionCapsuleStore;
  readonly kmsReader: DeletionCapsuleKmsReader;
  readonly reconcileProviderAbsence: (
    identifiers: ProviderCleanupIdentifiers,
  ) => Effect.Effect<{ readonly state: "absent" | "present" }, unknown>;
}): DeletionCapsuleCoordinator => ({
  reconcile: ({ deletionMarkerId }) =>
    capsuleStore.read({ deletionMarkerId }).pipe(
      Effect.flatMap((stored) => {
        if (!stored) return Effect.succeed({ state: "complete" as const });
        return kmsReader
          .decrypt({
            ciphertext: stored.ciphertext,
            encryptionContext: stored.encryptionContext,
            keyId: stored.keyId,
          })
          .pipe(
            Effect.mapError(() => operationError("decrypt-capsule")),
            Effect.flatMap((plaintext) =>
              Effect.acquireUseRelease(
                Effect.succeed(plaintext),
                (scopedPlaintext) =>
                  Effect.try({
                    try: () => parsePlaintext(scopedPlaintext),
                    catch: () => operationError("decrypt-capsule"),
                  }).pipe(
                    Effect.flatMap((identifiers) =>
                      reconcileProviderAbsence(identifiers).pipe(
                        Effect.mapError(() =>
                          operationError("reconcile-provider"),
                        ),
                      ),
                    ),
                  ),
                (scopedPlaintext) =>
                  Effect.sync(() => {
                    scopedPlaintext.fill(0);
                  }),
              ),
            ),
            Effect.flatMap(
              (observation: {
                readonly state: "absent" | "present";
              }): Effect.Effect<
                CoordinatorObservation,
                DeletionPrimitiveError
              > =>
                observation.state === "absent"
                  ? capsuleStore.destroy({ deletionMarkerId }).pipe(
                      Effect.as({
                        state: "complete" as const,
                      } satisfies CoordinatorObservation),
                    )
                  : Effect.succeed({
                      state: "pending" as const,
                    } satisfies CoordinatorObservation),
            ),
          );
      }),
    ),
});
