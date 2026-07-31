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

export interface ResolvedPersonalAccount {
  readonly keyAvailable: boolean;
  readonly personalAccountId: string;
  readonly storedMediaLimitBytes: number;
  readonly whatsappConnectionLimit: number;
}

export interface CreatePersonalAccountInput {
  readonly clerkUserId: string;
  readonly keyCiphertext: Uint8Array;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
}

export interface CreatedPersonalAccount {
  readonly created: boolean;
  readonly personalAccountId: string;
  readonly storedMediaLimitBytes: number;
  readonly whatsappConnectionLimit: number;
}

export interface PersonalAccountRepository {
  readonly create: (
    input: CreatePersonalAccountInput,
  ) => Promise<CreatedPersonalAccount | null>;
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

export const makePersonalAccountRepository = (
  provider: PersonalAccountConnectionProvider,
): PersonalAccountRepository => ({
  create: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const result = await connection.query<{
          created: boolean;
          personal_account_id: string;
          stored_media_limit_bytes: bigint | number | string;
          whatsapp_connection_limit: number;
        }>(
          `SELECT *
           FROM app_private.create_personal_account_for_clerk(
             $1, $2, $3, $4, $5
           )`,
          [
            input.clerkUserId,
            input.personalAccountId,
            input.keyVersion,
            input.kmsKeyId,
            input.keyCiphertext,
          ],
        );
        const row = result.rows[0];
        if (
          !row ||
          !(await enterPersonalAccountContext(
            connection,
            row.personal_account_id,
          ))
        ) {
          return null;
        }
        return {
          created: row.created,
          personalAccountId: row.personal_account_id,
          storedMediaLimitBytes: quotaValue(row.stored_media_limit_bytes),
          whatsappConnectionLimit: quotaValue(row.whatsapp_connection_limit),
        };
      }),
    ),
  resolve: (clerkUserId) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const result = await connection.query<{
          key_available: boolean;
          personal_account_id: string;
          stored_media_limit_bytes: bigint | number | string;
          whatsapp_connection_limit: number;
        }>("SELECT * FROM app_private.resolve_personal_account_for_clerk($1)", [
          clerkUserId,
        ]);
        const row = result.rows[0];
        if (
          !row ||
          !(await enterPersonalAccountContext(
            connection,
            row.personal_account_id,
          ))
        ) {
          return null;
        }
        return {
          keyAvailable: row.key_available,
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
