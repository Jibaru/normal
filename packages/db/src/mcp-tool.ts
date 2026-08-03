import type { Client as PgClient } from "pg";
import type { McpAuthorizationScope } from "./mcp-authorization";

export interface McpToolConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface McpToolConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: McpToolConnection) => Promise<Value>,
  ) => Promise<Value>;
}

export interface McpAccessAuthorization {
  readonly authorizationId: string;
  readonly clientId?: string | undefined;
  readonly oauthSubject: string;
}

export interface McpToolConnectionRecord {
  readonly displayName: string | null;
  readonly numberLastFour: string | null;
  readonly publicId: string;
  readonly state:
    | "connected"
    | "connecting"
    | "disconnected"
    | "reconnect_required"
    | "degraded";
  readonly stateChangedAt: string;
}

export type McpToolName = "list_connections" | "list_groups";

export interface McpToolGroupRecord {
  readonly displayName: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly version: 1;
  } | null;
  readonly id: string;
  readonly publicId: string;
}

export interface McpToolGroupPage {
  readonly accountKey: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly kmsKeyId: string;
    readonly personalAccountId: string;
    readonly version: 1;
  };
  readonly asOf: string;
  readonly connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: string;
    readonly connectionId: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly personalAccountId: string;
    readonly version: 1;
  };
  readonly groups: ReadonlyArray<McpToolGroupRecord>;
  readonly partial: boolean;
  readonly stale: boolean;
}

export interface McpToolGroupSearchMaterial {
  readonly accountKey: McpToolGroupPage["accountKey"];
  readonly connectionKey: McpToolGroupPage["connectionKey"];
  readonly identityKey: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly version: 1;
  };
}

export type BeginToolCallResult =
  | {
      readonly auditLogId: string;
      readonly outcome: "started" | "authorization_denied";
    }
  | {
      readonly auditLogId: string;
      readonly outcome: "rate_limited";
      readonly resetsAt: Date;
      readonly retryAfterSeconds: number;
    };

export interface McpToolRepository {
  readonly beginToolCall: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly hourLimit: number;
      readonly minuteLimit: number;
      readonly observedAt: Date;
      readonly toolName: McpToolName;
    },
  ) => Promise<BeginToolCallResult>;
  readonly completeToolCall: (input: {
    readonly auditLogId: string;
    readonly completedAt: Date;
    readonly errorCode: string | null;
    readonly outcome: "authorization_denied" | "execution_error" | "success";
    readonly resultCount: number | null;
  }) => Promise<void>;
  readonly inspectAuthorization: (
    input: McpAccessAuthorization & { readonly observedAt: Date },
  ) => Promise<{
    readonly scopes: ReadonlyArray<McpAuthorizationScope>;
  } | null>;
  readonly listConnections: (
    input: McpAccessAuthorization & { readonly observedAt: Date },
  ) => Promise<ReadonlyArray<McpToolConnectionRecord> | null>;
  readonly listGroups: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
      readonly searchIndex: string | null;
    },
  ) => Promise<McpToolGroupPage | null>;
  readonly loadGroupSearchMaterial: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
    },
  ) => Promise<McpToolGroupSearchMaterial | null>;
}

const withTransaction = async <Value>(
  connection: McpToolConnection,
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

const timestamp = (value: unknown): Date | null => {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return parsed !== null && Number.isFinite(parsed.valueOf()) ? parsed : null;
};

const timestampString = (value: unknown): string | null =>
  timestamp(value)?.toISOString() ?? null;

const bytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  return null;
};

const base64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

interface ParsedGroupKeyMaterial {
  readonly accountKey: McpToolGroupPage["accountKey"];
  readonly connectionKey: McpToolGroupPage["connectionKey"];
}

interface ParsedGroupMaterial extends ParsedGroupKeyMaterial {
  readonly asOf: string;
  readonly partial: boolean;
  readonly stale: boolean;
}

