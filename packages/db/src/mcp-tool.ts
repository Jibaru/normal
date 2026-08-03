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

export type McpToolName = "list_connections" | "list_contacts" | "list_groups";

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

interface AccountKeyEnvelope {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

interface ConnectionKeyEnvelope {
  readonly accountKeyVersion: number;
  readonly ciphertext: string;
  readonly connectionId: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

export interface McpToolDirectoryCiphertext {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
}

export interface McpToolContactReadMaterial {
  readonly accountKey: AccountKeyEnvelope;
  readonly asOf: string;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly identityKey: McpToolDirectoryCiphertext;
  readonly partial: boolean;
  readonly personalAccountId: string;
  readonly stale: boolean;
  readonly whatsappConnectionId: string;
}

export interface McpToolEncryptedContactRecord {
  readonly displayNameCiphertext: McpToolDirectoryCiphertext | null;
  readonly displayNameSort: string;
  readonly phoneCiphertext: McpToolDirectoryCiphertext | null;
  readonly providerIdentityIndex: string;
  readonly publicId: string;
}

export interface McpToolEncryptedContactPage {
  readonly asOf: string;
  readonly contacts: ReadonlyArray<McpToolEncryptedContactRecord>;
  readonly partial: boolean;
  readonly snapshotObservedAt: string | null;
  readonly stale: boolean;
}

export type RejectToolCallResult = "authorization_denied" | "rejected";

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
  readonly loadContactReadMaterial: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
    },
  ) => Promise<McpToolContactReadMaterial | null>;
  readonly listEncryptedContacts: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly cursorDisplayNameSort: string | null;
      readonly cursorPublicId: string | null;
      readonly limit: number;
      readonly observedAt: Date;
      readonly searchIndex: string | null;
      readonly searchKind: "name" | "phone" | null;
    },
  ) => Promise<McpToolEncryptedContactPage | null>;
  readonly rejectToolCall: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly errorCode: string;
      readonly observedAt: Date;
      readonly toolName: "list_connections" | "list_contacts";
    },
  ) => Promise<RejectToolCallResult>;
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

const encodeBase64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

interface ContactMaterialRow extends Record<string, unknown> {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly account_kms_key_id: unknown;
  readonly connection_key_account_version: unknown;
  readonly connection_key_ciphertext: unknown;
  readonly connection_key_nonce: unknown;
  readonly connection_key_version: unknown;
  readonly identity_ciphertext: unknown;
  readonly identity_ciphertext_version: unknown;
  readonly identity_key_version: unknown;
  readonly identity_nonce: unknown;
  readonly personal_account_id: unknown;
  readonly projection_as_of: unknown;
  readonly projection_partial: unknown;
  readonly projection_stale: unknown;
  readonly whatsapp_connection_id: unknown;
}

