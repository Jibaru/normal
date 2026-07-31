import type { Client as PgClient } from "pg";

export interface GroupCiphertextEnvelope {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
}

export interface GroupReconciliationCandidate {
  readonly accountKey: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly kmsKeyId: string;
    readonly personalAccountId: string;
    readonly version: 1;
  };
  readonly claimId: string;
  readonly connectionId: string;
  readonly connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: string;
    readonly connectionId: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly personalAccountId: string;
    readonly version: 1;
  };
  readonly identityKey: GroupCiphertextEnvelope;
  readonly personalAccountId: string;
  readonly providerAuthority: GroupCiphertextEnvelope;
}

export interface GroupConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface GroupConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: GroupConnection) => Promise<Value>,
  ) => Promise<Value>;
}

export interface ProtectedGroupValue {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
  readonly version: 1;
}

export interface ProtectedGroupFields {
  readonly displayName: ProtectedGroupValue | null;
  readonly providerIdentity: ProtectedGroupValue;
}

export interface GroupProjectionEntry {
  readonly displayName: string | null;
  readonly groupId: string;
  readonly joined: boolean;
  readonly locator: string;
  readonly providerIdentity: string;
  readonly publicId: string;
}

export interface ReconcileGroupsInput {
  readonly claimId?: string | undefined;
  readonly completeness: "complete" | "partial";
  readonly connectionId: string;
  readonly entries: ReadonlyArray<GroupProjectionEntry>;
  readonly observedAt: string;
  readonly personalAccountId: string;
  readonly protect: (
    entry: GroupProjectionEntry,
    recordId: string,
  ) => Promise<ProtectedGroupFields>;
  readonly stale: boolean;
}

export interface GroupRepository {
  readonly claim: (input: {
    readonly claimedAt: string;
    readonly limit: number;
  }) => Promise<ReadonlyArray<GroupReconciliationCandidate>>;
  readonly fail: (input: {
    readonly claimId: string;
    readonly connectionId: string;
    readonly failedAt: string;
    readonly personalAccountId: string;
  }) => Promise<boolean>;
  readonly reconcile: (
    input: ReconcileGroupsInput,
  ) => Promise<{ readonly applied: number; readonly unjoined: number }>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const publicIdPattern = /^grp_[A-Za-z0-9_-]{21}$/u;
const locatorPattern = /^wi1_[A-Za-z0-9_-]{43}$/u;
const encodeBase64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const bytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  return null;
};

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

const reconciliationCandidate = (
  row: Record<string, unknown>,
): GroupReconciliationCandidate => {
  const claimId = row.claim_id;
  const personalAccountId = row.personal_account_id;
  const connectionId = row.whatsapp_connection_id;
  const accountKeyVersion = positiveInteger(row.account_key_version);
  const accountCiphertext = bytes(row.account_key_ciphertext);
  const connectionAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const connectionKeyVersion = positiveInteger(row.connection_key_version);
  const connectionNonce = bytes(row.connection_key_nonce);
  const connectionCiphertext = bytes(row.connection_key_ciphertext);
  const authorityVersion = positiveInteger(row.authority_ciphertext_version);
  const authorityKeyVersion = positiveInteger(row.authority_key_version);
  const authorityNonce = bytes(row.authority_nonce);
  const authorityCiphertext = bytes(row.authority_ciphertext);
  const identityVersion = positiveInteger(row.identity_ciphertext_version);
  const identityKeyVersion = positiveInteger(row.identity_key_version);
  const identityNonce = bytes(row.identity_nonce);
  const identityCiphertext = bytes(row.identity_ciphertext);
  if (
    typeof claimId !== "string" ||
    !uuidPattern.test(claimId) ||
    typeof personalAccountId !== "string" ||
    !uuidPattern.test(personalAccountId) ||
    typeof connectionId !== "string" ||
    !uuidPattern.test(connectionId) ||
    typeof row.account_kms_key_id !== "string" ||
    accountKeyVersion === null ||
    accountCiphertext === null ||
    connectionAccountVersion === null ||
    connectionKeyVersion === null ||
    connectionNonce === null ||
    connectionCiphertext === null ||
    authorityVersion !== 1 ||
    authorityKeyVersion === null ||
    authorityNonce === null ||
    authorityCiphertext === null ||
    identityVersion !== 1 ||
    identityKeyVersion === null ||
    identityNonce === null ||
    identityCiphertext === null
  ) {
    throw new Error("invalid WhatsApp group reconciliation claim");
  }
  return {
    accountKey: {
      ciphertext: encodeBase64(accountCiphertext),
      keyVersion: accountKeyVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId,
      version: 1,
    },
    claimId,
    connectionId,
    connectionKey: {
      accountKeyVersion: connectionAccountVersion,
      ciphertext: encodeBase64(connectionCiphertext),
      connectionId,
      keyVersion: connectionKeyVersion,
      nonce: encodeBase64(connectionNonce),
      personalAccountId,
      version: 1,
    },
    identityKey: {
      ciphertext: encodeBase64(identityCiphertext),
      keyVersion: identityKeyVersion,
      nonce: encodeBase64(identityNonce),
      version: 1,
    },
    personalAccountId,
    providerAuthority: {
      ciphertext: encodeBase64(authorityCiphertext),
      keyVersion: authorityKeyVersion,
      nonce: encodeBase64(authorityNonce),
      version: 1,
    },
  };
};

