import type { Client as PgClient } from "pg";
import { makeQueryConnection } from "./database";

export interface PersonalAccountConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface PersonalAccountConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: PersonalAccountConnection) => Promise<Value>,
  ) => Promise<Value>;
}

export interface ActivePersonalAccount {
  readonly admissionState: "active";
  readonly keyAvailable: boolean;
  readonly messageRetentionDays: number;
  readonly personalAccountId: string;
  readonly storedMediaLimitBytes: number;
  readonly whatsappConnectionLimit: number;
}

export interface WaitlistedPersonalAccount {
  readonly admissionState: "waitlisted";
}

export type ResolvedPersonalAccount =
  | ActivePersonalAccount
  | WaitlistedPersonalAccount;

export interface CreatePersonalAccountInput {
  readonly clerkUserId: string;
  readonly keyCiphertext: Uint8Array;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
  readonly providerApprovedSessionCapacity: number;
}

export interface CreatedPersonalAccount {
  readonly admissionState: "active";
  readonly created: boolean;
  readonly messageRetentionDays: number;
  readonly personalAccountId: string;
  readonly storedMediaLimitBytes: number;
  readonly whatsappConnectionLimit: number;
}

export interface PersonalAccountRepository {
  readonly listDeletionPurgeCandidates: (input: {
    readonly limit: number;
    readonly observedAt: string;
  }) => Promise<
    ReadonlyArray<{
      readonly deadlineAt: string;
      readonly deadlineRisk: boolean;
      readonly deletionMarkerId: string;
      readonly requestedAt: string;
    }>
  >;
  readonly purgeDeletion: (input: {
    readonly completedAt: string;
    readonly deletionMarkerId: string;
  }) => Promise<boolean>;
  readonly purgeExpiredDeletionRecords: (limit: number) => Promise<number>;
  readonly create: (
    input: CreatePersonalAccountInput,
  ) => Promise<CreatedPersonalAccount | WaitlistedPersonalAccount | null>;
  readonly resolve: (
    clerkUserId: string,
  ) => Promise<ResolvedPersonalAccount | null>;
  readonly finishDeletion: (input: {
    readonly clerkUserId: string;
    readonly deletionMarkerId: string;
    readonly requestedAt: string;
  }) => Promise<boolean>;
  readonly prepareDeletion: (input: {
    readonly clerkUserId: string;
    readonly observedAt: string;
  }) => Promise<{
    readonly connectionPublicIds: ReadonlyArray<string>;
    readonly personalAccountId: string;
    readonly requestedAt: string;
    readonly state: "active" | "deleting";
  } | null>;
}

const withTransaction = async <Value>(
  connection: PersonalAccountConnection,
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

const enterPersonalAccountContext = async (
  connection: PersonalAccountConnection,
  personalAccountId: string,
): Promise<boolean> => {
  await connection.query(
    "SELECT set_config('app.personal_account_id', $1, true)",
    [personalAccountId],
  );
  const visible = await connection.query<{ id: string }>(
    `SELECT id
     FROM app.personal_accounts
     WHERE id = $1
       AND state = 'active'`,
    [personalAccountId],
  );
  return visible.rows.length === 1;
};

const quotaValue = (value: unknown): number => {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^[0-9]+$/.test(value)
        ? Number(value)
        : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error("invalid Personal Account quota");
  }
  return parsed;
};

interface AdmissionRow extends Record<string, unknown> {
  readonly admission_state: unknown;
  readonly created?: unknown;
  readonly key_available?: unknown;
  readonly message_retention_days: unknown;
  readonly personal_account_id: unknown;
  readonly stored_media_limit_bytes: unknown;
  readonly whatsapp_connection_limit: unknown;
}

const admissionState = (
  row: AdmissionRow | undefined,
): "active" | "waitlisted" | null => {
  if (row?.admission_state === "active") return "active";
  if (row?.admission_state === "waitlisted") return "waitlisted";
  return null;
};