const parseGroupKeyMaterial = (
  row: Record<string, unknown> | undefined,
): ParsedGroupKeyMaterial | null => {
  if (row === undefined) return null;
  const personalAccountId = row.personal_account_id;
  const connectionId = row.connection_id;
  const accountVersion = positiveInteger(row.account_key_version);
  const accountCiphertext = bytes(row.account_key_ciphertext);
  const connectionAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const connectionVersion = positiveInteger(row.connection_key_version);
  const connectionNonce = bytes(row.connection_key_nonce);
  const connectionCiphertext = bytes(row.connection_key_ciphertext);
  if (
    typeof personalAccountId !== "string" ||
    typeof connectionId !== "string" ||
    typeof row.account_kms_key_id !== "string" ||
    accountVersion === null ||
    accountCiphertext === null ||
    connectionAccountVersion === null ||
    connectionVersion === null ||
    connectionNonce === null ||
    connectionCiphertext === null
  ) {
    throw new Error("invalid MCP group key material");
  }
  return {
    accountKey: {
      ciphertext: base64(accountCiphertext),
      keyVersion: accountVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId,
      version: 1,
    },
    connectionKey: {
      accountKeyVersion: connectionAccountVersion,
      ciphertext: base64(connectionCiphertext),
      connectionId,
      keyVersion: connectionVersion,
      nonce: base64(connectionNonce),
      personalAccountId,
      version: 1,
    },
  };
};

const parseGroupMaterial = (
  row: Record<string, unknown> | undefined,
): ParsedGroupMaterial | null => {
  const keyMaterial = parseGroupKeyMaterial(row);
  if (keyMaterial === null || row === undefined) return null;
  const asOf = timestampString(row.as_of ?? row.connection_created_at);
  if (
    asOf === null ||
    typeof row.stale !== "boolean" ||
    typeof row.partial !== "boolean"
  ) {
    throw new Error("invalid MCP group projection material");
  }
  return {
    ...keyMaterial,
    asOf,
    partial: row.partial,
    stale: row.stale,
  };
};

const parseGroupSearchMaterial = (
  row: Record<string, unknown> | undefined,
): McpToolGroupSearchMaterial | null => {
  const keyMaterial = parseGroupKeyMaterial(row);
  if (keyMaterial === null || row === undefined) return null;
  const identityVersion = positiveInteger(row.identity_ciphertext_version);
  const identityKeyVersion = positiveInteger(row.identity_key_version);
  const identityNonce = bytes(row.identity_nonce);
  const identityCiphertext = bytes(row.identity_ciphertext);
  if (
    identityVersion !== 1 ||
    identityKeyVersion === null ||
    identityNonce === null ||
    identityCiphertext === null
  ) {
    throw new Error("invalid MCP group search material");
  }
  return {
    ...keyMaterial,
    identityKey: {
      ciphertext: base64(identityCiphertext),
      keyVersion: identityKeyVersion,
      nonce: base64(identityNonce),
      version: 1,
    },
  };
};

const loadGroupProjectionMaterial = async (
  connection: McpToolConnection,
  input: McpAccessAuthorization & {
    readonly connectionPublicId: string;
    readonly observedAt: Date;
  },
): Promise<ParsedGroupMaterial | null> => {
  const material = await connection.query<Record<string, unknown>>(
    `SELECT *
     FROM app_private.load_mcp_group_projection_material(
       $1, $2, $3, $4, $5
     )`,
    [
      input.authorizationId,
      input.oauthSubject,
      input.clientId ?? null,
      input.observedAt,
      input.connectionPublicId,
    ],
  );
  return parseGroupMaterial(material.rows[0]);
};

const loadGroupIndexMaterial = async (
  connection: McpToolConnection,
  input: McpAccessAuthorization & {
    readonly connectionPublicId: string;
    readonly observedAt: Date;
  },
): Promise<McpToolGroupSearchMaterial | null> => {
  const material = await connection.query<Record<string, unknown>>(
    `SELECT *
     FROM app_private.load_mcp_group_search_material(
       $1, $2, $3, $4, $5
     )`,
    [
      input.authorizationId,
      input.oauthSubject,
      input.clientId ?? null,
      input.observedAt,
      input.connectionPublicId,
    ],
  );
  return parseGroupSearchMaterial(material.rows[0]);
};

const enterAuthorizationContext = async (
  connection: McpToolConnection,
  input: McpAccessAuthorization,
): Promise<string | null> => {
  const result = await connection.query<{
    personal_account_id: unknown;
  }>(
    `SELECT app_private.bootstrap_mcp_tool_call($1, $2, $3)
       AS personal_account_id`,
    [input.authorizationId, input.oauthSubject, input.clientId ?? null],
  );
  const personalAccountId = result.rows[0]?.personal_account_id;
  if (typeof personalAccountId !== "string") return null;
  await connection.query(
    "SELECT set_config('app.personal_account_id', $1, true)",
    [personalAccountId],
  );
  return personalAccountId;
};

