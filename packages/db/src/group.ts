import { and, eq, lt, notInArray, sql } from "drizzle-orm";
import type { Client as PgClient } from "pg";
import { makeDatabase, makeQueryConnection } from "./database";
import {
  whatsappGroupDirectoryStatesInApp,
  whatsappGroupsInApp,
} from "./schema";
import { withTransaction } from "./transaction";

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
  readonly namePrefixIndexes: ReadonlyArray<string>;
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
const namePrefixIndexPattern = /^gi1_[A-Za-z0-9_-]{43}$/u;
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
      entry.namePrefixIndexes.length > 62 ||
      entry.namePrefixIndexes.some(
        (index) => !namePrefixIndexPattern.test(index),
      ) ||
      new Set(entry.namePrefixIndexes).size !==
        entry.namePrefixIndexes.length ||
      (!entry.joined && entry.namePrefixIndexes.length > 0) ||
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
  const db = makeDatabase(connection);
  const result = await db.execute<{ personal_account_id: unknown }>(sql`
    SELECT app_private.bootstrap_whatsapp_group_projection(
      ${input.personalAccountId}, ${input.connectionId}
    ) AS personal_account_id
  `);
  if (result[0]?.personal_account_id !== input.personalAccountId) {
    throw new Error("WhatsApp group projection target unavailable");
  }
  await db.execute(
    sql`SELECT set_config(
      'app.personal_account_id', ${input.personalAccountId}, true
    )`,
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
      const result = await makeDatabase(connection).execute(sql`
        SELECT * FROM app_private.claim_whatsapp_group_reconciliation(
          ${input.claimedAt}, ${input.limit}
        )
      `);
      return result.map(reconciliationCandidate);
    }),
  fail: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterContext(connection, input);
        const result = await makeDatabase(connection)
          .update(whatsappGroupDirectoryStatesInApp)
          .set({
            stale: true,
            partial: true,
            reconciliationClaimId: null,
            reconciliationLeaseExpiresAt: null,
            updatedAt: input.failedAt,
          })
          .where(
            and(
              eq(
                whatsappGroupDirectoryStatesInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                whatsappGroupDirectoryStatesInApp.whatsappConnectionId,
                input.connectionId,
              ),
              eq(
                whatsappGroupDirectoryStatesInApp.reconciliationClaimId,
                input.claimId,
              ),
            ),
          )
          .returning({
            whatsappConnectionId:
              whatsappGroupDirectoryStatesInApp.whatsappConnectionId,
          });
        return result.length === 1;
      }),
    ),
  reconcile: (input) => {
    validateInput(input);
    return provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterContext(connection, input);
        const db = makeDatabase(connection);
        if (input.claimId !== undefined) {
          const claim = await db
            .select({
              claim: whatsappGroupDirectoryStatesInApp.reconciliationClaimId,
            })
            .from(whatsappGroupDirectoryStatesInApp)
            .where(
              and(
                eq(
                  whatsappGroupDirectoryStatesInApp.personalAccountId,
                  input.personalAccountId,
                ),
                eq(
                  whatsappGroupDirectoryStatesInApp.whatsappConnectionId,
                  input.connectionId,
                ),
              ),
            )
            .for("update");
          if (claim[0]?.claim !== input.claimId) {
            return { applied: 0, unjoined: 0 };
          }
        }
        const current = await db
          .select({ asOf: whatsappGroupDirectoryStatesInApp.asOf })
          .from(whatsappGroupDirectoryStatesInApp)
          .where(
            and(
              eq(
                whatsappGroupDirectoryStatesInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                whatsappGroupDirectoryStatesInApp.whatsappConnectionId,
                input.connectionId,
              ),
            ),
          )
          .for("update");
        const currentAsOf = current[0]?.asOf;
        if (
          typeof currentAsOf === "string" &&
          new Date(currentAsOf).valueOf() >=
            new Date(input.observedAt).valueOf()
        ) {
          if (input.claimId !== undefined) {
            await db
              .update(whatsappGroupDirectoryStatesInApp)
              .set({
                reconciliationClaimId: null,
                reconciliationLeaseExpiresAt: null,
                updatedAt: input.observedAt,
              })
              .where(
                and(
                  eq(
                    whatsappGroupDirectoryStatesInApp.personalAccountId,
                    input.personalAccountId,
                  ),
                  eq(
                    whatsappGroupDirectoryStatesInApp.whatsappConnectionId,
                    input.connectionId,
                  ),
                  eq(
                    whatsappGroupDirectoryStatesInApp.reconciliationClaimId,
                    input.claimId,
                  ),
                ),
              );
          }
          return { applied: 0, unjoined: 0 };
        }

        let applied = 0;
        for (const entry of input.entries) {
          const existing = await db
            .select({ id: whatsappGroupsInApp.id })
            .from(whatsappGroupsInApp)
            .where(
              and(
                eq(
                  whatsappGroupsInApp.personalAccountId,
                  input.personalAccountId,
                ),
                eq(
                  whatsappGroupsInApp.whatsappConnectionId,
                  input.connectionId,
                ),
                eq(whatsappGroupsInApp.providerLocator, entry.locator),
              ),
            )
            .for("update");
          const existingId = existing[0]?.id;
          const recordId =
            typeof existingId === "string" && uuidPattern.test(existingId)
              ? existingId
              : entry.groupId;
          const encrypted = await input.protect(entry, recordId);
          const fields = protectedValues(encrypted);
          const changed = await db
            .insert(whatsappGroupsInApp)
            .values({
              createdAt: input.observedAt,
              displayNameCiphertext: fields[3],
              displayNameCiphertextVersion: fields[0],
              displayNameKeyVersion: fields[1],
              displayNameNonce: fields[2],
              id: recordId,
              joined: entry.joined,
              lastObservedAt: input.observedAt,
              namePrefixIndexes: [...entry.namePrefixIndexes],
              personalAccountId: input.personalAccountId,
              providerIdentityCiphertext: fields[7],
              providerIdentityCiphertextVersion: fields[4],
              providerIdentityKeyVersion: fields[5],
              providerIdentityNonce: fields[6],
              providerLocator: entry.locator,
              publicId: entry.publicId,
              updatedAt: input.observedAt,
              whatsappConnectionId: input.connectionId,
            })
            .onConflictDoUpdate({
              target: [
                whatsappGroupsInApp.personalAccountId,
                whatsappGroupsInApp.whatsappConnectionId,
                whatsappGroupsInApp.providerLocator,
              ],
              set: {
                displayNameCiphertext: fields[3],
                displayNameCiphertextVersion: fields[0],
                displayNameKeyVersion: fields[1],
                displayNameNonce: fields[2],
                joined: entry.joined,
                lastObservedAt: input.observedAt,
                namePrefixIndexes: [...entry.namePrefixIndexes],
                providerIdentityCiphertext: fields[7],
                providerIdentityCiphertextVersion: fields[4],
                providerIdentityKeyVersion: fields[5],
                providerIdentityNonce: fields[6],
                providerOccurredAt: null,
                providerVersion: null,
                receivedAt: null,
                updatedAt: input.observedAt,
                webhookEventId: null,
                webhookItemIdentity: null,
              },
              setWhere: lt(
                whatsappGroupsInApp.lastObservedAt,
                input.observedAt,
              ),
            })
            .returning({ id: whatsappGroupsInApp.id });
          applied += changed.length;
        }

        let unjoined = 0;
        if (input.completeness === "complete") {
          const locators = input.entries.map((entry) => entry.locator);
          const omitted = await db
            .update(whatsappGroupsInApp)
            .set({
              joined: false,
              lastObservedAt: input.observedAt,
              namePrefixIndexes: [],
              providerOccurredAt: null,
              providerVersion: null,
              receivedAt: null,
              updatedAt: input.observedAt,
              webhookEventId: null,
              webhookItemIdentity: null,
            })
            .where(
              and(
                eq(
                  whatsappGroupsInApp.personalAccountId,
                  input.personalAccountId,
                ),
                eq(
                  whatsappGroupsInApp.whatsappConnectionId,
                  input.connectionId,
                ),
                eq(whatsappGroupsInApp.joined, true),
                lt(whatsappGroupsInApp.lastObservedAt, input.observedAt),
                locators.length === 0
                  ? undefined
                  : notInArray(whatsappGroupsInApp.providerLocator, locators),
              ),
            )
            .returning({ id: whatsappGroupsInApp.id });
          unjoined = omitted.length;
        }

        await db
          .insert(whatsappGroupDirectoryStatesInApp)
          .values({
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.connectionId,
            asOf: input.observedAt,
            snapshotObservedAt: input.observedAt,
            stale: input.stale,
            partial: input.completeness === "partial",
            updatedAt: input.observedAt,
          })
          .onConflictDoUpdate({
            target: [
              whatsappGroupDirectoryStatesInApp.personalAccountId,
              whatsappGroupDirectoryStatesInApp.whatsappConnectionId,
            ],
            set: {
              asOf: input.observedAt,
              snapshotObservedAt: input.observedAt,
              stale: input.stale,
              partial: input.completeness === "partial",
              reconciliationClaimId: null,
              reconciliationLeaseExpiresAt: null,
              updatedAt: input.observedAt,
            },
          });
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
      return await use(makeQueryConnection(client));
    } finally {
      await client.end();
    }
  },
});

export const makePgGroupRepository = (
  connectionString: string,
): GroupRepository =>
  makeGroupRepository(makePgConnectionProvider(connectionString));