export const makePersonalAccountRepository = (
  provider: PersonalAccountConnectionProvider,
): PersonalAccountRepository => ({
  listDeletionPurgeCandidates: (input) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{
        deadline_at: unknown;
        deadline_risk: unknown;
        deletion_marker_id: unknown;
        requested_at: unknown;
      }>(
        "SELECT * FROM app_private.list_personal_account_purge_candidates($1,$2)",
        [input.observedAt, input.limit],
      );
      return result.rows.map((row) => {
        if (
          typeof row.deletion_marker_id !== "string" ||
          !(row.requested_at instanceof Date) ||
          !(row.deadline_at instanceof Date) ||
          typeof row.deadline_risk !== "boolean"
        )
          throw new Error("invalid Personal Account purge candidate");
        return {
          deadlineAt: row.deadline_at.toISOString(),
          deadlineRisk: row.deadline_risk,
          deletionMarkerId: row.deletion_marker_id,
          requestedAt: row.requested_at.toISOString(),
        };
      });
    }),
  purgeDeletion: (input) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{ purged: unknown }>(
        "SELECT app_private.purge_personal_account($1,$2) AS purged",
        [input.deletionMarkerId, input.completedAt],
      );
      return result.rows[0]?.purged === true;
    }),
  purgeExpiredDeletionRecords: (limit) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{ purged: unknown }>(
        "SELECT app_private.purge_expired_deletion_records($1) AS purged",
        [limit],
      );
      const purged = Number(result.rows[0]?.purged);
      if (!Number.isSafeInteger(purged) || purged < 0)
        throw new Error("invalid deletion record purge result");
      return purged;
    }),
  finishDeletion: (input) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{ finished: unknown }>(
        "SELECT app_private.finish_personal_account_deletion($1, $2, $3) AS finished",
        [input.clerkUserId, input.deletionMarkerId, input.requestedAt],
      );
      return result.rows[0]?.finished === true;
    }),
  prepareDeletion: (input) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{
        account_state: unknown;
        connection_public_id: unknown;
        personal_account_id: unknown;
        requested_at: unknown;
      }>(
        "SELECT * FROM app_private.prepare_personal_account_deletion($1, $2)",
        [input.clerkUserId, input.observedAt],
      );
      const first = result.rows[0];
      if (
        first === undefined ||
        typeof first.personal_account_id !== "string" ||
        !(first.requested_at instanceof Date) ||
        (first.account_state !== "active" && first.account_state !== "deleting")
      )
        return null;
      return {
        connectionPublicIds: result.rows.flatMap((row) =>
          typeof row.connection_public_id === "string"
            ? [row.connection_public_id]
            : [],
        ),
        personalAccountId: first.personal_account_id,
        requestedAt: first.requested_at.toISOString(),
        state: first.account_state,
      };
    }),
  create: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const result = await connection.query<AdmissionRow>(
          `SELECT *
           FROM app_private.admit_personal_account_for_clerk(
             $1, $2, $3, $4, $5, $6
           )`,
          [
            input.clerkUserId,
            input.personalAccountId,
            input.keyVersion,
            input.kmsKeyId,
            input.keyCiphertext,
            input.providerApprovedSessionCapacity,
          ],
        );
        const row = result.rows[0];
        if (admissionState(row) === "waitlisted") {
          return { admissionState: "waitlisted" as const };
        }
        if (
          admissionState(row) !== "active" ||
          typeof row?.personal_account_id !== "string" ||
          typeof row.created !== "boolean" ||
          !(await enterPersonalAccountContext(
            connection,
            row.personal_account_id,
          ))
        ) {
          return null;
        }
        return {
          admissionState: "active" as const,
          created: row.created,
          messageRetentionDays: quotaValue(row.message_retention_days),
          personalAccountId: row.personal_account_id,
          storedMediaLimitBytes: quotaValue(row.stored_media_limit_bytes),
          whatsappConnectionLimit: quotaValue(row.whatsapp_connection_limit),
        };
      }),
    ),
  resolve: (clerkUserId) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const result = await connection.query<AdmissionRow>(
          "SELECT * FROM app_private.resolve_personal_account_for_clerk($1)",
          [clerkUserId],
        );
        const row = result.rows[0];
        if (admissionState(row) === "waitlisted") {
          return { admissionState: "waitlisted" as const };
        }
        if (
          admissionState(row) !== "active" ||
          typeof row?.personal_account_id !== "string" ||
          typeof row.key_available !== "boolean" ||
          !(await enterPersonalAccountContext(
            connection,
            row.personal_account_id,
          ))
        ) {
          return null;
        }
        return {
          admissionState: "active" as const,
          keyAvailable: row.key_available,
          messageRetentionDays: quotaValue(row.message_retention_days),
          personalAccountId: row.personal_account_id,
          storedMediaLimitBytes: quotaValue(row.stored_media_limit_bytes),
          whatsappConnectionLimit: quotaValue(row.whatsapp_connection_limit),
        };
      }),
    ),
});

const makePgConnectionProvider = (
  connectionString: string,
): PersonalAccountConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: PersonalAccountConnection) => Promise<Value>,
  ): Promise<Value> => {
    const { Client } = await import("pg");
    const client: PgClient = new Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
    });
    await client.connect();
    try {
      return await use(makeQueryConnection(client));
    } finally {
      await client.end();
    }
  },
});

export const makePgPersonalAccountRepository = (
  connectionString: string,
): PersonalAccountRepository =>
  makePersonalAccountRepository(makePgConnectionProvider(connectionString));
