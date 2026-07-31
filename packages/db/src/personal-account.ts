import type { Client as PgClient } from "pg";

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
  readonly create: (
    input: CreatePersonalAccountInput,
  ) => Promise<CreatedPersonalAccount | WaitlistedPersonalAccount | null>;
  readonly resolve: (
    clerkUserId: string,
  ) => Promise<ResolvedPersonalAccount | null>;
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

export const makePgPersonalAccountRepository = (
  connectionString: string,
): PersonalAccountRepository =>
  makePersonalAccountRepository(makePgConnectionProvider(connectionString));
