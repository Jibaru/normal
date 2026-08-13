import type {
  EncryptedRecipientRecord,
  RecipientDirectoryMaterial,
} from "@whatsapp-mcp/db/recipient-exclusion";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import type { EnvelopeEncryption } from "../src/encryption/envelope";
import { openRecipientRecords } from "../src/recipient-directory";

const encoded = (value: string) => new TextEncoder().encode(value);
const ciphertext = {
  ciphertext: "AA==",
  keyVersion: 1,
  nonce: "AAAAAAAAAAAAAAAA",
  version: 1 as const,
};
const material: RecipientDirectoryMaterial = {
  accountKey: {
    ciphertext: "AA==",
    keyVersion: 1,
    kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content",
    personalAccountId: "10000000-0000-4000-8000-000000000080",
    version: 1,
  },
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: "AA==",
    connectionId: "20000000-0000-4000-8000-000000000080",
    keyVersion: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    personalAccountId: "10000000-0000-4000-8000-000000000080",
    version: 1,
  },
  identityKey: ciphertext,
  personalAccountId: "10000000-0000-4000-8000-000000000080",
  projection: {
    asOf: "2026-08-13T00:00:00.000Z",
    partial: false,
    stale: false,
  },
  whatsappConnectionId: "20000000-0000-4000-8000-000000000080",
};

describe("recipient Directory decryption", () => {
  test("opens a contact page with one envelope unwrap", async () => {
    let batchCalls = 0;
    const encryption = {
      createConnectionKey: () => Effect.die("not used"),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: () => Effect.die("per field decrypt must not be used"),
      decryptMany: ({ items }) =>
        Effect.sync(() => {
          batchCalls += 1;
          return items.map(({ context }) =>
            encoded(
              context.fieldOrObjectPurpose === "display-name"
                ? context.recordId.endsWith("1")
                  ? "Ada"
                  : "Grace"
                : context.recordId.endsWith("1")
                  ? "+15550123001"
                  : "+15550123002",
            ),
          );
        }),
      encrypt: () => Effect.die("not used"),
    } satisfies EnvelopeEncryption;
    const recipients: EncryptedRecipientRecord[] = [1, 2].map((suffix) => ({
      displayNameCiphertext: ciphertext,
      excluded: suffix === 2,
      phoneCiphertext: ciphertext,
      publicId: `ctc_00000000000000000008${suffix}`,
      recordId: `di1_${"A".repeat(42)}${suffix}`,
    }));

    const opened = await Effect.runPromise(
      openRecipientRecords({
        encryption,
        kind: "contact",
        material,
        recipients,
      }),
    );

    expect(batchCalls).toBe(1);
    expect(opened).toEqual([
      {
        displayName: "Ada",
        excluded: false,
        phoneLastFour: "3001",
        publicId: "ctc_000000000000000000081",
      },
      {
        displayName: "Grace",
        excluded: true,
        phoneLastFour: "3002",
        publicId: "ctc_000000000000000000082",
      },
    ]);
  });
});