const contactReadMaterial = (
  row: ContactMaterialRow | undefined,
): McpToolContactReadMaterial | null => {
  if (row === undefined) return null;
  const accountCiphertext = bytes(row.account_key_ciphertext);
  const accountVersion = positiveInteger(row.account_key_version);
  const connectionAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const connectionCiphertext = bytes(row.connection_key_ciphertext);
  const connectionNonce = bytes(row.connection_key_nonce);
  const connectionVersion = positiveInteger(row.connection_key_version);
  const identityCiphertext = bytes(row.identity_ciphertext);
  const identityNonce = bytes(row.identity_nonce);
  const identityVersion = positiveInteger(row.identity_key_version);
  const asOf = timestampString(row.projection_as_of);
  if (
    typeof row.personal_account_id !== "string" ||
    typeof row.whatsapp_connection_id !== "string" ||
    typeof row.account_kms_key_id !== "string" ||
    row.account_kms_key_id.length === 0 ||
    accountCiphertext === null ||
    accountVersion === null ||
    connectionAccountVersion === null ||
    connectionCiphertext === null ||
    connectionNonce?.byteLength !== 12 ||
    connectionVersion === null ||
    row.identity_ciphertext_version !== 1 ||
    identityCiphertext === null ||
    identityNonce?.byteLength !== 12 ||
    identityVersion === null ||
    typeof row.projection_stale !== "boolean" ||
    typeof row.projection_partial !== "boolean" ||
    asOf === null
  ) {
    throw new Error("invalid MCP Directory read material");
  }
  return {
    accountKey: {
      ciphertext: encodeBase64(accountCiphertext),
      keyVersion: accountVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    asOf,
    connectionKey: {
      accountKeyVersion: connectionAccountVersion,
      ciphertext: encodeBase64(connectionCiphertext),
      connectionId: row.whatsapp_connection_id,
      keyVersion: connectionVersion,
      nonce: encodeBase64(connectionNonce),
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    identityKey: {
      ciphertext: encodeBase64(identityCiphertext),
      keyVersion: identityVersion,
      nonce: encodeBase64(identityNonce),
      version: 1,
    },
    partial: row.projection_partial,
    personalAccountId: row.personal_account_id,
    stale: row.projection_stale,
    whatsappConnectionId: row.whatsapp_connection_id,
  };
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
    readonly outcome:
      | "started"
      | "rate_limited"
      | "authorization_denied"
      | "execution_error";
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

const requiredScope = (toolName: McpToolName): McpAuthorizationScope =>
  toolName === "list_connections" ? "connections:read" : "directory:read";

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
        if (
          scopes === null ||
          !scopes.includes(requiredScope(input.toolName))
        ) {
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
  loadContactReadMaterial: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const result = await connection.query<ContactMaterialRow>(
          `SELECT *
           FROM app_private.load_mcp_contact_read_material($1, $2, $3, $4, $5)`,
          [
            input.authorizationId,
            input.oauthSubject,
            input.clientId ?? null,
            input.connectionPublicId,
            input.observedAt,
          ],
        );
        const material = contactReadMaterial(result.rows[0]);
        if (material === null) return null;
        await connection.query(
          "SELECT set_config('app.personal_account_id', $1, true)",
          [material.personalAccountId],
        );
        return material;
      }),
    ),
  listEncryptedContacts: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 51 ||
          (input.cursorDisplayNameSort === null) !==
            (input.cursorPublicId === null) ||
          (input.cursorPublicId !== null &&
            !/^ctc_[A-Za-z0-9_-]{21}$/u.test(input.cursorPublicId)) ||
          (input.searchIndex === null) !== (input.searchKind === null) ||
          (input.searchIndex !== null &&
            !/^di1_[A-Za-z0-9_-]{43}$/u.test(input.searchIndex))
        ) {
          throw new Error("invalid MCP contact query");
        }
        await connection.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
        );
        if ((await enterAuthorizationContext(connection, input)) === null) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("directory:read")) return null;
        const projectionResult = await connection.query<{
          projection_as_of: unknown;
          projection_partial: unknown;
          projection_snapshot_observed_at: unknown;
          projection_stale: unknown;
        }>(
          `SELECT
             coalesce(projections.as_of, connections.created_at)
               AS projection_as_of,
             coalesce(projections.stale, true) AS projection_stale,
             coalesce(projections.partial, true) AS projection_partial,
             projections.snapshot_observed_at
               AS projection_snapshot_observed_at
           FROM app.mcp_authorization_connections AS selected
           JOIN app.whatsapp_connections AS connections
             ON connections.personal_account_id = selected.personal_account_id
            AND connections.id = selected.whatsapp_connection_id
           LEFT JOIN app.directory_contact_projections AS projections
             ON projections.personal_account_id = connections.personal_account_id
            AND projections.whatsapp_connection_id = connections.id
           WHERE selected.mcp_authorization_id = $1
             AND connections.public_id = $2
             AND connections.state <> 'deleting'`,
          [input.authorizationId, input.connectionPublicId],
        );
        const projection = projectionResult.rows[0];
        const asOf = timestampString(projection?.projection_as_of);
        const snapshotObservedAt =
          projection?.projection_snapshot_observed_at === null
            ? null
            : timestampString(projection?.projection_snapshot_observed_at);
        if (
          projection === undefined ||
          asOf === null ||
          typeof projection.projection_stale !== "boolean" ||
          typeof projection.projection_partial !== "boolean" ||
          (projection.projection_snapshot_observed_at !== null &&
            snapshotObservedAt === null)
        ) {
          throw new Error("invalid MCP Directory projection metadata");
        }
        const result = await connection.query<{
          display_name_ciphertext: unknown;
          display_name_ciphertext_version: unknown;
          display_name_key_version: unknown;
          display_name_nonce: unknown;
          display_name_sort: unknown;
          phone_ciphertext: unknown;
          phone_ciphertext_version: unknown;
          phone_key_version: unknown;
          phone_nonce: unknown;
          provider_identity_index: unknown;
          public_id: unknown;
        }>(
          `SELECT
             contacts.public_id,
             contacts.provider_identity_index,
             contacts.display_name_ciphertext_version,
             contacts.display_name_key_version,
             contacts.display_name_nonce,
             contacts.display_name_ciphertext,
             contacts.display_name_sort,
             contacts.phone_ciphertext_version,
             contacts.phone_key_version,
             contacts.phone_nonce,
             contacts.phone_ciphertext
           FROM app.mcp_authorization_connections AS selected
           JOIN app.whatsapp_connections AS connections
             ON connections.personal_account_id = selected.personal_account_id
            AND connections.id = selected.whatsapp_connection_id
           JOIN app.directory_contacts AS contacts
             ON contacts.personal_account_id = connections.personal_account_id
            AND contacts.whatsapp_connection_id = connections.id
           WHERE selected.mcp_authorization_id = $1
             AND connections.public_id = $2
             AND connections.state <> 'deleting'
             AND contacts.active
             AND (
               $5::text IS NULL
               OR (contacts.display_name_sort, contacts.public_id)
                 > ($5::text COLLATE "C", $6::text)
             )
             AND (
               $3::text IS NULL
               OR ($4 = 'phone' AND contacts.phone_index = $3)
               OR (
                 $4 = 'name'
                 AND contacts.name_prefix_indexes
                   @> ARRAY[$3::app.directory_blind_index]
               )
             )
           ORDER BY contacts.display_name_sort, contacts.public_id
           LIMIT $7`,
          [
            input.authorizationId,
            input.connectionPublicId,
            input.searchIndex,
            input.searchKind,
            input.cursorDisplayNameSort,
            input.cursorPublicId,
            input.limit,
          ],
        );
        const parseField = (
          row: (typeof result.rows)[number],
          prefix: "display_name" | "phone",
        ): McpToolDirectoryCiphertext | null => {
          const ciphertext = bytes(row[`${prefix}_ciphertext`]);
          const nonce = bytes(row[`${prefix}_nonce`]);
          const version = positiveInteger(row[`${prefix}_key_version`]);
          const formatVersion = row[`${prefix}_ciphertext_version`];
          if (
            ciphertext === null &&
            nonce === null &&
            version === null &&
            formatVersion === null
          ) {
            return null;
          }
          if (
            ciphertext === null ||
            nonce?.byteLength !== 12 ||
            version === null ||
            formatVersion !== 1
          ) {
            throw new Error("invalid encrypted MCP Directory field");
          }
          return {
            ciphertext: encodeBase64(ciphertext),
            keyVersion: version,
            nonce: encodeBase64(nonce),
            version: 1,
          };
        };
        const contacts = result.rows.map((row) => {
          if (
            typeof row.public_id !== "string" ||
            !/^ctc_[A-Za-z0-9_-]{21}$/u.test(row.public_id) ||
            typeof row.provider_identity_index !== "string" ||
            !/^di1_[A-Za-z0-9_-]{43}$/u.test(row.provider_identity_index) ||
            typeof row.display_name_sort !== "string"
          ) {
            throw new Error("invalid persisted MCP Directory contact");
          }
          return {
            displayNameCiphertext: parseField(row, "display_name"),
            displayNameSort: row.display_name_sort,
            phoneCiphertext: parseField(row, "phone"),
            providerIdentityIndex: row.provider_identity_index,
            publicId: row.public_id,
          };
        });
        return {
          asOf,
          contacts,
          partial: projection.projection_partial,
          snapshotObservedAt,
          stale: projection.projection_stale,
        };
      }),
    ),
  rejectToolCall: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const personalAccountId = await enterAuthorizationContext(
          connection,
          input,
        );
        if (personalAccountId === null) return "authorization_denied" as const;
        const scopes = await loadAuthorizationScopes(connection, input);
        if (
          scopes === null ||
          !scopes.includes(requiredScope(input.toolName))
        ) {
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
          return "authorization_denied" as const;
        }
        await insertToolCallLog(connection, {
          auditLogId: input.auditLogId,
          authorizationId: input.authorizationId,
          completed: true,
          errorCode: input.errorCode,
          observedAt: input.observedAt,
          outcome: "execution_error",
          personalAccountId,
          quotaReserved: false,
          toolName: input.toolName,
        });
        return "rejected" as const;
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
