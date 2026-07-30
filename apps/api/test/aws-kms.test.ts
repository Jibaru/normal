import {
  DecryptCommand,
  GenerateDataKeyCommand,
  type KMSClient,
} from "@aws-sdk/client-kms";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { makeAwsKmsKeyService } from "../src/encryption/aws-kms";

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
});
