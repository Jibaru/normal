import { sql } from "drizzle-orm";
import {
  makeDatabase,
  type QueryConnection,
  withPgQueryConnection,
} from "./database";

export type RecipientKind = "contact" | "group";

export interface RecipientDirectoryCiphertext {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
}

export interface RecipientAccountKeyEnvelope {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

export interface RecipientConnectionKeyEnvelope {
  readonly accountKeyVersion: number;
  readonly ciphertext: string;
  readonly connectionId: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

export interface RecipientDirectoryMaterial {
  readonly accountKey: RecipientAccountKeyEnvelope;
  readonly connectionKey: RecipientConnectionKeyEnvelope;
  readonly identityKey: RecipientDirectoryCiphertext;
  readonly personalAccountId: string;
  readonly projection: {
    readonly asOf: string;
    readonly partial: boolean;
    readonly stale: boolean;
  };
  readonly whatsappConnectionId: string;
}

export interface EncryptedRecipientRecord {
  readonly displayNameCiphertext: RecipientDirectoryCiphertext | null;
  readonly excluded: boolean;
  readonly phoneCiphertext: RecipientDirectoryCiphertext | null;
  readonly publicId: string;
  readonly recordId: string;
}

export interface PreparedRecipientTransition {
  readonly effectiveAt: string | null;
  readonly excluded: boolean;
  readonly outcome: "prepared" | "conflict" | "unchanged";
  readonly personalAccountId: string;
  readonly purgeCutoffAt: string | null;
  readonly recipientKind: RecipientKind;
  readonly recipientLocator: string;
  readonly transitionId: string | null;
  readonly whatsappConnectionId: string;
}

export interface RecipientExclusionState {
  readonly effectiveAt: string;
  readonly excluded: boolean;
  readonly purgeCutoffAt: string | null;
}

export interface PendingRecipientTransition {
  readonly clerkUserId: string;
  readonly connectionPublicId: string;
  readonly effectiveAt: string;
  readonly excluded: boolean;
  readonly purgeCutoffAt: string | null;
  readonly recipientKind: RecipientKind;
  readonly recipientLocator: string;
  readonly recipientPublicId: string;
  readonly transitionId: string;
  readonly whatsappConnectionId: string;
}

export interface RecipientExclusionConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: QueryConnection) => Promise<Value>,
  ) => Promise<Value>;
}

const bytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" && value.startsWith("\\x")) {
    return Uint8Array.from(
      value
        .slice(2)
        .match(/.{2}/gu)
        ?.map((pair) => Number.parseInt(pair, 16)) ?? [],
    );
  }
  return null;
};

const base64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const positiveInteger = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const timestamp = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
};

const ciphertext = (
  row: Record<string, unknown>,
  prefix: "display_name" | "phone",
): RecipientDirectoryCiphertext | null => {
  const value = bytes(row[`${prefix}_ciphertext`]);
  const nonce = bytes(row[`${prefix}_nonce`]);
  const keyVersion = positiveInteger(row[`${prefix}_key_version`]);
  const version = row[`${prefix}_ciphertext_version`];
  if (
    value === null &&
    nonce === null &&
    keyVersion === null &&
    (version === null || version === undefined)
  ) {
    return null;
  }
  if (
    value === null ||
    nonce?.byteLength !== 12 ||
    keyVersion === null ||
    Number(version) !== 1
  ) {
    throw new Error("invalid encrypted WhatsApp Recipient field");
  }
  return {
    ciphertext: base64(value),
    keyVersion,
    nonce: base64(nonce),
    version: 1,
  };
};

const isRecipientKind = (value: unknown): value is RecipientKind =>
  value === "contact" || value === "group";

