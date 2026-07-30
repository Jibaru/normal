import type { DeploymentEnvironment } from "@whatsapp-mcp/domain/deployment";
import { Context, Data, Effect } from "effect";

const AES_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const FORMAT_VERSION = 1 as const;

export type EncryptionOperation =
  | "create-personal-account-key"
  | "create-connection-key"
  | "encrypt"
  | "decrypt";

export class EncryptionError extends Data.TaggedError("EncryptionError")<{
  readonly operation: EncryptionOperation;
}> {}

export interface KmsKeyService {
  readonly generateDataKey: (input: {
    readonly encryptionContext: Readonly<Record<string, string>>;
    readonly keyId: string;
  }) => Effect.Effect<
    {
      readonly ciphertext: Uint8Array;
      readonly plaintext: Uint8Array;
    },
    unknown
  >;
  readonly decrypt: (input: {
    readonly ciphertext: Uint8Array;
    readonly encryptionContext: Readonly<Record<string, string>>;
    readonly keyId: string;
  }) => Effect.Effect<Uint8Array, unknown>;
}

export interface PersonalAccountKeyEnvelope {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
  readonly version: typeof FORMAT_VERSION;
}

export interface ConnectionKeyEnvelope {
  readonly accountKeyVersion: number;
  readonly ciphertext: string;
  readonly connectionId: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly personalAccountId: string;
  readonly version: typeof FORMAT_VERSION;
}

export interface VersionedCiphertext {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: typeof FORMAT_VERSION;
}

export interface EncryptionContext {
  readonly accountId: string;
  readonly connectionId: string;
  readonly entity: string;
  readonly fieldOrObjectPurpose: string;
  readonly recordId: string;
}

export interface EnvelopeEncryption {
  readonly createPersonalAccountKey: (input: {
    readonly accountId: string;
    readonly keyVersion: number;
  }) => Effect.Effect<PersonalAccountKeyEnvelope, EncryptionError>;
  readonly createConnectionKey: (input: {
    readonly accountId: string;
    readonly accountKey: PersonalAccountKeyEnvelope;
    readonly connectionId: string;
    readonly keyVersion: number;
  }) => Effect.Effect<ConnectionKeyEnvelope, EncryptionError>;
  readonly encrypt: (input: {
    readonly accountKey: PersonalAccountKeyEnvelope;
    readonly connectionKey: ConnectionKeyEnvelope;
    readonly context: EncryptionContext;
    readonly plaintext: Uint8Array;
  }) => Effect.Effect<VersionedCiphertext, EncryptionError>;
  readonly decrypt: (input: {
    readonly accountKey: PersonalAccountKeyEnvelope;
    readonly ciphertext: VersionedCiphertext;
    readonly connectionKey: ConnectionKeyEnvelope;
    readonly context: EncryptionContext;
  }) => Effect.Effect<Uint8Array, EncryptionError>;
}

export const EnvelopeEncryptionService = Context.GenericTag<EnvelopeEncryption>(
  "@whatsapp-mcp/api/EnvelopeEncryption",
);

interface EnvelopeEncryptionOptions {
  readonly contentRootKeyId: string;
  readonly environment: DeploymentEnvironment;
  readonly kms: KmsKeyService;
}

const isPositiveVersion = (value: number) =>
  Number.isSafeInteger(value) && value > 0;

const hasText = (value: string) =>
  typeof value === "string" && value.length > 0;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;

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

const authenticatedBytes = (value: Readonly<Record<string, string | number>>) =>
  new TextEncoder().encode(JSON.stringify(value));

const accountKeyContext = (
  environment: DeploymentEnvironment,
  personalAccountId: string,
  keyVersion: number,
) => ({
  environment,
  keyVersion: String(keyVersion),
  personalAccountId,
  purpose: "personal-account-key",
});

const connectionKeyAdditionalData = (
  environment: DeploymentEnvironment,
  envelope: Omit<ConnectionKeyEnvelope, "ciphertext" | "nonce">,
) =>
  authenticatedBytes({
    accountKeyVersion: envelope.accountKeyVersion,
    connectionId: envelope.connectionId,
    environment,
    keyVersion: envelope.keyVersion,
    personalAccountId: envelope.personalAccountId,
    purpose: "connection-key",
    version: envelope.version,
  });

const ciphertextAdditionalData = (
  environment: DeploymentEnvironment,
  context: EncryptionContext,
  keyVersion: number,
) =>
  authenticatedBytes({
    accountId: context.accountId,
    connectionId: context.connectionId,
    entity: context.entity,
    environment,
    fieldOrObjectPurpose: context.fieldOrObjectPurpose,
    keyVersion,
    purpose: "application-ciphertext",
    recordId: context.recordId,
    version: FORMAT_VERSION,
  });

const zero = (value: Uint8Array) =>
  Effect.sync(() => {
    value.fill(0);
  });

