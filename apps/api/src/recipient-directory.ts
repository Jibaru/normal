import type {
  EncryptedRecipientRecord,
  RecipientDirectoryMaterial,
  RecipientKind,
} from "@whatsapp-mcp/db/recipient-exclusion";
import { Effect } from "effect";
import {
  contactSearchIndex,
  decryptDirectoryString,
  importDirectoryIndexKey,
} from "./directory-privacy";
import type { EnvelopeEncryption } from "./encryption/envelope";
import {
  groupSearchIndex,
  importGroupDirectoryIndexKey,
} from "./group-privacy";
import type { OpenRecipientRecord } from "./recipient-exclusion";
import { RecipientExclusionPersistenceError } from "./recipient-exclusion";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const persistenceError = () => new RecipientExclusionPersistenceError();

// The connection scoped index key is the same secret the MCP Directory reads
// use; it is zero filled as soon as the blind index is derived.
const withIndexKeyBytes = <Value>(
  encryption: EnvelopeEncryption,
  material: RecipientDirectoryMaterial,
  use: (bytes: Uint8Array) => Effect.Effect<Value, unknown>,
) =>
  encryption
    .decrypt({
      accountKey: material.accountKey,
      ciphertext: material.identityKey,
      connectionKey: material.connectionKey,
      context: {
        accountId: material.personalAccountId,
        connectionId: material.whatsappConnectionId,
        entity: "whatsapp-connection",
        fieldOrObjectPurpose: "webhook-identity-key",
        recordId: material.whatsappConnectionId,
      },
    })
    .pipe(
      Effect.flatMap((bytes) =>
        Effect.acquireUseRelease(Effect.succeed(bytes), use, (value) =>
          Effect.sync(() => value.fill(0)),
        ),
      ),
      Effect.mapError(persistenceError),
    );

export const openRecipientSearchIndex = (input: {
  readonly encryption: EnvelopeEncryption;
  readonly kind: RecipientKind;
  readonly material: RecipientDirectoryMaterial;
  readonly search: string | null;
}): Effect.Effect<string | null, RecipientExclusionPersistenceError> =>
  input.search === null
    ? Effect.succeed(null)
    : withIndexKeyBytes(input.encryption, input.material, (bytes) =>
        input.kind === "contact"
          ? importDirectoryIndexKey(bytes).pipe(
              Effect.flatMap((key) =>
                contactSearchIndex(
                  key,
                  input.material.whatsappConnectionId,
                  input.search ?? "",
                ),
              ),
              // Product Settings searches display names only; a phone blind
              // index lookup must not be reachable from this boundary.
              Effect.flatMap((result) =>
                result.kind === "name"
                  ? Effect.succeed(result.index as string | null)
                  : Effect.fail(persistenceError()),
              ),
            )
          : importGroupDirectoryIndexKey(bytes).pipe(
              Effect.flatMap((key) =>
                groupSearchIndex(
                  key,
                  input.material.whatsappConnectionId,
                  input.search ?? "",
                ),
              ),
              Effect.map((index) => index as string | null),
            ),
      ).pipe(Effect.mapError(persistenceError));

const openGroupName = (input: {
  readonly encryption: EnvelopeEncryption;
  readonly material: RecipientDirectoryMaterial;
  readonly recipient: EncryptedRecipientRecord;
}) =>
  input.recipient.displayNameCiphertext === null
    ? Effect.succeed(null)
    : input.encryption
        .decrypt({
          accountKey: input.material.accountKey,
          ciphertext: input.recipient.displayNameCiphertext,
          connectionKey: input.material.connectionKey,
          context: {
            accountId: input.material.personalAccountId,
            connectionId: input.material.whatsappConnectionId,
            entity: "whatsapp-group",
            fieldOrObjectPurpose: "display-name",
            recordId: input.recipient.recordId,
          },
        })
        .pipe(
          Effect.flatMap((bytes) =>
            Effect.acquireUseRelease(
              Effect.succeed(bytes),
              (value) =>
                Effect.try({
                  catch: persistenceError,
                  try: () => decoder.decode(value),
                }),
              (value) => Effect.sync(() => value.fill(0)),
            ),
          ),
          Effect.mapError(persistenceError),
        );

const openContact = (input: {
  readonly encryption: EnvelopeEncryption;
  readonly material: RecipientDirectoryMaterial;
  readonly recipient: EncryptedRecipientRecord;
}) =>
  Effect.all(
    [
      decryptDirectoryString({
        accountKey: input.material.accountKey,
        ciphertext: input.recipient.displayNameCiphertext,
        connectionKey: input.material.connectionKey,
        encryption: input.encryption,
        field: "display-name",
        providerIdentityIndex: input.recipient.recordId,
      }),
      decryptDirectoryString({
        accountKey: input.material.accountKey,
        ciphertext: input.recipient.phoneCiphertext,
        connectionKey: input.material.connectionKey,
        encryption: input.encryption,
        field: "phone-number",
        providerIdentityIndex: input.recipient.recordId,
      }),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(persistenceError),
    Effect.flatMap(([displayName, phoneNumber]) =>
      phoneNumber !== null && !/^\+[1-9]\d{6,14}$/u.test(phoneNumber)
        ? Effect.fail(persistenceError())
        : Effect.succeed({
            displayName,
            excluded: input.recipient.excluded,
            // Only the final four digits ever leave the API for a direct
            // recipient.
            phoneLastFour: phoneNumber === null ? null : phoneNumber.slice(-4),
            publicId: input.recipient.publicId,
          } satisfies OpenRecipientRecord),
    ),
  );

export const openRecipientRecords = (input: {
  readonly encryption: EnvelopeEncryption;
  readonly kind: RecipientKind;
  readonly material: RecipientDirectoryMaterial;
  readonly recipients: ReadonlyArray<EncryptedRecipientRecord>;
}): Effect.Effect<
  ReadonlyArray<OpenRecipientRecord>,
  RecipientExclusionPersistenceError
> =>
  Effect.forEach(
    input.recipients,
    (recipient) =>
      input.kind === "contact"
        ? openContact({
            encryption: input.encryption,
            material: input.material,
            recipient,
          })
        : openGroupName({
            encryption: input.encryption,
            material: input.material,
            recipient,
          }).pipe(
            Effect.map((displayName: string | null) => ({
              displayName,
              excluded: recipient.excluded,
              // A group discloses no description, roster, or phone data here.
              phoneLastFour: null,
              publicId: recipient.publicId,
            })),
          ),
    { concurrency: 16 },
  );
