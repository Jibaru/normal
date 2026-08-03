import type { Client as PgClient } from "pg";
import { makeQueryConnection } from "./database";
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

export interface ToolCallLogPage {
  readonly logs: ReadonlyArray<ToolCallLogSummary>;
  readonly nextCursor: string | null;
}

export interface ToolCallLogRepository {
  readonly listForUser: (
    clerkUserId: string,
    observedAt: Date,
    cursor: string | null,
    limit: number,
  ) => Promise<ToolCallLogPage | null>;
  readonly purgeExpired: (limit: number) => Promise<number>;
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
  listForUser: (clerkUserId, observedAt, cursor, limit) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new Error("invalid Tool Call Log page limit");
        }
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
          public_id: string;
          result_count: number | null;
          send_public_id: string | null;
          started_at: Date;
          tool_name: string;
        }>(
          `WITH boundary AS (
             SELECT logs.started_at, logs.public_id
             FROM app.tool_call_logs AS logs
             WHERE logs.personal_account_id = $4
               AND logs.public_id = $2
           )
           SELECT
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
             COALESCE(logs.connection_public_id, connections.public_id)
               AS connection_public_id,
             COALESCE(logs.send_public_id, sends.public_id) AS send_public_id,
             logs.public_id
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
           WHERE logs.personal_account_id = $4
             AND logs.expires_at > $1
             AND (
               $2::text IS NULL
               OR (logs.started_at, logs.public_id) < (
                 SELECT boundary.started_at, boundary.public_id
                 FROM boundary
               )
             )
           ORDER BY logs.started_at DESC, logs.public_id DESC
           LIMIT $3`,
          [observedAt, cursor, limit + 1, personalAccountId],
        );
        const pageRows = result.rows.slice(0, limit);
        const logs = pageRows.map((row) => ({
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
        return {
          logs,
          nextCursor:
            result.rows.length > limit
              ? (pageRows.at(-1)?.public_id ?? null)
              : null,
        };
      }),
    ),
  purgeExpired: (limit) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{ purged: number }>(
        `SELECT app_private.purge_expired_tool_call_logs($1) AS purged`,
        [limit],
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
      return await use(makeQueryConnection(client));
    } finally {
      await client.end();
    }
  },
});

export const makePgToolCallLogRepository = (
  connectionString: string,
): ToolCallLogRepository =>
  makeToolCallLogRepository(makePgConnectionProvider(connectionString));