const authorizationScopes = (
  value: unknown,
): ReadonlyArray<McpAuthorizationScope> | null => {
  if (!Array.isArray(value)) return null;
  const validScopes = new Set<McpAuthorizationScope>([
    "connections:read",
    "directory:read",
    "messages:read",
    "messages:send",
  ]);
  return value.every(
    (scope): scope is McpAuthorizationScope =>
      typeof scope === "string" &&
      validScopes.has(scope as McpAuthorizationScope),
  )
    ? value
    : null;
};

const loadAuthorizationScopes = async (
  connection: McpToolConnection,
  input: McpAccessAuthorization & { readonly observedAt: Date },
): Promise<ReadonlyArray<McpAuthorizationScope> | null> => {
  const active = await connection.query<{ personal_account_id: unknown }>(
    `SELECT app_private.bootstrap_active_mcp_tool_call($1, $2, $3, $4)
       AS personal_account_id`,
    [
      input.authorizationId,
      input.oauthSubject,
      input.clientId ?? null,
      input.observedAt,
    ],
  );
  if (typeof active.rows[0]?.personal_account_id !== "string") {
    return null;
  }
  const result = await connection.query<{ scopes: unknown }>(
    `SELECT scopes
     FROM app.mcp_authorizations
     WHERE id = $1
       AND oauth_subject = $2
       AND ($3::text IS NULL OR client_id = $3)`,
    [input.authorizationId, input.oauthSubject, input.clientId ?? null],
  );
  return authorizationScopes(result.rows[0]?.scopes);
};

const insertToolCallLog = (
  connection: McpToolConnection,
  input: {
    readonly auditLogId: string;
    readonly authorizationId: string;
    readonly completed: boolean;
    readonly errorCode: string | null;
    readonly observedAt: Date;
    readonly outcome: "started" | "rate_limited" | "authorization_denied";
    readonly personalAccountId: string;
    readonly quotaReserved: boolean;
    readonly toolName: string;
  },
) =>
  connection.query(
    `INSERT INTO app.tool_call_logs (
       id, personal_account_id, mcp_authorization_id, tool_name,
       started_at, completed_at, outcome, error_code, result_count,
       latency_ms, quota_reserved, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       CASE WHEN $6::boolean THEN $5::timestamptz ELSE NULL END,
       $7, $8, NULL,
       CASE WHEN $6::boolean THEN 0 ELSE NULL END,
       $9, $5::timestamptz + interval '90 days'
     )`,
    [
      input.auditLogId,
      input.personalAccountId,
      input.authorizationId,
      input.toolName,
      input.observedAt,
      input.completed,
      input.outcome,
      input.errorCode,
      input.quotaReserved,
    ],
  );