const operationError = (operation: EncryptionOperation) =>
  new EncryptionError({ operation });

const validateAccountEnvelope = (
  envelope: PersonalAccountKeyEnvelope,
  contentRootKeyId: string,
) =>
  envelope.version === FORMAT_VERSION &&
  envelope.kmsKeyId === contentRootKeyId &&
  hasText(envelope.personalAccountId) &&
  hasText(envelope.ciphertext) &&
  isPositiveVersion(envelope.keyVersion);

const validateConnectionEnvelope = (envelope: ConnectionKeyEnvelope) =>
  envelope.version === FORMAT_VERSION &&
  hasText(envelope.personalAccountId) &&
  hasText(envelope.connectionId) &&
  hasText(envelope.nonce) &&
  hasText(envelope.ciphertext) &&
  isPositiveVersion(envelope.accountKeyVersion) &&
  isPositiveVersion(envelope.keyVersion);

const validateContext = (context: EncryptionContext) =>
  hasText(context.accountId) &&
  hasText(context.connectionId) &&
  hasText(context.entity) &&
  hasText(context.recordId) &&
  hasText(context.fieldOrObjectPurpose);

const attemptCrypto = <A>(
  operation: EncryptionOperation,
  run: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: run,
    catch: () => operationError(operation),
  });