const withTransaction = async <Value>(
  connection: GroupConnection,
  use: () => Promise<Value>,
): Promise<Value> => {
  await connection.query("BEGIN");
  try {
    const value = await use();
    await connection.query("COMMIT");
    return value;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
};

const validDate = (value: string): boolean => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
};

const validProtectedValue = (value: ProtectedGroupValue): boolean =>
  value.version === 1 &&
  Number.isSafeInteger(value.keyVersion) &&
  value.keyVersion > 0 &&
  value.nonce.byteLength === 12 &&
  value.ciphertext.byteLength > 16;

const validateInput = (input: ReconcileGroupsInput): void => {
  if (
    !uuidPattern.test(input.personalAccountId) ||
    !uuidPattern.test(input.connectionId) ||
    !validDate(input.observedAt) ||
    input.entries.length > 10_000
  ) {
    throw new Error("invalid WhatsApp group observation");
  }
  const locators = new Set<string>();
  const ids = new Set<string>();
  const publicIds = new Set<string>();
  for (const entry of input.entries) {
    if (
      !uuidPattern.test(entry.groupId) ||
      !publicIdPattern.test(entry.publicId) ||
      !locatorPattern.test(entry.locator) ||
      entry.providerIdentity.length === 0 ||
      entry.providerIdentity.length > 4_096 ||
      (entry.displayName !== null && entry.displayName.length > 4_096) ||
      locators.has(entry.locator) ||
      ids.has(entry.groupId) ||
      publicIds.has(entry.publicId)
    ) {
      throw new Error("invalid WhatsApp group entry");
    }
    locators.add(entry.locator);
    ids.add(entry.groupId);
    publicIds.add(entry.publicId);
  }
};

const enterContext = async (
  connection: GroupConnection,
  input: Pick<ReconcileGroupsInput, "connectionId" | "personalAccountId">,
): Promise<void> => {
  const result = await connection.query<{ personal_account_id: unknown }>(
    `SELECT app_private.bootstrap_whatsapp_group_projection($1, $2)
       AS personal_account_id`,
    [input.personalAccountId, input.connectionId],
  );
  if (result.rows[0]?.personal_account_id !== input.personalAccountId) {
    throw new Error("WhatsApp group projection target unavailable");
  }
  await connection.query(
    "SELECT set_config('app.personal_account_id', $1, true)",
    [input.personalAccountId],
  );
};