export const makeMcpToolRepository = (
  provider: McpToolConnectionProvider,
): McpToolRepository => ({
  inspectAuthorization: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if ((await enterAuthorizationContext(connection, input)) === null) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        return scopes === null ? null : { scopes };
      }),
    ),
  beginToolCall: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          !Number.isSafeInteger(input.minuteLimit) ||
          input.minuteLimit < 1 ||
          !Number.isSafeInteger(input.hourLimit) ||
          input.hourLimit < input.minuteLimit
        ) {
          throw new Error("invalid MCP request quota");
        }
        const personalAccountId = await enterAuthorizationContext(
          connection,
          input,
        );
        if (personalAccountId === null) {
          return {
            auditLogId: input.auditLogId,
            outcome: "authorization_denied" as const,
          };
        }

        await connection.query(
          `SELECT id
           FROM app.personal_accounts
           WHERE id = $1
           FOR UPDATE`,
          [personalAccountId],
        );
        const scopes = await loadAuthorizationScopes(connection, input);
        const requiredScope =
          input.toolName === "list_groups"
            ? "directory:read"
            : "connections:read";
        if (scopes === null || !scopes.includes(requiredScope)) {
          await insertToolCallLog(connection, {
            auditLogId: input.auditLogId,
            authorizationId: input.authorizationId,
            completed: true,
            errorCode: "authorization_denied",
            observedAt: input.observedAt,
            outcome: "authorization_denied",
            personalAccountId,
            quotaReserved: false,
            toolName: input.toolName,
          });
          return {
            auditLogId: input.auditLogId,
            outcome: "authorization_denied" as const,
          };
        }

        const recent = await connection.query<{ started_at: unknown }>(
          `SELECT started_at
           FROM app.tool_call_logs
           WHERE personal_account_id = $1
             AND quota_reserved
             AND started_at > $2::timestamptz - interval '1 hour'
             AND started_at <= $2
           ORDER BY started_at, id`,
          [personalAccountId, input.observedAt],
        );
        const hourStarts = recent.rows.map(({ started_at }) =>
          timestamp(started_at),
        );
        if (hourStarts.some((value) => value === null)) {
          throw new Error("invalid Tool Call Log timestamp");
        }
        const starts = hourStarts as Array<Date>;
        const minuteFloor = new Date(input.observedAt.valueOf() - 60_000);
        const minuteStarts = starts.filter((value) => value > minuteFloor);
        const exhaustedResets: Array<Date> = [];
        if (minuteStarts.length >= input.minuteLimit) {
          exhaustedResets.push(
            new Date(
              (
                minuteStarts[minuteStarts.length - input.minuteLimit] as Date
              ).valueOf() + 60_000,
            ),
          );
        }
        if (starts.length >= input.hourLimit) {
          exhaustedResets.push(
            new Date(
              (starts[starts.length - input.hourLimit] as Date).valueOf() +
                3_600_000,
            ),
          );
        }
        if (exhaustedResets.length > 0) {
          const resetsAt = new Date(
            Math.max(...exhaustedResets.map((value) => value.valueOf())),
          );
          await insertToolCallLog(connection, {
            auditLogId: input.auditLogId,
            authorizationId: input.authorizationId,
            completed: true,
            errorCode: "rate_limited",
            observedAt: input.observedAt,
            outcome: "rate_limited",
            personalAccountId,
            quotaReserved: false,
            toolName: input.toolName,
          });
          return {
            auditLogId: input.auditLogId,
            outcome: "rate_limited" as const,
            resetsAt,
            retryAfterSeconds: Math.max(
              0,
              Math.ceil(
                (resetsAt.valueOf() - input.observedAt.valueOf()) / 1_000,
              ),
            ),
          };
        }

        await insertToolCallLog(connection, {
          auditLogId: input.auditLogId,
          authorizationId: input.authorizationId,
          completed: false,
          errorCode: null,
          observedAt: input.observedAt,
          outcome: "started",
          personalAccountId,
          quotaReserved: true,
          toolName: input.toolName,
        });
        return {
          auditLogId: input.auditLogId,
          outcome: "started" as const,
        };
      }),
    ),
  listConnections: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if ((await enterAuthorizationContext(connection, input)) === null) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("connections:read")) {
          return null;
        }
        const result = await connection.query<{
          display_name: unknown;
          number_last_four: unknown;
          public_id: unknown;
          state: unknown;
          state_changed_at: unknown;
        }>(
          `SELECT
             connections.public_id,
             NULL::text AS display_name,
             connections.number_suffix AS number_last_four,
             connections.state,
             connections.state_changed_at
           FROM app.mcp_authorization_connections AS selected
           JOIN app.whatsapp_connections AS connections
             ON connections.personal_account_id = selected.personal_account_id
             AND connections.id = selected.whatsapp_connection_id
           WHERE selected.mcp_authorization_id = $1
             AND connections.state <> 'deleting'
           ORDER BY connections.created_at, connections.public_id`,
          [input.authorizationId],
        );
        return result.rows.map((row) => {
          const state = row.state;
          const stateChangedAt = timestampString(row.state_changed_at);
          if (
            row.display_name !== null ||
            (row.number_last_four !== null &&
              (typeof row.number_last_four !== "string" ||
                !/^[0-9]{4}$/u.test(row.number_last_four))) ||
            typeof row.public_id !== "string" ||
            !/^con_[A-Za-z0-9_-]{21}$/u.test(row.public_id) ||
            (state !== "connected" &&
              state !== "connecting" &&
              state !== "disconnected" &&
              state !== "reconnect_required" &&
              state !== "degraded") ||
            stateChangedAt === null
          ) {
            throw new Error("invalid persisted MCP WhatsApp Connection");
          }
          return {
            displayName: null,
            numberLastFour: row.number_last_four,
            publicId: row.public_id,
            state,
            stateChangedAt,
          };
        });
      }),
    ),
  listGroups: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          input.searchIndex !== null &&
          !/^gi1_[A-Za-z0-9_-]{43}$/u.test(input.searchIndex)
        ) {
          throw new Error("invalid MCP group search index");
        }
        if ((await enterAuthorizationContext(connection, input)) === null) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("directory:read")) {
          return null;
        }
        const material = await loadGroupProjectionMaterial(connection, input);
        if (material === null) return null;
        const personalAccountId = material.accountKey.personalAccountId;
        const connectionId = material.connectionKey.connectionId;
        const persistedGroups =
          input.searchIndex === null
            ? await connection.query<Record<string, unknown>>(
                `SELECT
                   id, public_id, display_name_ciphertext_version,
                   display_name_key_version, display_name_nonce,
                   display_name_ciphertext
                 FROM app.whatsapp_groups
                 WHERE personal_account_id = $1
                   AND whatsapp_connection_id = $2
                   AND joined`,
                [personalAccountId, connectionId],
              )
            : await connection.query<Record<string, unknown>>(
                `SELECT
                   id, public_id, display_name_ciphertext_version,
                   display_name_key_version, display_name_nonce,
                   display_name_ciphertext
                 FROM app.whatsapp_groups
                 WHERE personal_account_id = $1
                   AND whatsapp_connection_id = $2
                   AND joined
                   AND name_prefix_indexes
                     @> ARRAY[$3::app.group_name_blind_index]`,
                [personalAccountId, connectionId, input.searchIndex],
              );
        const groups = persistedGroups.rows.map((group) => {
          const id = group.id;
          const publicId = group.public_id;
          const ciphertext = bytes(group.display_name_ciphertext);
          const nonce = bytes(group.display_name_nonce);
          const version = positiveInteger(
            group.display_name_ciphertext_version,
          );
          const keyVersion = positiveInteger(group.display_name_key_version);
          if (
            typeof id !== "string" ||
            typeof publicId !== "string" ||
            !/^grp_[A-Za-z0-9_-]{21}$/u.test(publicId)
          ) {
            throw new Error("invalid persisted WhatsApp group");
          }
          if (
            ciphertext === null &&
            nonce === null &&
            version === null &&
            keyVersion === null
          ) {
            return { displayName: null, id, publicId };
          }
          if (
            ciphertext === null ||
            nonce === null ||
            version !== 1 ||
            keyVersion === null
          ) {
            throw new Error("invalid encrypted WhatsApp group display name");
          }
          return {
            displayName: {
              ciphertext: base64(ciphertext),
              keyVersion,
              nonce: base64(nonce),
              version: 1 as const,
            },
            id,
            publicId,
          };
        });
        return {
          accountKey: material.accountKey,
          asOf: material.asOf,
          connectionKey: material.connectionKey,
          groups,
          partial: material.partial,
          stale: material.stale,
        };
      }),
    ),
  loadGroupSearchMaterial: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if ((await enterAuthorizationContext(connection, input)) === null) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("directory:read")) {
          return null;
        }
        return loadGroupIndexMaterial(connection, input);
      }),
    ),
  completeToolCall: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const loaded = await connection.query<{
          personal_account_id: unknown;
        }>(
          `SELECT app_private.bootstrap_tool_call_log($1)
             AS personal_account_id`,
          [input.auditLogId],
        );
        const personalAccountId = loaded.rows[0]?.personal_account_id;
        if (typeof personalAccountId !== "string") {
          throw new Error("Tool Call Log unavailable");
        }
        await connection.query(
          "SELECT set_config('app.personal_account_id', $1, true)",
          [personalAccountId],
        );
        const updated = await connection.query<{ id: unknown }>(
          `UPDATE app.tool_call_logs
           SET
             completed_at = $2,
             outcome = $3,
             error_code = $4,
             result_count = $5,
             latency_ms = GREATEST(
               0,
               floor(extract(epoch FROM ($2::timestamptz - started_at)) * 1000)
             )::integer
           WHERE id = $1
             AND outcome = 'started'
           RETURNING id`,
          [
            input.auditLogId,
            input.completedAt,
            input.outcome,
            input.errorCode,
            input.resultCount,
          ],
        );
        if (updated.rows.length !== 1) {
          throw new Error("Tool Call Log completion unavailable");
        }
      }),
    ),
});

const makePgConnectionProvider = (
  connectionString: string,
): McpToolConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: McpToolConnection) => Promise<Value>,
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

export const makePgMcpToolRepository = (
  connectionString: string,
): McpToolRepository =>
  makeMcpToolRepository(makePgConnectionProvider(connectionString));