const material = (
  row: Record<string, unknown> | undefined,
  kind: RecipientKind,
): RecipientDirectoryMaterial | null => {
  if (row === undefined) return null;
  const accountCiphertext = bytes(row.account_key_ciphertext);
  const accountVersion = positiveInteger(row.account_key_version);
  const connectionAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const connectionCiphertext = bytes(row.connection_key_ciphertext);
  const connectionNonce = bytes(row.connection_key_nonce);
  const connectionVersion = positiveInteger(row.connection_key_version);
  const identityCiphertext = bytes(row.identity_ciphertext);
  const identityNonce = bytes(row.identity_nonce);
  const identityVersion = positiveInteger(row.identity_key_version);
  const asOf = timestamp(
    kind === "contact" ? row.contacts_as_of : row.groups_as_of,
  );
  const stale = kind === "contact" ? row.contacts_stale : row.groups_stale;
  const partial =
    kind === "contact" ? row.contacts_partial : row.groups_partial;
  if (
    typeof row.personal_account_id !== "string" ||
    typeof row.whatsapp_connection_id !== "string" ||
    typeof row.account_kms_key_id !== "string" ||
    row.account_kms_key_id.length === 0 ||
    accountCiphertext === null ||
    accountVersion === null ||
    connectionAccountVersion === null ||
    connectionCiphertext === null ||
    connectionNonce?.byteLength !== 12 ||
    connectionVersion === null ||
    Number(row.identity_ciphertext_version) !== 1 ||
    identityCiphertext === null ||
    identityNonce?.byteLength !== 12 ||
    identityVersion === null ||
    asOf === null ||
    typeof stale !== "boolean" ||
    typeof partial !== "boolean"
  ) {
    throw new Error("invalid WhatsApp Recipient Directory material");
  }
  return {
    accountKey: {
      ciphertext: base64(accountCiphertext),
      keyVersion: accountVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    connectionKey: {
      accountKeyVersion: connectionAccountVersion,
      ciphertext: base64(connectionCiphertext),
      connectionId: row.whatsapp_connection_id,
      keyVersion: connectionVersion,
      nonce: base64(connectionNonce),
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    identityKey: {
      ciphertext: base64(identityCiphertext),
      keyVersion: identityVersion,
      nonce: base64(identityNonce),
      version: 1,
    },
    personalAccountId: row.personal_account_id,
    projection: { asOf, partial, stale },
    whatsappConnectionId: row.whatsapp_connection_id,
  };
};

export const makeRecipientExclusionRepository = (
  provider: RecipientExclusionConnectionProvider,
) => ({
  loadDirectoryMaterial: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
    readonly kind: RecipientKind;
    readonly observedAt: string;
  }): Promise<RecipientDirectoryMaterial | null> =>
    provider.withConnection(async (connection) => {
      const result = await makeDatabase(connection).execute(sql`
        SELECT * FROM public.load_recipient_directory_material(
          ${input.clerkUserId}, ${input.connectionPublicId}, ${input.observedAt}
        )
      `);
      return material(result[0], input.kind);
    }),
  listEncryptedRecipients: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
    readonly cursorPublicId: string | null;
    readonly kind: RecipientKind;
    readonly limit: number;
    readonly searchIndex: string | null;
  }): Promise<ReadonlyArray<EncryptedRecipientRecord>> =>
    provider.withConnection(async (connection) => {
      const result = await makeDatabase(connection).execute(sql`
        SELECT * FROM public.list_whatsapp_recipient_directory(
          ${input.clerkUserId}, ${input.connectionPublicId}, ${input.kind},
          ${input.searchIndex}, ${input.cursorPublicId}, ${input.limit}
        )
      `);
      return result.map((row) => {
        const publicId = row.recipient_public_id;
        const recordId = row.record_id;
        if (
          typeof publicId !== "string" ||
          typeof recordId !== "string" ||
          typeof row.recipient_excluded !== "boolean"
        ) {
          throw new Error("invalid WhatsApp Recipient Directory row");
        }
        return {
          displayNameCiphertext: ciphertext(row, "display_name"),
          excluded: row.recipient_excluded,
          phoneCiphertext: ciphertext(row, "phone"),
          publicId,
          recordId,
        };
      });
    }),
  prepareTransition: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
    readonly excluded: boolean;
    readonly expectedExcluded: boolean;
    readonly idempotencyKey: string;
    readonly recipientPublicId: string;
  }): Promise<PreparedRecipientTransition | null> =>
    provider.withConnection(async (connection) => {
      const result = await makeDatabase(connection).execute(sql`
        SELECT * FROM public.prepare_whatsapp_recipient_exclusion(
          ${input.clerkUserId}, ${input.connectionPublicId},
          ${input.recipientPublicId}, ${input.excluded},
          ${input.expectedExcluded}, ${input.idempotencyKey}
        )
      `);
      const row = result[0];
      if (row === undefined) return null;
      const effectiveAt = timestamp(row.effective_at);
      if (
        (row.outcome !== "prepared" &&
          row.outcome !== "conflict" &&
          row.outcome !== "unchanged") ||
        typeof row.personal_account_id !== "string" ||
        typeof row.whatsapp_connection_id !== "string" ||
        !isRecipientKind(row.recipient_kind) ||
        typeof row.recipient_locator !== "string" ||
        typeof row.recipient_excluded !== "boolean" ||
        (row.outcome === "prepared" &&
          (typeof row.transition_id !== "string" || effectiveAt === null))
      ) {
        throw new Error("invalid WhatsApp Recipient Exclusion transition");
      }
      return {
        effectiveAt,
        excluded: row.recipient_excluded,
        outcome: row.outcome,
        personalAccountId: row.personal_account_id,
        purgeCutoffAt: timestamp(row.purge_cutoff_at),
        recipientKind: row.recipient_kind,
        recipientLocator: row.recipient_locator,
        transitionId:
          typeof row.transition_id === "string" ? row.transition_id : null,
        whatsappConnectionId: row.whatsapp_connection_id,
      };
    }),
  finalizeTransition: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
    readonly observedAt: string;
    readonly recipientPublicId: string;
    readonly transitionId: string;
  }): Promise<RecipientExclusionState | null> =>
    provider.withConnection(async (connection) => {
      const result = await makeDatabase(connection).execute(sql`
        SELECT * FROM public.finalize_whatsapp_recipient_exclusion(
          ${input.clerkUserId}, ${input.connectionPublicId},
          ${input.recipientPublicId}, ${input.transitionId}, ${input.observedAt}
        )
      `);
      const row = result[0];
      if (row === undefined) return null;
      const effectiveAt = timestamp(row.effective_at);
      if (typeof row.recipient_excluded !== "boolean" || effectiveAt === null) {
        throw new Error("invalid WhatsApp Recipient Exclusion state");
      }
      return {
        effectiveAt,
        excluded: row.recipient_excluded,
        purgeCutoffAt: timestamp(row.purge_cutoff_at),
      };
    }),
  listPendingTransitions: (input: {
    readonly limit: number;
    readonly observedAt: string;
  }): Promise<ReadonlyArray<PendingRecipientTransition>> =>
    provider.withConnection(async (connection) => {
      const result = await makeDatabase(connection).execute(sql`
        SELECT * FROM public.list_pending_whatsapp_recipient_exclusions(
          ${input.observedAt}, ${input.limit}
        )
      `);
      return result.map((row) => {
        const effectiveAt = timestamp(row.transition_effective_at);
        if (
          typeof row.clerk_user_id !== "string" ||
          typeof row.connection_public_id !== "string" ||
          typeof row.recipient_public_id !== "string" ||
          typeof row.recipient_locator !== "string" ||
          typeof row.whatsapp_connection_id !== "string" ||
          typeof row.transition_id !== "string" ||
          typeof row.transition_excluded !== "boolean" ||
          !isRecipientKind(row.recipient_kind) ||
          effectiveAt === null
        ) {
          throw new Error("invalid pending WhatsApp Recipient Exclusion");
        }
        return {
          clerkUserId: row.clerk_user_id,
          connectionPublicId: row.connection_public_id,
          effectiveAt,
          excluded: row.transition_excluded,
          purgeCutoffAt: timestamp(row.transition_purge_cutoff_at),
          recipientKind: row.recipient_kind,
          recipientLocator: row.recipient_locator,
          recipientPublicId: row.recipient_public_id,
          transitionId: row.transition_id,
          whatsappConnectionId: row.whatsapp_connection_id,
        };
      });
    }),
  purgeExcludedHistory: (input: {
    readonly limit: number;
    readonly observedAt: string;
  }): Promise<number> =>
    provider.withConnection(async (connection) => {
      const result = await makeDatabase(connection).execute<{
        removed: unknown;
      }>(sql`
        SELECT public.purge_excluded_recipient_history(
          ${input.observedAt}, ${input.limit}
        ) AS removed
      `);
      const removed = Number(result[0]?.removed);
      if (!Number.isSafeInteger(removed) || removed < 0) {
        throw new Error("invalid WhatsApp Recipient Exclusion purge result");
      }
      return removed;
    }),
});

export type RecipientExclusionRepository = ReturnType<
  typeof makeRecipientExclusionRepository
>;

export const makePgRecipientExclusionRepository = (connectionString: string) =>
  makeRecipientExclusionRepository({
    withConnection: (use) =>
      withPgQueryConnection(connectionString, use, 70_000),
  });
