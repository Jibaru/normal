import type { Client as PgClient } from "pg";

export interface ConnectionSetupConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface ConnectionSetupConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: ConnectionSetupConnection) => Promise<Value>,
  ) => Promise<Value>;
}

export interface ConnectionSetupRecord {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly setupId: string;
  readonly state: "provisioning_pending";
}

export type PreparedConnectionSetup =
  | {
      readonly accountKey: {
        readonly ciphertext: string;
        readonly keyVersion: number;
        readonly kmsKeyId: string;
        readonly personalAccountId: string;
        readonly version: 1;
      };
      readonly outcome: "unbound";
      readonly whatsappConnectionLimit: number;
    }
  | {
      readonly outcome: "replay";
      readonly setup: ConnectionSetupRecord;
    }
  | { readonly outcome: "idempotency_conflict" };

export interface PrepareConnectionSetupInput {
  readonly clerkUserId: string;
  readonly idempotencyKey: string;
  readonly numberToken: Uint8Array;
}

export interface StartConnectionSetupInput {
  readonly accountKeyVersion: number;
  readonly connectionKeyCiphertext: Uint8Array;
  readonly connectionKeyNonce: Uint8Array;
  readonly connectionKeyVersion: number;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly numberCiphertext: Uint8Array;
  readonly numberCiphertextNonce: Uint8Array;
  readonly numberCiphertextVersion: number;
  readonly numberKeyVersion: number;
  readonly numberToken: Uint8Array;
  readonly personalAccountId: string;
  readonly setupId: string;
}

export type StartedConnectionSetup =
  | {
      readonly outcome: "created" | "replay";
      readonly setup: ConnectionSetupRecord;
    }
  | {
      readonly outcome:
        | "connection_limit_reached"
        | "idempotency_conflict"
        | "number_unavailable";
    };

export interface ConnectionSetupRepository {
  readonly prepare: (
    input: PrepareConnectionSetupInput,
  ) => Promise<PreparedConnectionSetup | null>;
  readonly start: (
    input: StartConnectionSetupInput,
  ) => Promise<StartedConnectionSetup>;
}

const withTransaction = async <Value>(
  connection: ConnectionSetupConnection,
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
  connection: ConnectionSetupConnection,
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

const encodeBase64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((value, index) => value === right[index]);

const timestamp = (value: unknown): string | null => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return date !== null && Number.isFinite(date.valueOf())
    ? date.toISOString()
    : null;
};

interface SetupRow extends Record<string, unknown> {
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly id: unknown;
  readonly number_token?: unknown;
  readonly setup_created_at?: unknown;
  readonly setup_expires_at?: unknown;
  readonly setup_id?: unknown;
  readonly setup_state?: unknown;
  readonly state: unknown;
}

const setupRecord = (
  row: SetupRow | undefined,
  prefix = "",
): ConnectionSetupRecord | null => {
  const setupId = row?.[`${prefix}id`];
  const state = row?.[`${prefix}state`];
  const createdAt = timestamp(row?.[`${prefix}created_at`]);
  const expiresAt = timestamp(row?.[`${prefix}expires_at`]);
  if (
    typeof setupId !== "string" ||
    state !== "provisioning_pending" ||
    createdAt === null ||
    expiresAt === null
  ) {
    return null;
  }
  return { createdAt, expiresAt, setupId, state };
};

interface AccountRow extends Record<string, unknown> {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly kms_key_id: unknown;
  readonly personal_account_id: unknown;
  readonly whatsapp_connection_limit: unknown;
}

interface StartRow extends SetupRow {
  readonly outcome: unknown;
}

export const makeConnectionSetupRepository = (
  provider: ConnectionSetupConnectionProvider,
): ConnectionSetupRepository => ({
  prepare: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const loaded = await connection.query<AccountRow>(
          "SELECT * FROM app_private.load_connection_setup_account($1)",
          [input.clerkUserId],
        );
        const row = loaded.rows[0];
        const accountKeyCiphertext = bytes(row?.account_key_ciphertext);
        const accountKeyVersion = positiveInteger(row?.account_key_version);
        const whatsappConnectionLimit = positiveInteger(
          row?.whatsapp_connection_limit,
        );
        if (
          typeof row?.personal_account_id !== "string" ||
          typeof row.kms_key_id !== "string" ||
          accountKeyCiphertext === null ||
          accountKeyVersion === null ||
          whatsappConnectionLimit === null ||
          !(await enterPersonalAccountContext(
            connection,
            row.personal_account_id,
          ))
        ) {
          return null;
        }

        const binding = await connection.query<SetupRow>(
          `SELECT setups.*, reservations.number_token
           FROM app.connection_setups AS setups
           JOIN app.whatsapp_number_reservations AS reservations
             ON reservations.personal_account_id = setups.personal_account_id
            AND reservations.connection_setup_id = setups.id
           WHERE setups.personal_account_id = $1
             AND setups.idempotency_key = $2`,
          [row.personal_account_id, input.idempotencyKey],
        );
        const existing = binding.rows[0];
        if (existing !== undefined) {
          const existingToken = bytes(existing.number_token);
          const setup = setupRecord(existing);
          if (existingToken === null || setup === null) {
            throw new Error("invalid persisted Connection Setup");
          }
          return sameBytes(existingToken, input.numberToken)
            ? { outcome: "replay" as const, setup }
            : { outcome: "idempotency_conflict" as const };
        }

        return {
          accountKey: {
            ciphertext: encodeBase64(accountKeyCiphertext),
            keyVersion: accountKeyVersion,
            kmsKeyId: row.kms_key_id,
            personalAccountId: row.personal_account_id,
            version: 1 as const,
          },
          outcome: "unbound" as const,
          whatsappConnectionLimit,
        };
      }),
    ),
  start: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          !(await enterPersonalAccountContext(
            connection,
            input.personalAccountId,
          ))
        ) {
          throw new Error("Personal Account unavailable");
        }
        const result = await connection.query<StartRow>(
          `SELECT *
           FROM app_private.start_connection_setup(
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13
           )`,
          [
            input.personalAccountId,
            input.setupId,
            input.idempotencyKey,
            input.numberToken,
            input.numberCiphertextVersion,
            input.numberKeyVersion,
            input.numberCiphertextNonce,
            input.numberCiphertext,
            input.accountKeyVersion,
            input.connectionKeyVersion,
            input.connectionKeyNonce,
            input.connectionKeyCiphertext,
            input.createdAt,
          ],
        );
        const row = result.rows[0];
        if (
          row?.outcome === "connection_limit_reached" ||
          row?.outcome === "idempotency_conflict" ||
          row?.outcome === "number_unavailable"
        ) {
          return { outcome: row.outcome };
        }
        if (row?.outcome === "created" || row?.outcome === "replay") {
          const setup = setupRecord(row, "setup_");
          if (setup !== null) {
            return { outcome: row.outcome, setup };
          }
        }
        throw new Error("invalid Connection Setup result");
      }),
    ),
});

const makePgConnectionProvider = (
  connectionString: string,
): ConnectionSetupConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: ConnectionSetupConnection) => Promise<Value>,
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

export const makePgConnectionSetupRepository = (
  connectionString: string,
): ConnectionSetupRepository =>
  makeConnectionSetupRepository(makePgConnectionProvider(connectionString));