const protectedValues = (value: ProtectedGroupFields) => {
  if (
    !validProtectedValue(value.providerIdentity) ||
    (value.displayName !== null && !validProtectedValue(value.displayName))
  ) {
    throw new Error("invalid encrypted WhatsApp group fields");
  }
  return [
    value.displayName?.version ?? null,
    value.displayName?.keyVersion ?? null,
    value.displayName?.nonce ?? null,
    value.displayName?.ciphertext ?? null,
    value.providerIdentity.version,
    value.providerIdentity.keyVersion,
    value.providerIdentity.nonce,
    value.providerIdentity.ciphertext,
  ] as const;
};

export const makeGroupRepository = (
  provider: GroupConnectionProvider,
): GroupRepository => ({
  claim: (input) =>
    provider.withConnection(async (connection) => {
      if (
        !validDate(input.claimedAt) ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      ) {
        throw new Error("invalid group reconciliation claim");
      }
      const result = await connection.query(
        "SELECT * FROM app_private.claim_whatsapp_group_reconciliation($1, $2)",
        [input.claimedAt, input.limit],
      );
      return result.rows.map(reconciliationCandidate);
    }),
  fail: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterContext(connection, input);
        const result = await connection.query<{
          whatsapp_connection_id: unknown;
        }>(
          `UPDATE app.whatsapp_group_directory_states
           SET
             stale = true,
             partial = true,
             reconciliation_claim_id = NULL,
             reconciliation_lease_expires_at = NULL,
             updated_at = $4
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2
             AND reconciliation_claim_id = $3
           RETURNING whatsapp_connection_id`,
          [
            input.personalAccountId,
            input.connectionId,
            input.claimId,
            input.failedAt,
          ],
        );
        return result.rows.length === 1;
      }),
    ),
  reconcile: (input) => {
    validateInput(input);
    return provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterContext(connection, input);
        if (input.claimId !== undefined) {
          const claim = await connection.query<{ claim: unknown }>(
            `SELECT reconciliation_claim_id AS claim
             FROM app.whatsapp_group_directory_states
             WHERE personal_account_id = $1
               AND whatsapp_connection_id = $2
             FOR UPDATE`,
            [input.personalAccountId, input.connectionId],
          );
          if (claim.rows[0]?.claim !== input.claimId) {
            return { applied: 0, unjoined: 0 };
          }
        }
        const current = await connection.query<{ as_of: unknown }>(
          `SELECT as_of
           FROM app.whatsapp_group_directory_states
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2
           FOR UPDATE`,
          [input.personalAccountId, input.connectionId],
        );
        const currentAsOf = current.rows[0]?.as_of;
        if (
          currentAsOf instanceof Date
            ? currentAsOf.valueOf() >= new Date(input.observedAt).valueOf()
            : typeof currentAsOf === "string" &&
              new Date(currentAsOf).valueOf() >=
                new Date(input.observedAt).valueOf()
        ) {
          if (input.claimId !== undefined) {
            await connection.query(
              `UPDATE app.whatsapp_group_directory_states
               SET
                 reconciliation_claim_id = NULL,
                 reconciliation_lease_expires_at = NULL,
                 updated_at = $4
               WHERE personal_account_id = $1
                 AND whatsapp_connection_id = $2
                 AND reconciliation_claim_id = $3`,
              [
                input.personalAccountId,
                input.connectionId,
                input.claimId,
                input.observedAt,
              ],
            );
          }
          return { applied: 0, unjoined: 0 };
        }

        let applied = 0;
        for (const entry of input.entries) {
          const existing = await connection.query<{
            id: unknown;
            last_observed_at: unknown;
          }>(
            `SELECT id, last_observed_at
             FROM app.whatsapp_groups
             WHERE personal_account_id = $1
               AND whatsapp_connection_id = $2
               AND provider_locator = $3
             FOR UPDATE`,
            [input.personalAccountId, input.connectionId, entry.locator],
          );
          const existingId = existing.rows[0]?.id;
          const recordId =
            typeof existingId === "string" && uuidPattern.test(existingId)
              ? existingId
              : entry.groupId;
          const encrypted = await input.protect(entry, recordId);
          const fields = protectedValues(encrypted);
          const changed = await connection.query<{ id: unknown }>(
            `INSERT INTO app.whatsapp_groups (
               id, personal_account_id, whatsapp_connection_id, public_id,
               provider_locator, display_name_ciphertext_version,
               display_name_key_version, display_name_nonce,
               display_name_ciphertext, provider_identity_ciphertext_version,
               provider_identity_key_version, provider_identity_nonce,
               provider_identity_ciphertext, joined, last_observed_at,
               created_at, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $15, $15
             )
             ON CONFLICT (personal_account_id, whatsapp_connection_id, provider_locator)
             DO UPDATE SET
               display_name_ciphertext_version = EXCLUDED.display_name_ciphertext_version,
               display_name_key_version = EXCLUDED.display_name_key_version,
               display_name_nonce = EXCLUDED.display_name_nonce,
               display_name_ciphertext = EXCLUDED.display_name_ciphertext,
               provider_identity_ciphertext_version = EXCLUDED.provider_identity_ciphertext_version,
               provider_identity_key_version = EXCLUDED.provider_identity_key_version,
               provider_identity_nonce = EXCLUDED.provider_identity_nonce,
               provider_identity_ciphertext = EXCLUDED.provider_identity_ciphertext,
               joined = EXCLUDED.joined,
               last_observed_at = EXCLUDED.last_observed_at,
               provider_occurred_at = NULL,
               provider_version = NULL,
               received_at = NULL,
               webhook_event_id = NULL,
               webhook_item_identity = NULL,
               updated_at = EXCLUDED.updated_at
             WHERE app.whatsapp_groups.last_observed_at < EXCLUDED.last_observed_at
             RETURNING id`,
            [
              recordId,
              input.personalAccountId,
              input.connectionId,
              entry.publicId,
              entry.locator,
              ...fields,
              entry.joined,
              input.observedAt,
            ],
          );
          applied += changed.rows.length;
        }

        let unjoined = 0;
        if (input.completeness === "complete") {
          const omitted = await connection.query<{ id: unknown }>(
            `UPDATE app.whatsapp_groups
             SET joined = false,
                 last_observed_at = $3,
                 provider_occurred_at = NULL,
                 provider_version = NULL,
                 received_at = NULL,
                 webhook_event_id = NULL,
                 webhook_item_identity = NULL,
                 updated_at = $3
             WHERE personal_account_id = $1
               AND whatsapp_connection_id = $2
               AND joined
               AND last_observed_at < $3
               AND NOT (provider_locator = ANY($4::text[]))
             RETURNING id`,
            [
              input.personalAccountId,
              input.connectionId,
              input.observedAt,
              input.entries.map((entry) => entry.locator),
            ],
          );
          unjoined = omitted.rows.length;
        }

        await connection.query(
          `INSERT INTO app.whatsapp_group_directory_states (
             personal_account_id, whatsapp_connection_id, as_of,
             stale, partial, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $3)
           ON CONFLICT (personal_account_id, whatsapp_connection_id)
           DO UPDATE SET
             as_of = EXCLUDED.as_of,
             stale = EXCLUDED.stale,
             partial = EXCLUDED.partial,
             reconciliation_claim_id = NULL,
             reconciliation_lease_expires_at = NULL,
             updated_at = EXCLUDED.updated_at`,
          [
            input.personalAccountId,
            input.connectionId,
            input.observedAt,
            input.stale,
            input.completeness === "partial",
          ],
        );
        return { applied, unjoined };
      }),
    );
  },
});

const makePgConnectionProvider = (
  connectionString: string,
): GroupConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: GroupConnection) => Promise<Value>,
  ): Promise<Value> => {
    const { Client } = await import("pg");
    const client: PgClient = new Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 25_000,
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

export const makePgGroupRepository = (
  connectionString: string,
): GroupRepository =>
  makeGroupRepository(makePgConnectionProvider(connectionString));
