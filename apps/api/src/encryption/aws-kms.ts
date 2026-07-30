import {
  DecryptCommand,
  GenerateDataKeyCommand,
  type KMSClient,
} from "@aws-sdk/client-kms";
import { Data, Effect } from "effect";
import type { KmsKeyService } from "./envelope";

export type AwsKmsOperation = "decrypt" | "generate-data-key";

export class AwsKmsError extends Data.TaggedError("AwsKmsError")<{
  readonly operation: AwsKmsOperation;
}> {}

const requiredBytes = (
  value: Uint8Array | undefined,
  operation: AwsKmsOperation,
) => {
  if (!value || value.byteLength === 0) {
    throw new AwsKmsError({ operation });
  }
  return value;
};

export const makeAwsKmsKeyService = (
  client: Pick<KMSClient, "send">,
): KmsKeyService => ({
  generateDataKey: ({ encryptionContext, keyId }) =>
    Effect.tryPromise({
      try: async () => {
        const result = await client.send(
          new GenerateDataKeyCommand({
            EncryptionContext: encryptionContext,
            KeyId: keyId,
            KeySpec: "AES_256",
          }),
        );
        if (
          !result.CiphertextBlob ||
          result.CiphertextBlob.byteLength === 0 ||
          !result.Plaintext ||
          result.Plaintext.byteLength === 0
        ) {
          result.Plaintext?.fill(0);
          throw new AwsKmsError({ operation: "generate-data-key" });
        }
        return {
          ciphertext: result.CiphertextBlob,
          plaintext: result.Plaintext,
        };
      },
      catch: () =>
        new AwsKmsError({
          operation: "generate-data-key",
        }),
    }),
  decrypt: ({ ciphertext, encryptionContext, keyId }) =>
    Effect.tryPromise({
      try: async () => {
        const result = await client.send(
          new DecryptCommand({
            CiphertextBlob: ciphertext,
            EncryptionContext: encryptionContext,
            KeyId: keyId,
          }),
        );
        return requiredBytes(result.Plaintext, "decrypt");
      },
      catch: () => new AwsKmsError({ operation: "decrypt" }),
    }),
});
