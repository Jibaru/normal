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
  readonly registerRefreshCredential: (
    input: RefreshCredentialInput,
  ) => Promise<boolean>;
  readonly rotateRefreshCredential: <Value>(
    input: RefreshCredentialInput,
    issue: () => Promise<{
      readonly credentialHash: Uint8Array;
      readonly value: Value;
    }>,
  ) => Promise<RefreshCredentialRotationResult<Value>>;
}

export interface RefreshCredentialInput {
  readonly clientId: string;
  readonly credentialHash: Uint8Array;
  readonly oauthSubject: string;
  readonly observedAt: Date;
}

export type RefreshCredentialRotationResult<Value> =
  | { readonly outcome: "invalid" | "reuse" }
  | { readonly outcome: "rotated"; readonly value: Value };

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
  registerRefreshCredential: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (input.credentialHash.byteLength !== 32) return false;
        const context = await connection.query<{
          mcp_authorization_id: string;
          personal_account_id: string;
        }>(
          `SELECT personal_account_id, mcp_authorization_id
           FROM app_private.bootstrap_mcp_refresh_authorization($1, $2, $3)`,
          [input.oauthSubject, input.clientId, input.observedAt],
        );
        const authorization = context.rows[0];
        if (authorization === undefined) return false;
        await connection.query(
          "SELECT set_config('app.personal_account_id', $1, true)",
          [authorization.personal_account_id],
        );
        const inserted = await connection.query<{
          credential_hash: Uint8Array;
        }>(
          `INSERT INTO app.mcp_refresh_credentials (
             credential_hash, personal_account_id, mcp_authorization_id,
             issued_at, inactive_expires_at
           )
           SELECT
             $1, authorizations.personal_account_id, authorizations.id, $2,
             LEAST($2::timestamptz + interval '30 days',
                   authorizations.absolute_expires_at)
           FROM app.mcp_authorizations AS authorizations
           WHERE authorizations.id = $3
             AND NOT EXISTS (
               SELECT 1
               FROM app.mcp_refresh_credentials AS credentials
               WHERE credentials.mcp_authorization_id = authorizations.id
             )
           RETURNING credential_hash`,
          [
            input.credentialHash,
            input.observedAt,
            authorization.mcp_authorization_id,
          ],
        );
        return inserted.rows.length === 1;
      }),
    ),
  rotateRefreshCredential: (input, issue) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (input.credentialHash.byteLength !== 32) {
          return { outcome: "invalid" as const };
        }
        const context = await connection.query<{
          mcp_authorization_id: string;
          personal_account_id: string;
        }>(
          `SELECT personal_account_id, mcp_authorization_id
           FROM app_private.bootstrap_mcp_refresh_credential($1, $2, $3)`,
          [input.credentialHash, input.oauthSubject, input.clientId],
        );
        const authorization = context.rows[0];
        if (authorization === undefined) {
          return { outcome: "invalid" as const };
        }
        await connection.query(
          "SELECT set_config('app.personal_account_id', $1, true)",
          [authorization.personal_account_id],
        );
        const locked = await connection.query<{
          consumed_at: Date | null;
          inactive_expires_at: Date;
          refresh_family_state: "active" | "revoked";
        }>(
          `SELECT
             credentials.consumed_at,
             credentials.inactive_expires_at,
             authorizations.refresh_family_state
           FROM app.mcp_refresh_credentials AS credentials
           JOIN app.mcp_authorizations AS authorizations
             ON authorizations.personal_account_id =
               credentials.personal_account_id
             AND authorizations.id = credentials.mcp_authorization_id
           WHERE credentials.credential_hash = $1
             AND credentials.mcp_authorization_id = $2
           FOR UPDATE OF credentials, authorizations`,
          [input.credentialHash, authorization.mcp_authorization_id],
        );
        const credential = locked.rows[0];
        if (credential === undefined) {
          return { outcome: "invalid" as const };
        }
        if (credential.consumed_at !== null) {
          await connection.query(
            `UPDATE app.mcp_authorizations
             SET
               refresh_family_state = 'revoked',
               refresh_family_revoked_at =
                 COALESCE(refresh_family_revoked_at, $2)
             WHERE id = $1`,
            [authorization.mcp_authorization_id, input.observedAt],
          );
          return { outcome: "reuse" as const };
        }
        const current = await connection.query<{
          personal_account_id: string | null;
        }>(
          `SELECT app_private.bootstrap_mcp_authorization($1, $2, $3, $4)
             AS personal_account_id`,
          [
            authorization.mcp_authorization_id,
            input.oauthSubject,
            input.clientId,
            input.observedAt,
          ],
        );
        if (
          credential.refresh_family_state !== "active" ||
          credential.inactive_expires_at <= input.observedAt ||
          current.rows[0]?.personal_account_id !==
            authorization.personal_account_id
        ) {
          return { outcome: "invalid" as const };
        }

        const issued = await issue();
        if (issued.credentialHash.byteLength !== 32) {
          throw new Error("invalid rotated refresh credential hash");
        }
        await connection.query(
          `UPDATE app.mcp_refresh_credentials
           SET consumed_at = $2
           WHERE credential_hash = $1`,
          [input.credentialHash, input.observedAt],
        );
        await connection.query(
          `INSERT INTO app.mcp_refresh_credentials (
             credential_hash, personal_account_id, mcp_authorization_id,
             issued_at, inactive_expires_at
           )
           SELECT
             $1, authorizations.personal_account_id, authorizations.id, $2,
             LEAST($2::timestamptz + interval '30 days',
                   authorizations.absolute_expires_at)
           FROM app.mcp_authorizations AS authorizations
           WHERE authorizations.id = $3`,
          [
            issued.credentialHash,
            input.observedAt,
            authorization.mcp_authorization_id,
          ],
        );
        return { outcome: "rotated" as const, value: issued.value };
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
