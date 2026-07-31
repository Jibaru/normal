import type { Client as PgClient } from "pg";
import type {
  PersonalAccountConnection,
  PersonalAccountConnectionProvider,
} from "./personal-account";

export const MCP_AUTHORIZATION_SCOPES = [
  "connections:read",
  "directory:read",
  "messages:read",
  "messages:send",
] as const;

export type McpAuthorizationScope = (typeof MCP_AUTHORIZATION_SCOPES)[number];

export interface SelectableWhatsAppConnection {
  readonly connectionId: string;
}

export interface CreateMcpAuthorizationInput {
  readonly authorizationId: string;
  readonly authorizedAt: Date;
  readonly clientClass: string;
  readonly clientId: string;
  readonly clerkUserId: string;
  readonly connectionIds: ReadonlyArray<string>;
  readonly expiresAt: Date;
  readonly oauthSubject: string;
  readonly reverifiedAt: Date;
  readonly scopes: ReadonlyArray<McpAuthorizationScope>;
}

export interface McpAuthorizationRepository {
  readonly create: (input: CreateMcpAuthorizationInput) => Promise<boolean>;
  readonly isActive: (input: {
    readonly authorizationId: string;
    readonly clientId: string;
    readonly observedAt: Date;
    readonly oauthSubject: string;
  }) => Promise<boolean>;
  readonly listConnections: (
    clerkUserId: string,
  ) => Promise<ReadonlyArray<SelectableWhatsAppConnection> | null>;
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

const enterClerkContext = async (
  connection: PersonalAccountConnection,
  clerkUserId: string,
): Promise<string | null> => {
  const result = await connection.query<{ personal_account_id: string | null }>(
    `SELECT app_private.bootstrap_personal_account_for_clerk($1)
       AS personal_account_id`,
    [clerkUserId],
  );
  const personalAccountId = result.rows[0]?.personal_account_id;
  if (typeof personalAccountId !== "string") return null;
  await connection.query(
    "SELECT set_config('app.personal_account_id', $1, true)",
    [personalAccountId],
  );
  const account = await connection.query(
    `SELECT id FROM app.personal_accounts
     WHERE id = $1 AND state = 'active'`,
    [personalAccountId],
  );
  return account.rows.length === 1 ? personalAccountId : null;
};

export const makeMcpAuthorizationRepository = (
  provider: PersonalAccountConnectionProvider,
): McpAuthorizationRepository => ({
  create: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const personalAccountId = await enterClerkContext(
          connection,
          input.clerkUserId,
        );
        if (personalAccountId === null) return false;
        if (
          input.connectionIds.length === 0 ||
          new Set(input.connectionIds).size !== input.connectionIds.length ||
          input.scopes.length === 0 ||
          new Set(input.scopes).size !== input.scopes.length
        ) {
          return false;
        }
        const selected = await connection.query<{
          id: string;
          public_id: string;
        }>(
          `SELECT id, public_id
           FROM app.whatsapp_connections
           WHERE public_id = ANY($1::text[])
           ORDER BY public_id`,
          [[...input.connectionIds]],
        );
        if (selected.rows.length !== input.connectionIds.length) return false;

        await connection.query(
          `INSERT INTO app.mcp_authorizations (
             id, personal_account_id, oauth_subject, client_id, client_class,
             scopes, reverified_at, authorized_at, absolute_expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9)`,
          [
            input.authorizationId,
            personalAccountId,
            input.oauthSubject,
            input.clientId,
            input.clientClass,
            [...input.scopes],
            input.reverifiedAt,
            input.authorizedAt,
            input.expiresAt,
          ],
        );
        for (const row of selected.rows) {
          await connection.query(
            `INSERT INTO app.mcp_authorization_connections (
               personal_account_id, mcp_authorization_id,
               whatsapp_connection_id
             ) VALUES ($1, $2, $3)`,
            [personalAccountId, input.authorizationId, row.id],
          );
        }
        return true;
      }),
    ),
  isActive: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const context = await connection.query<{
          personal_account_id: string | null;
        }>(
          `SELECT app_private.bootstrap_mcp_authorization($1, $2, $3, $4)
             AS personal_account_id`,
          [
            input.authorizationId,
            input.oauthSubject,
            input.clientId,
            input.observedAt,
          ],
        );
        const personalAccountId = context.rows[0]?.personal_account_id;
        if (typeof personalAccountId !== "string") return false;
        await connection.query(
          "SELECT set_config('app.personal_account_id', $1, true)",
          [personalAccountId],
        );
        const authorization = await connection.query(
          `SELECT id
           FROM app.mcp_authorizations
           WHERE id = $1
             AND oauth_subject = $2
             AND client_id = $3
             AND state = 'active'
             AND absolute_expires_at > $4`,
          [
            input.authorizationId,
            input.oauthSubject,
            input.clientId,
            input.observedAt,
          ],
        );
        return authorization.rows.length === 1;
      }),
    ),
  listConnections: (clerkUserId) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if ((await enterClerkContext(connection, clerkUserId)) === null) {
          return null;
        }
        const result = await connection.query<{ public_id: string }>(
          `SELECT public_id
           FROM app.whatsapp_connections
           ORDER BY created_at, public_id`,
        );
        return result.rows.map((row) => ({ connectionId: row.public_id }));
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

export const makePgMcpAuthorizationRepository = (
  connectionString: string,
): McpAuthorizationRepository =>
  makeMcpAuthorizationRepository(makePgConnectionProvider(connectionString));
