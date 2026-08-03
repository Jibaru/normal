import type { Client as PgClient } from "pg";
import type {
  PersonalAccountConnection,
  PersonalAccountConnectionProvider,
} from "./personal-account";

export interface ToolCallLogSummary {
  readonly authorizationId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly completedAt: Date | null;
  readonly connectionId: string | null;
  readonly errorCode: string | null;
  readonly latencyMs: number | null;
  readonly mediaBytes: number;
  readonly outcome:
    | "started"
    | "success"
    | "execution_error"
    | "rate_limited"
    | "authorization_denied";
  readonly resultCount: number | null;
  readonly sendId: string | null;
  readonly startedAt: Date;
  readonly toolName: string;
}

export interface ToolCallLogRepository {
  readonly listForUser: (
    clerkUserId: string,
    observedAt: Date,
  ) => Promise<ReadonlyArray<ToolCallLogSummary> | null>;
  readonly purgeExpired: (observedAt: Date, limit: number) => Promise<number>;
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

export const makeToolCallLogRepository = (
  provider: PersonalAccountConnectionProvider,
): ToolCallLogRepository => ({
  listForUser: (clerkUserId, observedAt) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const context = await connection.query<{
          personal_account_id: string | null;
        }>(
          `SELECT app_private.bootstrap_personal_account_for_clerk($1)
             AS personal_account_id`,
          [clerkUserId],
        );
        const personalAccountId = context.rows[0]?.personal_account_id;
        if (typeof personalAccountId !== "string") return null;
        await connection.query(
          "SELECT set_config('app.personal_account_id', $1, true)",
          [personalAccountId],
        );
        const account = await connection.query(
          "SELECT id FROM app.personal_accounts WHERE id=$1 AND state='active'",
          [personalAccountId],
        );
        if (account.rows.length !== 1) return null;

        const result = await connection.query<{
          authorization_public_id: string;
          client_id: string;
          client_name: string | null;
          completed_at: Date | null;
          connection_public_id: string | null;
          error_code: string | null;
          latency_ms: number | null;
          media_bytes_reserved: number;
          outcome: ToolCallLogSummary["outcome"];
          result_count: number | null;
          send_public_id: string | null;
          started_at: Date;
          tool_name: string;
        }>(
          `SELECT
             authorizations.public_id AS authorization_public_id,
             authorizations.client_id,
             authorizations.client_name,
             logs.started_at,
             logs.completed_at,
             logs.tool_name,
             logs.outcome,
             logs.error_code,
             logs.result_count,
             logs.latency_ms,
             logs.media_bytes_reserved,
             connections.public_id AS connection_public_id,
             sends.public_id AS send_public_id
           FROM app.tool_call_logs AS logs
           JOIN app.mcp_authorizations AS authorizations
             ON authorizations.personal_account_id=logs.personal_account_id
            AND authorizations.id=logs.mcp_authorization_id
           LEFT JOIN app.send_operations AS sends
             ON sends.personal_account_id=logs.personal_account_id
            AND sends.tool_call_log_id=logs.id
           LEFT JOIN app.whatsapp_connections AS connections
             ON connections.personal_account_id=sends.personal_account_id
            AND connections.id=sends.whatsapp_connection_id
           WHERE logs.expires_at > $1
           ORDER BY logs.started_at DESC, logs.id DESC`,
          [observedAt],
        );
        return result.rows.map((row) => ({
          authorizationId: row.authorization_public_id,
          clientId: row.client_id,
          clientName: row.client_name ?? row.client_id,
          completedAt: row.completed_at,
          connectionId: row.connection_public_id,
          errorCode: row.error_code,
          latencyMs: row.latency_ms,
          mediaBytes: Number(row.media_bytes_reserved),
          outcome: row.outcome,
          resultCount: row.result_count,
          sendId: row.send_public_id,
          startedAt: row.started_at,
          toolName: row.tool_name,
        }));
      }),
    ),
  purgeExpired: (observedAt, limit) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{ purged: number }>(
        `SELECT app_private.purge_expired_tool_call_logs($1, $2) AS purged`,
        [observedAt, limit],
      );
      return Number(result.rows[0]?.purged ?? 0);
    }),
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
      return await use(client);
    } finally {
      await client.end();
    }
  },
});

export const makePgToolCallLogRepository = (
  connectionString: string,
): ToolCallLogRepository =>
  makeToolCallLogRepository(makePgConnectionProvider(connectionString));
