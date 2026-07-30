import type { DeploymentEnvironment } from "@whatsapp-mcp/domain/deployment";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  type EncryptionContext,
  type KmsKeyService,
  makeEnvelopeEncryption,
} from "../src/encryption/envelope";

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

const makeTestKms = async () => {
  const rootKeys = new Map<string, CryptoKey>();
  const issuedPlaintexts: Array<Uint8Array> = [];
  const decryptedPlaintexts: Array<Uint8Array> = [];

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

  const service: KmsKeyService = {
    decrypt: ({ ciphertext, encryptionContext, keyId }) =>
      Effect.tryPromise({
        try: async () => {
          const nonce = ciphertext.slice(0, 12);
          const encrypted = ciphertext.slice(12);
          const plaintext = new Uint8Array(
            await crypto.subtle.decrypt(
              {
                additionalData: canonicalContext(encryptionContext),
                iv: nonce,
                name: "AES-GCM",
              },
              await rootKey(keyId),
              encrypted,
            ),
          );
          decryptedPlaintexts.push(plaintext);
          return plaintext;
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
                additionalData: canonicalContext(encryptionContext),
                iv: nonce,
                name: "AES-GCM",
              },
              await rootKey(keyId),
              plaintext,
            ),
          );
          issuedPlaintexts.push(plaintext);
          return {
            ciphertext: concat(nonce, ciphertext),
            plaintext,
          };
        },
        catch: () => new Error("test KMS could not generate a data key"),
      }),
  };

  return {
    decryptedPlaintexts,
    issuedPlaintexts,
    service,
  };
};

const context = (
  overrides: Partial<EncryptionContext> = {},
): EncryptionContext => ({
  accountId: "pa_account_one",
  connectionId: "wac_connection_one",
  entity: "pending-send-content",
  fieldOrObjectPurpose: "exact-text",
  recordId: "send_operation_one",
  ...overrides,
});

const setup = async (environment: DeploymentEnvironment = "preview") => {
  const kms = await makeTestKms();
  const encryption = makeEnvelopeEncryption({
    contentRootKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
    environment,
    kms: kms.service,
  });
  const accountKey = await Effect.runPromise(
    encryption.createPersonalAccountKey({
      accountId: "pa_account_one",
      keyVersion: 1,
    }),
  );
  const connectionKey = await Effect.runPromise(
    encryption.createConnectionKey({
      accountKey,
      accountId: "pa_account_one",
      connectionId: "wac_connection_one",
      keyVersion: 4,
    }),
  );

  return { accountKey, connectionKey, encryption, kms };
};

const expectEncryptionFailure = async <A>(
  effect: Effect.Effect<A, { readonly _tag: string }>,
) => {
  const result = await Effect.runPromise(Effect.either(effect));
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "EncryptionError" },
  });
};

