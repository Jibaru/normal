import type { Client as PgClient } from "pg";

export interface DirectoryConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface DirectoryConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: DirectoryConnection) => Promise<Value>,
  ) => Promise<Value>;
}

interface AccountKeyEnvelope {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

interface ConnectionKeyEnvelope {
  readonly accountKeyVersion: number;
  readonly ciphertext: string;
  readonly connectionId: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

export interface DirectoryCiphertext {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
}

export interface ContactReconciliationCandidate {
  readonly accountKey: AccountKeyEnvelope;
  readonly authority: DirectoryCiphertext;
  readonly claimId: string;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly identityKey: DirectoryCiphertext;
  readonly personalAccountId: string;
  readonly whatsappConnectionId: string;
}

export interface ReconciledProtectedContact {
  readonly displayNameCiphertext: DirectoryCiphertext | null;
  readonly displayNameSort: string;
  readonly namePrefixIndexes: ReadonlyArray<string>;
  readonly phoneCiphertext: DirectoryCiphertext | null;
  readonly phoneIndex: string | null;
  readonly providerIdentityCiphertext: DirectoryCiphertext;
  readonly providerIdentityIndex: string;
  readonly publicId: string;
}

export interface DirectoryRepository {
  readonly claimContactReconciliations: (input: {
    readonly claimedAt: string;
    readonly limit: number;
  }) => Promise<ReadonlyArray<ContactReconciliationCandidate>>;
  readonly failContactReconciliation: (input: {
    readonly claimId: string;
    readonly failedAt: string;
    readonly whatsappConnectionId: string;
  }) => Promise<boolean>;
  readonly finishContactReconciliation: (input: {
    readonly claimId: string;
    readonly contacts: ReadonlyArray<ReconciledProtectedContact>;
    readonly observedAt: string;
    readonly partial: boolean;
    readonly stale: boolean;
    readonly whatsappConnectionId: string;
  }) => Promise<boolean>;
}

const positiveInteger = (value: unknown): number | null => {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : value;
  return typeof parsed === "number" &&
    Number.isSafeInteger(parsed) &&
    parsed > 0
    ? parsed
    : null;
};

const bytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  return null;
};

const base64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

interface CandidateRow extends Record<string, unknown> {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly account_kms_key_id: unknown;
  readonly authority_ciphertext: unknown;
  readonly authority_ciphertext_version: unknown;
  readonly authority_key_version: unknown;
  readonly authority_nonce: unknown;
  readonly connection_key_account_version: unknown;
  readonly connection_key_ciphertext: unknown;
  readonly connection_key_nonce: unknown;
  readonly connection_key_version: unknown;
  readonly identity_ciphertext: unknown;
  readonly identity_ciphertext_version: unknown;
  readonly identity_key_version: unknown;
  readonly identity_nonce: unknown;
  readonly personal_account_id: unknown;
  readonly reconciliation_claim_id: unknown;
  readonly whatsapp_connection_id: unknown;
}

const ciphertext = (
  row: CandidateRow,
  prefix: "authority" | "identity",
): DirectoryCiphertext | null => {
  const value = bytes(row[`${prefix}_ciphertext`]);
  const nonce = bytes(row[`${prefix}_nonce`]);
  const keyVersion = positiveInteger(row[`${prefix}_key_version`]);
  if (
    value === null ||
    nonce?.byteLength !== 12 ||
    keyVersion === null ||
    row[`${prefix}_ciphertext_version`] !== 1
  ) {
    return null;
  }
  return {
    ciphertext: base64(value),
    keyVersion,
    nonce: base64(nonce),
    version: 1,
  };
};

const candidate = (row: CandidateRow): ContactReconciliationCandidate => {
  const accountCiphertext = bytes(row.account_key_ciphertext);
  const accountVersion = positiveInteger(row.account_key_version);
  const connectionCiphertext = bytes(row.connection_key_ciphertext);
  const connectionNonce = bytes(row.connection_key_nonce);
  const connectionVersion = positiveInteger(row.connection_key_version);
  const connectionAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const authority = ciphertext(row, "authority");
  const identityKey = ciphertext(row, "identity");
  if (
    typeof row.personal_account_id !== "string" ||
    typeof row.whatsapp_connection_id !== "string" ||
    typeof row.reconciliation_claim_id !== "string" ||
    typeof row.account_kms_key_id !== "string" ||
    accountCiphertext === null ||
    accountVersion === null ||
    connectionCiphertext === null ||
    connectionNonce?.byteLength !== 12 ||
    connectionVersion === null ||
    connectionAccountVersion === null ||
    authority === null ||
    identityKey === null
  ) {
    throw new Error("invalid contact reconciliation candidate");
  }
  return {
    accountKey: {
      ciphertext: base64(accountCiphertext),
      keyVersion: accountVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    authority,
    claimId: row.reconciliation_claim_id,
    connectionKey: {
      accountKeyVersion: connectionAccountVersion,
      ciphertext: base64(connectionCiphertext),
      connectionId: row.whatsapp_connection_id,
      keyVersion: connectionVersion,
      nonce: base64(connectionNonce),
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    identityKey,
    personalAccountId: row.personal_account_id,
    whatsappConnectionId: row.whatsapp_connection_id,
  };
};

const encodedContact = (contact: ReconciledProtectedContact) => ({
  display_name_ciphertext: contact.displayNameCiphertext?.ciphertext ?? null,
  display_name_ciphertext_version:
    contact.displayNameCiphertext?.version ?? null,
  display_name_key_version: contact.displayNameCiphertext?.keyVersion ?? null,
  display_name_nonce: contact.displayNameCiphertext?.nonce ?? null,
  display_name_sort: contact.displayNameSort,
  name_prefix_indexes: contact.namePrefixIndexes,
  phone_ciphertext: contact.phoneCiphertext?.ciphertext ?? null,
  phone_ciphertext_version: contact.phoneCiphertext?.version ?? null,
  phone_index: contact.phoneIndex,
  phone_key_version: contact.phoneCiphertext?.keyVersion ?? null,
  phone_nonce: contact.phoneCiphertext?.nonce ?? null,
  provider_identity_ciphertext: contact.providerIdentityCiphertext.ciphertext,
  provider_identity_ciphertext_version:
    contact.providerIdentityCiphertext.version,
  provider_identity_index: contact.providerIdentityIndex,
  provider_identity_key_version: contact.providerIdentityCiphertext.keyVersion,
  provider_identity_nonce: contact.providerIdentityCiphertext.nonce,
  public_id: contact.publicId,
});

export const makeDirectoryRepository = (
  provider: DirectoryConnectionProvider,
): DirectoryRepository => ({
  claimContactReconciliations: (input) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<CandidateRow>(
        "SELECT * FROM app_private.claim_contact_reconciliations($1, $2)",
        [input.claimedAt, input.limit],
      );
      return result.rows.map(candidate);
    }),
  failContactReconciliation: (input) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{ failed: unknown }>(
        `SELECT app_private.fail_contact_reconciliation($1, $2, $3) AS failed`,
        [input.whatsappConnectionId, input.claimId, input.failedAt],
      );
      return result.rows[0]?.failed === true;
    }),
  finishContactReconciliation: (input) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{ finished: unknown }>(
        `SELECT app_private.finish_contact_reconciliation(
           $1, $2, $3, $4, $5, $6::jsonb
         ) AS finished`,
        [
          input.whatsappConnectionId,
          input.claimId,
          input.observedAt,
          input.stale,
          input.partial,
          JSON.stringify(input.contacts.map(encodedContact)),
        ],
      );
      return result.rows[0]?.finished === true;
    }),
});

const makePgConnectionProvider = (
  connectionString: string,
): DirectoryConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: DirectoryConnection) => Promise<Value>,
  ): Promise<Value> => {
    const { Client } = await import("pg");
    const client: PgClient = new Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
    });
    await client.connect();
    try {
      return await use({
        query: async (text, values) => {
          const result = await client.query(text, values);
          return { rows: result.rows };
        },
      });
    } finally {
      await client.end();
    }
  },
});

export const makePgDirectoryRepository = (
  connectionString: string,
): DirectoryRepository =>
  makeDirectoryRepository(makePgConnectionProvider(connectionString));