const importAesKey = (operation: EncryptionOperation, keyBytes: Uint8Array) =>
  attemptCrypto(operation, async () => {
    if (keyBytes.byteLength !== AES_KEY_BYTES) {
      throw new Error("invalid key size");
    }
    return crypto.subtle.importKey(
      "raw",
      toArrayBuffer(keyBytes),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  });

export const makeEnvelopeEncryption = ({
  contentRootKeyId,
  environment,
  kms,
}: EnvelopeEncryptionOptions): EnvelopeEncryption => {
  const withAccountKey = <A>(
    operation: EncryptionOperation,
    envelope: PersonalAccountKeyEnvelope,
    use: (key: CryptoKey) => Effect.Effect<A, EncryptionError>,
  ): Effect.Effect<A, EncryptionError> => {
    if (!validateAccountEnvelope(envelope, contentRootKeyId)) {
      return Effect.fail(operationError(operation));
    }

    const acquire = Effect.try({
      try: () => decodeBase64(envelope.ciphertext),
      catch: () => operationError(operation),
    }).pipe(
      Effect.flatMap((ciphertext) =>
        kms.decrypt({
          ciphertext,
          encryptionContext: accountKeyContext(
            environment,
            envelope.personalAccountId,
            envelope.keyVersion,
          ),
          keyId: envelope.kmsKeyId,
        }),
      ),
      Effect.mapError(() => operationError(operation)),
    );

    return Effect.acquireUseRelease(
      acquire,
      (keyBytes) => importAesKey(operation, keyBytes).pipe(Effect.flatMap(use)),
      (keyBytes) => zero(keyBytes),
    );
  };

  const withConnectionKey = <A>(
    operation: EncryptionOperation,
    accountKey: PersonalAccountKeyEnvelope,
    connectionKey: ConnectionKeyEnvelope,
    use: (key: CryptoKey) => Effect.Effect<A, EncryptionError>,
  ): Effect.Effect<A, EncryptionError> => {
    if (
      !validateConnectionEnvelope(connectionKey) ||
      connectionKey.personalAccountId !== accountKey.personalAccountId ||
      connectionKey.accountKeyVersion !== accountKey.keyVersion
    ) {
      return Effect.fail(operationError(operation));
    }

    return withAccountKey(operation, accountKey, (accountCryptoKey) =>
      attemptCrypto(operation, async () => {
        const plaintext = await crypto.subtle.decrypt(
          {
            additionalData: toArrayBuffer(
              connectionKeyAdditionalData(environment, connectionKey),
            ),
            iv: toArrayBuffer(decodeBase64(connectionKey.nonce)),
            name: "AES-GCM",
          },
          accountCryptoKey,
          toArrayBuffer(decodeBase64(connectionKey.ciphertext)),
        );
        return new Uint8Array(plaintext);
      }).pipe(
        Effect.flatMap((keyBytes) =>
          Effect.acquireUseRelease(
            Effect.succeed(keyBytes),
            (bytes) => importAesKey(operation, bytes).pipe(Effect.flatMap(use)),
            (bytes) => zero(bytes),
          ),
        ),
      ),
    );
  };

  return {
    createPersonalAccountKey: ({ accountId, keyVersion }) => {
      const operation = "create-personal-account-key";
      if (
        !hasText(accountId) ||
        !isPositiveVersion(keyVersion) ||
        !hasText(contentRootKeyId)
      ) {
        return Effect.fail(operationError(operation));
      }

      const generated = kms
        .generateDataKey({
          encryptionContext: accountKeyContext(
            environment,
            accountId,
            keyVersion,
          ),
          keyId: contentRootKeyId,
        })
        .pipe(Effect.mapError(() => operationError(operation)));

      return Effect.acquireUseRelease(
        generated,
        ({ ciphertext, plaintext }) =>
          plaintext.byteLength === AES_KEY_BYTES &&
          ciphertext.byteLength > AES_GCM_NONCE_BYTES
            ? Effect.succeed({
                ciphertext: encodeBase64(ciphertext),
                keyVersion,
                kmsKeyId: contentRootKeyId,
                personalAccountId: accountId,
                version: FORMAT_VERSION,
              })
            : Effect.fail(operationError(operation)),
        ({ plaintext }) => zero(plaintext),
      );
    },

    createConnectionKey: ({
      accountId,
      accountKey,
      connectionId,
      keyVersion,
    }) => {
      const operation = "create-connection-key";
      if (
        !hasText(accountId) ||
        !hasText(connectionId) ||
        !isPositiveVersion(keyVersion) ||
        accountKey.personalAccountId !== accountId
      ) {
        return Effect.fail(operationError(operation));
      }

      const metadata = {
        accountKeyVersion: accountKey.keyVersion,
        connectionId,
        keyVersion,
        personalAccountId: accountId,
        version: FORMAT_VERSION,
      } as const;

      return withAccountKey(operation, accountKey, (accountCryptoKey) => {
        const keyBytes = crypto.getRandomValues(new Uint8Array(AES_KEY_BYTES));
        return Effect.acquireUseRelease(
          Effect.succeed(keyBytes),
          (plaintextKey) =>
            attemptCrypto(operation, async () => {
              const nonce = crypto.getRandomValues(
                new Uint8Array(AES_GCM_NONCE_BYTES),
              );
              const ciphertext = await crypto.subtle.encrypt(
                {
                  additionalData: toArrayBuffer(
                    connectionKeyAdditionalData(environment, metadata),
                  ),
                  iv: toArrayBuffer(nonce),
                  name: "AES-GCM",
                },
                accountCryptoKey,
                toArrayBuffer(plaintextKey),
              );

              return {
                ...metadata,
                ciphertext: encodeBase64(new Uint8Array(ciphertext)),
                nonce: encodeBase64(nonce),
              };
            }),
          (plaintextKey) => zero(plaintextKey),
        );
      });
    },

    encrypt: ({ accountKey, connectionKey, context, plaintext }) => {
      const operation = "encrypt";
      if (
        !validateContext(context) ||
        context.accountId !== accountKey.personalAccountId ||
        context.accountId !== connectionKey.personalAccountId ||
        context.connectionId !== connectionKey.connectionId
      ) {
        return Effect.fail(operationError(operation));
      }

      return withConnectionKey(
        operation,
        accountKey,
        connectionKey,
        (connectionCryptoKey) =>
          attemptCrypto(operation, async () => {
            const nonce = crypto.getRandomValues(
              new Uint8Array(AES_GCM_NONCE_BYTES),
            );
            const ciphertext = await crypto.subtle.encrypt(
              {
                additionalData: toArrayBuffer(
                  ciphertextAdditionalData(
                    environment,
                    context,
                    connectionKey.keyVersion,
                  ),
                ),
                iv: toArrayBuffer(nonce),
                name: "AES-GCM",
              },
              connectionCryptoKey,
              toArrayBuffer(plaintext),
            );

            return {
              ciphertext: encodeBase64(new Uint8Array(ciphertext)),
              keyVersion: connectionKey.keyVersion,
              nonce: encodeBase64(nonce),
              version: FORMAT_VERSION,
            };
          }),
      );
    },

    decrypt: ({ accountKey, ciphertext, connectionKey, context }) => {
      const operation = "decrypt";
      if (
        !validateContext(context) ||
        ciphertext.version !== FORMAT_VERSION ||
        ciphertext.keyVersion !== connectionKey.keyVersion ||
        !hasText(ciphertext.nonce) ||
        !hasText(ciphertext.ciphertext) ||
        context.accountId !== accountKey.personalAccountId ||
        context.accountId !== connectionKey.personalAccountId ||
        context.connectionId !== connectionKey.connectionId
      ) {
        return Effect.fail(operationError(operation));
      }

      return withConnectionKey(
        operation,
        accountKey,
        connectionKey,
        (connectionCryptoKey) =>
          attemptCrypto(operation, async () => {
            const plaintext = await crypto.subtle.decrypt(
              {
                additionalData: toArrayBuffer(
                  ciphertextAdditionalData(
                    environment,
                    context,
                    ciphertext.keyVersion,
                  ),
                ),
                iv: toArrayBuffer(decodeBase64(ciphertext.nonce)),
                name: "AES-GCM",
              },
              connectionCryptoKey,
              toArrayBuffer(decodeBase64(ciphertext.ciphertext)),
            );
            return new Uint8Array(plaintext);
          }),
      );
    },
  };
};
