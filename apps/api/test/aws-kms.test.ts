import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  type KMSClient,
} from "@aws-sdk/client-kms";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  makeAwsDeletionCapsuleKmsReader,
  makeAwsDeletionCapsuleKmsWriter,
  makeAwsKmsKeyService,
} from "../src/encryption/aws-kms";

describe("AWS KMS adapter", () => {
  test("requests an AES-256 Personal Account data key with the complete context", async () => {
    const commands: Array<unknown> = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        return {
          CiphertextBlob: new Uint8Array([4, 5, 6]),
          Plaintext: new Uint8Array(32).fill(7),
        };
      },
    } as unknown as KMSClient;
    const service = makeAwsKmsKeyService(client);
    const encryptionContext = {
      environment: "production",
      keyVersion: "3",
      personalAccountId: "pa_one",
      purpose: "personal-account-key",
    };

    const generated = await Effect.runPromise(
      service.generateDataKey({
        encryptionContext,
        keyId: "arn:aws:kms:us-east-1:111122223333:key/content",
      }),
    );

    expect(generated.plaintext).toHaveLength(32);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect((commands[0] as GenerateDataKeyCommand).input).toEqual({
      EncryptionContext: encryptionContext,
      KeyId: "arn:aws:kms:us-east-1:111122223333:key/content",
      KeySpec: "AES_256",
    });
  });

  test("supplies the same key ID and encryption context when decrypting", async () => {
    const commands: Array<unknown> = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        return { Plaintext: new Uint8Array(32).fill(9) };
      },
    } as unknown as KMSClient;
    const service = makeAwsKmsKeyService(client);
    const encryptionContext = {
      environment: "preview",
      keyVersion: "1",
      personalAccountId: "pa_one",
      purpose: "personal-account-key",
    };

    await Effect.runPromise(
      service.decrypt({
        ciphertext: new Uint8Array([1, 2, 3]),
        encryptionContext,
        keyId: "arn:aws:kms:us-east-1:111122223333:key/content",
      }),
    );

    expect(commands[0]).toBeInstanceOf(DecryptCommand);
    expect((commands[0] as DecryptCommand).input).toEqual({
      CiphertextBlob: new Uint8Array([1, 2, 3]),
      EncryptionContext: encryptionContext,
      KeyId: "arn:aws:kms:us-east-1:111122223333:key/content",
    });
  });

  test("fails closed when KMS omits key material", async () => {
    const client = {
      send: async () => ({}),
    } as unknown as KMSClient;
    const service = makeAwsKmsKeyService(client);

    const result = await Effect.runPromise(
      Effect.either(
        service.generateDataKey({
          encryptionContext: {},
          keyId: "arn:aws:kms:us-east-1:111122223333:key/content",
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AwsKmsError", operation: "generate-data-key" },
    });
  });

  test("zeroes returned plaintext when KMS omits the ciphertext blob", async () => {
    const plaintext = new Uint8Array(32).fill(7);
    const client = {
      send: async () => ({ Plaintext: plaintext }),
    } as unknown as KMSClient;
    const service = makeAwsKmsKeyService(client);

    const result = await Effect.runPromise(
      Effect.either(
        service.generateDataKey({
          encryptionContext: {},
          keyId: "arn:aws:kms:us-east-1:111122223333:key/content",
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AwsKmsError", operation: "generate-data-key" },
    });
    expect(Array.from(plaintext)).toEqual(new Array(32).fill(0));
  });

  test("keeps Deletion Capsule encrypt and decrypt capabilities explicit", async () => {
    const commands: Array<unknown> = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        return command instanceof EncryptCommand
          ? { CiphertextBlob: new Uint8Array([7, 8, 9]) }
          : { Plaintext: new Uint8Array([1, 2, 3]) };
      },
    } as unknown as KMSClient;
    const writer = makeAwsDeletionCapsuleKmsWriter(client);
    const reader = makeAwsDeletionCapsuleKmsReader(client);
    const encryptionContext = {
      deletionMarkerId: "a".repeat(64),
      environment: "production",
      keyVersion: "1",
      purpose: "deletion-capsule",
    };
    const keyId = "arn:aws:kms:us-east-1:111122223333:key/deletion-coordinator";

    await Effect.runPromise(
      writer.encrypt({
        encryptionContext,
        keyId,
        plaintext: new Uint8Array([4, 5, 6]),
      }),
    );
    await Effect.runPromise(
      reader.decrypt({
        ciphertext: new Uint8Array([7, 8, 9]),
        encryptionContext,
        keyId,
      }),
    );

    expect(commands[0]).toBeInstanceOf(EncryptCommand);
    expect((commands[0] as EncryptCommand).input).toEqual({
      EncryptionContext: encryptionContext,
      KeyId: keyId,
      Plaintext: new Uint8Array([4, 5, 6]),
    });
    expect(commands[1]).toBeInstanceOf(DecryptCommand);
    expect((commands[1] as DecryptCommand).input).toEqual({
      CiphertextBlob: new Uint8Array([7, 8, 9]),
      EncryptionContext: encryptionContext,
      KeyId: keyId,
    });
  });

  test("fails closed when KMS omits Deletion Capsule ciphertext", async () => {
    const writer = makeAwsDeletionCapsuleKmsWriter({
      send: async () => ({}),
    } as unknown as KMSClient);

    const result = await Effect.runPromise(
      Effect.either(
        writer.encrypt({
          encryptionContext: {},
          keyId: "deletion-key",
          plaintext: new Uint8Array([1]),
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AwsKmsError", operation: "encrypt" },
    });
  });
});