describe("KMS-rooted envelope encryption", () => {
  test("round-trips versioned Personal Account and WhatsApp Connection ciphertext", async () => {
    const { accountKey, connectionKey, encryption } = await setup();
    const plaintext = textEncoder.encode("  preserve exact Unicode 🏖️  ");

    const ciphertext = await Effect.runPromise(
      encryption.encrypt({
        accountKey,
        connectionKey,
        context: context(),
        plaintext,
      }),
    );
    const decrypted = await Effect.runPromise(
      encryption.decrypt({
        accountKey,
        ciphertext,
        connectionKey,
        context: context(),
      }),
    );

    expect(accountKey.version).toBe(1);
    expect(connectionKey.version).toBe(1);
    expect(ciphertext.version).toBe(1);
    expect(ciphertext.keyVersion).toBe(4);
    expect(textDecoder.decode(decrypted)).toBe("  preserve exact Unicode 🏖️  ");
  });

  test.each([
    ["account", { accountId: "pa_account_two" }],
    ["connection", { connectionId: "wac_connection_two" }],
    ["entity", { entity: "stored-message" }],
    ["record", { recordId: "send_operation_two" }],
    ["field or object purpose", { fieldOrObjectPurpose: "provider-id" }],
  ] as const)("rejects %s context substitution", async (_name, replacement) => {
    const { accountKey, connectionKey, encryption } = await setup();
    const ciphertext = await Effect.runPromise(
      encryption.encrypt({
        accountKey,
        connectionKey,
        context: context(),
        plaintext: textEncoder.encode("secret"),
      }),
    );

    await expectEncryptionFailure(
      encryption.decrypt({
        accountKey,
        ciphertext,
        connectionKey,
        context: context(replacement),
      }),
    );
  });

  test("rejects ciphertext swapping between records", async () => {
    const { accountKey, connectionKey, encryption } = await setup();
    const firstCiphertext = await Effect.runPromise(
      encryption.encrypt({
        accountKey,
        connectionKey,
        context: context({ recordId: "send_operation_one" }),
        plaintext: textEncoder.encode("first"),
      }),
    );

    await expectEncryptionFailure(
      encryption.decrypt({
        accountKey,
        ciphertext: firstCiphertext,
        connectionKey,
        context: context({ recordId: "send_operation_two" }),
      }),
    );
  });

  test("rejects a substituted key version", async () => {
    const { accountKey, connectionKey, encryption } = await setup();
    const ciphertext = await Effect.runPromise(
      encryption.encrypt({
        accountKey,
        connectionKey,
        context: context(),
        plaintext: textEncoder.encode("secret"),
      }),
    );

    await expectEncryptionFailure(
      encryption.decrypt({
        accountKey,
        ciphertext: { ...ciphertext, keyVersion: 5 },
        connectionKey,
        context: context(),
      }),
    );
  });

  test("returns a typed failure for malformed key envelopes", async () => {
    const { accountKey, connectionKey, encryption } = await setup();

    await expectEncryptionFailure(
      encryption.encrypt({
        accountKey: { ...accountKey, ciphertext: "not base64!" },
        connectionKey,
        context: context(),
        plaintext: textEncoder.encode("secret"),
      }),
    );
  });

  test("rejects a connection key wrapped by another Personal Account key", async () => {
    const { accountKey, connectionKey, encryption } = await setup();
    const otherAccountKey = await Effect.runPromise(
      encryption.createPersonalAccountKey({
        accountId: "pa_account_two",
        keyVersion: 1,
      }),
    );
    const ciphertext = await Effect.runPromise(
      encryption.encrypt({
        accountKey,
        connectionKey,
        context: context(),
        plaintext: textEncoder.encode("secret"),
      }),
    );

    await expectEncryptionFailure(
      encryption.decrypt({
        accountKey: otherAccountKey,
        ciphertext,
        connectionKey,
        context: context(),
      }),
    );
  });

  test("rejects substituted Personal Account key context", async () => {
    const { accountKey, encryption } = await setup();

    await expectEncryptionFailure(
      encryption.createConnectionKey({
        accountId: "pa_account_two",
        accountKey: {
          ...accountKey,
          personalAccountId: "pa_account_two",
        },
        connectionId: "wac_connection_two",
        keyVersion: 1,
      }),
    );
  });

  test("rejects cross-environment use", async () => {
    const { accountKey, connectionKey, encryption, kms } =
      await setup("preview");
    const productionEncryption = makeEnvelopeEncryption({
      contentRootKeyId:
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      environment: "production",
      kms: kms.service,
    });
    const ciphertext = await Effect.runPromise(
      encryption.encrypt({
        accountKey,
        connectionKey,
        context: context(),
        plaintext: textEncoder.encode("secret"),
      }),
    );

    await expectEncryptionFailure(
      productionEncryption.decrypt({
        accountKey,
        ciphertext,
        connectionKey,
        context: context(),
      }),
    );
  });

  test("zeroes plaintext key bytes when each scoped Effect operation ends", async () => {
    const { accountKey, encryption, kms } = await setup();

    expect(kms.issuedPlaintexts).not.toHaveLength(0);
    for (const plaintext of kms.issuedPlaintexts) {
      expect(Array.from(plaintext)).toEqual(new Array(32).fill(0));
    }

    await Effect.runPromise(
      encryption.createConnectionKey({
        accountKey,
        accountId: "pa_account_one",
        connectionId: "wac_connection_two",
        keyVersion: 1,
      }),
    );
    expect(kms.decryptedPlaintexts).not.toHaveLength(0);
    for (const plaintext of kms.decryptedPlaintexts) {
      expect(Array.from(plaintext)).toEqual(new Array(32).fill(0));
    }
  });
});
