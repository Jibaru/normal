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

export type McpToolName =
  | "list_connections"
  | "list_contacts"
  | "list_groups"
  | "send_text_message"
  | "get_send_status"
  | "list_chats"
  | "read_messages";

export interface McpToolMessageRecord {
  readonly publicId: string;
  readonly messageIdentity: string;
  readonly sentAt: string;
  readonly direction: "inbound" | "outbound";
  readonly conversationKind: "direct" | "group";
  readonly contentType:
    | "audio"
    | "document"
    | "image"
    | "sticker"
    | "text"
    | "unknown"
    | "video";
  readonly content: McpToolDirectoryCiphertext | null;
  readonly editedAt?: string | null;
  readonly deleted?: boolean;
}
export interface McpToolSendStatusRecord {
  readonly createdAt: string;
  readonly publicId: string;
  readonly status:
    | "processing"
    | "accepted"
    | "sent"
    | "delivered"
    | "read"
    | "failed"
    | "unknown";
  readonly statusChangedAt: string;
}
export interface McpToolMessagePage {
  readonly accountKey: AccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly messages: ReadonlyArray<McpToolMessageRecord>;
  readonly hasOlder: boolean;
  readonly sizeLimited: boolean;
  readonly historyStartsAt: string;
  readonly historyStartReason: "connection_started" | "retention_policy";
  readonly gaps: ReadonlyArray<{
    readonly startsAt: string;
    readonly endsAt: string | null;
    readonly cause:
      | "connection_unavailable"
      | "webhook_configuration"
      | "ingress_failure"
      | "processing_failure"
      | "restore_loss";
  }>;
}

export interface McpToolChatRecord {
  readonly conversationId: string;
  readonly kind: "direct" | "group";
  readonly recipientId: string;
  readonly displayName: McpToolDirectoryCiphertext | null;
  readonly displayNameRecordId: string;
  readonly displayNameEntity: "directory-contact" | "whatsapp-group";
  readonly phone: McpToolDirectoryCiphertext | null;
  readonly lastActivityAt: string;
  readonly lastActivityDirection: "inbound" | "outbound";
}
export interface McpToolChatPage {
  readonly accountKey: AccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly chats: ReadonlyArray<McpToolChatRecord>;
  readonly asOf: string;
  readonly stale: boolean;
  readonly partial: boolean;
}

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
  readonly getSendStatus: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
      readonly sendPublicId: string;
    },
  ) => Promise<McpToolSendStatusRecord | null>;
  readonly listGroups: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
      readonly searchIndex: string | null;
    },
  ) => Promise<McpToolGroupPage | null>;
  readonly listChats: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly cursorActivityAt: string | null;
      readonly cursorPublicId: string | null;
      readonly kind: "all" | "direct" | "group";
      readonly limit: number;
      readonly observedAt: Date;
    },
  ) => Promise<McpToolChatPage | null>;
  readonly readMessages: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly connectionPublicId: string;
      readonly conversationPublicId: string;
      readonly cursorSentAt: string | null;
      readonly cursorPublicId: string | null;
      readonly dailyRecordLimit: number;
      readonly limit: number;
      readonly observedAt: Date;
    },
  ) => Promise<
    | { readonly outcome: "success"; readonly page: McpToolMessagePage }
    | { readonly outcome: "record_quota_exhausted"; readonly resetsAt: Date }
    | null
  >;
  readonly completeMessageRead: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly dailyRecordLimit: number;
      readonly observedAt: Date;
      readonly resultCount: number;
    },
  ) => Promise<
    | { readonly outcome: "success" }
    | { readonly outcome: "record_quota_exhausted"; readonly resetsAt: Date }
  >;
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

const requiredString = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("invalid text value");
  return value;
};

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
  const parsed = parseGroupMaterial(material.rows[0]);
  if (parsed === null) return null;
  const freshness = await connection.query<Record<string, unknown>>(
    `SELECT
       CASE
         WHEN states.snapshot_observed_at IS NULL THEN true
         ELSE app_private.directory_projection_stale(
           states.personal_account_id,
           states.whatsapp_connection_id,
           $3,
           states.snapshot_observed_at,
           states.stale
         )
       END AS stale,
       CASE
         WHEN states.snapshot_observed_at IS NULL THEN true
         ELSE app_private.directory_projection_partial(
           states.personal_account_id,
           states.whatsapp_connection_id,
           states.snapshot_observed_at,
           states.partial,
           states.retention_limited
         )
       END AS partial
     FROM app.whatsapp_group_directory_states AS states
     WHERE states.personal_account_id = $1
       AND states.whatsapp_connection_id = $2`,
    [
      parsed.accountKey.personalAccountId,
      parsed.connectionKey.connectionId,
      input.observedAt,
    ],
  );
  const row = freshness.rows[0];
  if (row === undefined) return { ...parsed, partial: true, stale: true };
  if (typeof row.stale !== "boolean" || typeof row.partial !== "boolean") {
    throw new Error("invalid MCP group projection freshness");
  }
  return { ...parsed, partial: row.partial, stale: row.stale };
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
  toolName === "list_connections"
    ? "connections:read"
    : toolName === "send_text_message" || toolName === "get_send_status"
      ? "messages:send"
      : toolName === "list_chats"
        ? "messages:read"
        : toolName === "read_messages"
          ? "messages:read"
          : "directory:read";

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
  getSendStatus: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if ((await enterAuthorizationContext(connection, input)) === null)
          return null;
        const result = await connection.query<Record<string, unknown>>(
          `SELECT operations.public_id, operations.status,
             operations.created_at, operations.status_changed_at
           FROM app.send_operations AS operations
           JOIN app.whatsapp_connections AS connections
             ON connections.personal_account_id=operations.personal_account_id
            AND connections.id=operations.whatsapp_connection_id
           JOIN app.mcp_authorizations AS authorizations
             ON authorizations.personal_account_id=operations.personal_account_id
            AND authorizations.id=operations.mcp_authorization_id
           JOIN app.mcp_authorization_connections AS grants
             ON grants.personal_account_id=operations.personal_account_id
            AND grants.mcp_authorization_id=authorizations.id
            AND grants.whatsapp_connection_id=connections.id
           WHERE operations.mcp_authorization_id=$1
             AND operations.public_id=$2 AND connections.public_id=$3
             AND operations.expires_at>$4 AND connections.state<>'deleting'
             AND 'messages:send'=ANY(authorizations.scopes)`,
          [
            input.authorizationId,
            input.sendPublicId,
            input.connectionPublicId,
            input.observedAt,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        return {
          createdAt:
            timestampString(row.created_at) ??
            (() => {
              throw new Error("invalid send timestamp");
            })(),
          publicId: requiredString(row.public_id),
          status: requiredString(
            row.status,
          ) as McpToolSendStatusRecord["status"],
          statusChangedAt:
            timestampString(row.status_changed_at) ??
            (() => {
              throw new Error("invalid send timestamp");
            })(),
        };
      }),
    ),
  listChats: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 51 ||
          (input.cursorActivityAt === null) !==
            (input.cursorPublicId === null) ||
          (input.cursorPublicId !== null &&
            !/^cvs_[A-Za-z0-9_-]{21}$/u.test(input.cursorPublicId))
        ) {
          throw new Error("invalid MCP chat query");
        }
        if ((await enterAuthorizationContext(connection, input)) === null)
          return null;
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("messages:read")) return null;
        const materialResult = await connection.query<Record<string, unknown>>(
          `SELECT connections.personal_account_id, connections.id AS connection_id,
             account_keys.key_version AS account_key_version, account_keys.kms_key_id AS account_kms_key_id,
             account_keys.ciphertext AS account_key_ciphertext,
             connection_keys.account_key_version AS connection_key_account_version,
             connection_keys.key_version AS connection_key_version, connection_keys.nonce AS connection_key_nonce,
             connection_keys.ciphertext AS connection_key_ciphertext,
             greatest(coalesce(contacts.as_of, connections.created_at), coalesce(groups.as_of, connections.created_at)) AS as_of,
             (coalesce(contacts.stale,true) OR coalesce(groups.stale,true)) AS stale,
             (coalesce(contacts.partial,true) OR coalesce(groups.partial,true)) AS partial
           FROM app.mcp_authorization_connections selected
           JOIN app.whatsapp_connections connections ON connections.personal_account_id=selected.personal_account_id AND connections.id=selected.whatsapp_connection_id
           JOIN app.whatsapp_connection_key_envelopes connection_keys ON connection_keys.personal_account_id=connections.personal_account_id AND connection_keys.whatsapp_connection_id=connections.id
           JOIN app.personal_account_key_envelopes account_keys ON account_keys.personal_account_id=connections.personal_account_id AND account_keys.key_version=connection_keys.account_key_version
           LEFT JOIN app.directory_contact_projections contacts ON contacts.personal_account_id=connections.personal_account_id AND contacts.whatsapp_connection_id=connections.id
           LEFT JOIN app.whatsapp_group_directory_states groups ON groups.personal_account_id=connections.personal_account_id AND groups.whatsapp_connection_id=connections.id
           WHERE selected.mcp_authorization_id=$1 AND connections.public_id=$2 AND connections.state <> 'deleting'`,
          [input.authorizationId, input.connectionPublicId],
        );
        const material = parseGroupMaterial(materialResult.rows[0]);
        if (material === null) return null;
        const rows = await connection.query<Record<string, unknown>>(
          `SELECT conversations.public_id, conversations.kind, conversations.recipient_public_id,
             conversations.last_activity_at, conversations.last_activity_direction,
             coalesce(contacts.provider_identity_index, groups.id::text, conversations.recipient_public_id) AS recipient_record_id,
             coalesce(contacts.display_name_ciphertext_version, groups.display_name_ciphertext_version) AS display_version,
             coalesce(contacts.display_name_key_version, groups.display_name_key_version) AS display_key_version,
             coalesce(contacts.display_name_nonce, groups.display_name_nonce) AS display_nonce,
             coalesce(contacts.display_name_ciphertext, groups.display_name_ciphertext) AS display_ciphertext,
             contacts.phone_ciphertext_version AS phone_version, contacts.phone_key_version,
             contacts.phone_nonce, contacts.phone_ciphertext
           FROM app.whatsapp_conversations conversations
           LEFT JOIN app.directory_contacts contacts ON conversations.kind='direct' AND contacts.personal_account_id=conversations.personal_account_id AND contacts.whatsapp_connection_id=conversations.whatsapp_connection_id AND contacts.public_id=conversations.recipient_public_id
           LEFT JOIN app.whatsapp_groups groups ON conversations.kind='group' AND groups.personal_account_id=conversations.personal_account_id AND groups.whatsapp_connection_id=conversations.whatsapp_connection_id AND groups.public_id=conversations.recipient_public_id
           WHERE conversations.personal_account_id=$1 AND conversations.whatsapp_connection_id=$2
             AND ($3='all' OR conversations.kind=$3)
             AND ($4::timestamptz IS NULL OR conversations.last_activity_at < $4 OR (conversations.last_activity_at=$4 AND conversations.public_id > $5))
           ORDER BY conversations.last_activity_at DESC, conversations.public_id LIMIT $6`,
          [
            material.accountKey.personalAccountId,
            material.connectionKey.connectionId,
            input.kind,
            input.cursorActivityAt,
            input.cursorPublicId,
            input.limit,
          ],
        );
        const encrypted = (
          row: Record<string, unknown>,
          prefix: "display" | "phone",
        ): McpToolDirectoryCiphertext | null => {
          const ciphertext = bytes(row[`${prefix}_ciphertext`]);
          const nonce = bytes(row[`${prefix}_nonce`]);
          const version = positiveInteger(row[`${prefix}_version`]);
          const keyVersion = positiveInteger(
            row[
              prefix === "display" ? "display_key_version" : "phone_key_version"
            ],
          );
          if (
            ciphertext === null &&
            nonce === null &&
            version === null &&
            keyVersion === null
          )
            return null;
          if (
            ciphertext === null ||
            nonce === null ||
            version !== 1 ||
            keyVersion === null
          )
            throw new Error("invalid chat metadata ciphertext");
          return {
            ciphertext: base64(ciphertext),
            nonce: base64(nonce),
            keyVersion,
            version: 1,
          };
        };
        return {
          ...material,
          chats: rows.rows.map((row) => {
            const activity = timestampString(row.last_activity_at);
            if (
              typeof row.public_id !== "string" ||
              typeof row.recipient_public_id !== "string" ||
              typeof row.recipient_record_id !== "string" ||
              activity === null ||
              (row.kind !== "direct" && row.kind !== "group") ||
              (row.last_activity_direction !== "inbound" &&
                row.last_activity_direction !== "outbound")
            )
              throw new Error("invalid WhatsApp Conversation");
            return {
              conversationId: row.public_id,
              kind: row.kind,
              recipientId: row.recipient_public_id,
              displayName: encrypted(row, "display"),
              displayNameRecordId: row.recipient_record_id,
              displayNameEntity:
                row.kind === "direct" ? "directory-contact" : "whatsapp-group",
              phone: encrypted(row, "phone"),
              lastActivityAt: activity,
              lastActivityDirection: row.last_activity_direction,
            };
          }),
        };
      }),
    ),
  readMessages: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          !/^cvs_[A-Za-z0-9_-]{21}$/u.test(input.conversationPublicId) ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 51 ||
          !Number.isSafeInteger(input.dailyRecordLimit) ||
          input.dailyRecordLimit < 1 ||
          (input.cursorSentAt === null) !== (input.cursorPublicId === null) ||
          (input.cursorPublicId !== null &&
            !/^msg_[A-Za-z0-9_-]{21}$/u.test(input.cursorPublicId))
        )
          throw new Error("invalid MCP message query");
        const accountId = await enterAuthorizationContext(connection, input);
        if (accountId === null) return null;
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("messages:read")) return null;
        const materialResult = await connection.query<Record<string, unknown>>(
          `SELECT * FROM app_private.load_mcp_message_read_material($1, $2, $3, $4, $5, $6)`,
          [
            input.authorizationId,
            input.oauthSubject,
            input.clientId ?? null,
            input.observedAt,
            input.connectionPublicId,
            input.conversationPublicId,
          ],
        );
        const row = materialResult.rows[0];
        const connectionId =
          typeof row?.connection_id === "string" ? row.connection_id : null;
        const materialRow = row;
        const accountCiphertext = bytes(materialRow?.account_key_ciphertext);
        const accountKeyVersion = positiveInteger(
          materialRow?.account_key_version,
        );
        const connectionAccountKeyVersion = positiveInteger(
          materialRow?.connection_key_account_version,
        );
        const connectionCiphertext = bytes(
          materialRow?.connection_key_ciphertext,
        );
        const connectionKeyVersion = positiveInteger(
          materialRow?.connection_key_version,
        );
        const connectionNonce = bytes(materialRow?.connection_key_nonce);
        const material =
          connectionId === null ||
          typeof materialRow?.account_kms_key_id !== "string" ||
          accountCiphertext === null ||
          accountKeyVersion === null ||
          connectionAccountKeyVersion === null ||
          connectionCiphertext === null ||
          connectionKeyVersion === null ||
          connectionNonce?.byteLength !== 12
            ? null
            : {
                accountKey: {
                  ciphertext: base64(accountCiphertext),
                  keyVersion: accountKeyVersion,
                  kmsKeyId: materialRow.account_kms_key_id,
                  personalAccountId: accountId,
                  version: 1 as const,
                },
                connectionKey: {
                  accountKeyVersion: connectionAccountKeyVersion,
                  ciphertext: base64(connectionCiphertext),
                  connectionId,
                  keyVersion: connectionKeyVersion,
                  nonce: base64(connectionNonce),
                  personalAccountId: accountId,
                  version: 1 as const,
                },
              };
        const connectionStarted = timestamp(row?.connection_created_at);
        const retentionDays = positiveInteger(row?.message_retention_days);
        if (
          material === null ||
          connectionStarted === null ||
          retentionDays === null
        )
          return null;
        const retentionStart = new Date(
          input.observedAt.valueOf() - retentionDays * 86_400_000,
        );
        const historyStart =
          retentionStart > connectionStarted
            ? retentionStart
            : connectionStarted;
        const rows = await connection.query<Record<string, unknown>>(
          `SELECT messages.public_id, messages.message_identity, messages.sent_at, messages.direction,
             messages.content_type, messages.content_ciphertext_version, messages.content_key_version,
             messages.content_nonce, messages.content_ciphertext, messages.edited_at,
             messages.deleted_at, conversations.kind
           FROM app.stored_messages messages
           JOIN app.whatsapp_conversations conversations ON conversations.personal_account_id=messages.personal_account_id AND conversations.whatsapp_connection_id=messages.whatsapp_connection_id AND conversations.id=messages.conversation_id
           WHERE messages.personal_account_id=$1 AND messages.whatsapp_connection_id=$2
             AND conversations.public_id=$3 AND messages.sent_at >= $4
             AND ($5::timestamptz IS NULL OR messages.sent_at < $5 OR (messages.sent_at=$5 AND messages.public_id < $6))
           ORDER BY messages.sent_at DESC, messages.public_id DESC LIMIT $7`,
          [
            accountId,
            material.connectionKey.connectionId,
            input.conversationPublicId,
            historyStart,
            input.cursorSentAt,
            input.cursorPublicId,
            input.limit + 1,
          ],
        );
        const candidateRows = rows.rows.slice(0, input.limit);
        const returnedRows: Array<Record<string, unknown>> = [];
        let encryptedBytes = 0;
        for (const candidate of candidateRows) {
          const ciphertext = bytes(candidate.content_ciphertext);
          if (ciphertext === null && candidate.deleted_at === null)
            throw new Error("invalid Stored Message ciphertext");
          if (
            returnedRows.length > 0 &&
            encryptedBytes + (ciphertext?.byteLength ?? 0) > 24_000
          )
            break;
          returnedRows.push(candidate);
          encryptedBytes += ciphertext?.byteLength ?? 0;
        }
        const messages = returnedRows.map((message): McpToolMessageRecord => {
          const sentAt = timestampString(message.sent_at);
          const ciphertext = bytes(message.content_ciphertext);
          const nonce = bytes(message.content_nonce);
          const keyVersion = positiveInteger(message.content_key_version);
          const editedAt =
            message.edited_at === null
              ? null
              : timestampString(message.edited_at);
          const deleted = timestamp(message.deleted_at) !== null;
          if (
            typeof message.public_id !== "string" ||
            typeof message.message_identity !== "string" ||
            sentAt === null ||
            (message.direction !== "inbound" &&
              message.direction !== "outbound") ||
            (message.kind !== "direct" && message.kind !== "group") ||
            (!deleted &&
              (typeof message.content_type !== "string" ||
                ![
                  "audio",
                  "document",
                  "image",
                  "sticker",
                  "text",
                  "unknown",
                  "video",
                ].includes(message.content_type))) ||
            (!deleted && message.content_ciphertext_version !== 1) ||
            (!deleted &&
              (ciphertext === null || nonce === null || keyVersion === null)) ||
            (message.edited_at !== null && editedAt === null)
          )
            throw new Error("invalid Stored Message");
          return {
            publicId: message.public_id,
            messageIdentity: message.message_identity,
            sentAt,
            direction: message.direction,
            conversationKind: message.kind,
            contentType: deleted
              ? "unknown"
              : (message.content_type as McpToolMessageRecord["contentType"]),
            content: deleted
              ? null
              : {
                  ciphertext: base64(ciphertext as Uint8Array),
                  keyVersion: keyVersion as number,
                  nonce: base64(nonce as Uint8Array),
                  version: 1,
                },
            editedAt,
            deleted,
          };
        });
        const newest = messages[0]?.sentAt ?? input.observedAt.toISOString();
        const gapsResult = await connection.query<Record<string, unknown>>(
          `SELECT starts_at, ends_at, cause FROM app.ingestion_gaps WHERE personal_account_id=$1 AND whatsapp_connection_id=$2
             AND starts_at <= $3 AND (ends_at IS NULL OR ends_at >= $4) ORDER BY starts_at, id`,
          [
            accountId,
            material.connectionKey.connectionId,
            newest,
            historyStart,
          ],
        );
        const gaps = gapsResult.rows.map((gap) => {
          const startsAt = timestampString(gap.starts_at);
          const endsAt =
            gap.ends_at === null ? null : timestampString(gap.ends_at);
          if (
            startsAt === null ||
            (gap.ends_at !== null && endsAt === null) ||
            typeof gap.cause !== "string"
          )
            throw new Error("invalid Ingestion Gap");
          return {
            startsAt,
            endsAt,
            cause: gap.cause as McpToolMessagePage["gaps"][number]["cause"],
          };
        });
        return {
          outcome: "success" as const,
          page: {
            ...material,
            messages,
            hasOlder:
              rows.rows.length > candidateRows.length ||
              returnedRows.length < candidateRows.length,
            sizeLimited:
              returnedRows.length < candidateRows.length ||
              encryptedBytes > 24_000,
            historyStartsAt: historyStart.toISOString(),
            historyStartReason:
              historyStart === retentionStart
                ? ("retention_policy" as const)
                : ("connection_started" as const),
            gaps,
          },
        };
      }),
    ),
  completeMessageRead: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          !Number.isSafeInteger(input.dailyRecordLimit) ||
          input.dailyRecordLimit < 1 ||
          !Number.isSafeInteger(input.resultCount) ||
          input.resultCount < 0 ||
          input.resultCount > 50
        )
          throw new Error("invalid MCP message completion");
        const accountId = await enterAuthorizationContext(connection, input);
        if (accountId === null) throw new Error("authorization unavailable");
        await connection.query(
          "SELECT id FROM app.personal_accounts WHERE id=$1 FOR UPDATE",
          [accountId],
        );
        const used = await connection.query<{ count: unknown }>(
          `SELECT coalesce(sum(result_count),0)::int AS count FROM app.tool_call_logs
           WHERE personal_account_id=$1 AND tool_name='read_messages' AND outcome='success'
             AND started_at >= (date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
             AND started_at < (date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + interval '1 day'`,
          [accountId, input.observedAt],
        );
        const usedCount = Number(used.rows[0]?.count);
        if (!Number.isSafeInteger(usedCount))
          throw new Error("invalid returned-record quota");
        if (usedCount + input.resultCount > input.dailyRecordLimit) {
          return {
            outcome: "record_quota_exhausted" as const,
            resetsAt: new Date(
              Date.UTC(
                input.observedAt.getUTCFullYear(),
                input.observedAt.getUTCMonth(),
                input.observedAt.getUTCDate() + 1,
              ),
            ),
          };
        }
        const updated = await connection.query(
          `UPDATE app.tool_call_logs SET completed_at=$2,outcome='success',error_code=NULL,result_count=$3,
             latency_ms=GREATEST(0,floor(extract(epoch FROM ($2::timestamptz-started_at))*1000))::integer
           WHERE id=$1 AND personal_account_id=$4 AND mcp_authorization_id=$5
             AND tool_name='read_messages' AND outcome='started' RETURNING id`,
          [
            input.auditLogId,
            input.observedAt,
            input.resultCount,
            accountId,
            input.authorizationId,
          ],
        );
        if (updated.rows.length !== 1)
          throw new Error("Tool Call Log completion unavailable");
        return { outcome: "success" as const };
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
             CASE
               WHEN projections.snapshot_observed_at IS NULL THEN true
               ELSE app_private.directory_projection_stale(
                 connections.personal_account_id,
                 connections.id,
                 $3,
                 projections.snapshot_observed_at,
                 projections.stale
               )
             END AS projection_stale,
             CASE
               WHEN projections.snapshot_observed_at IS NULL THEN true
               ELSE app_private.directory_projection_partial(
                 connections.personal_account_id,
                 connections.id,
                 projections.snapshot_observed_at,
                 projections.partial,
                 projections.retention_limited
               )
             END AS projection_partial,
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
          [input.authorizationId, input.connectionPublicId, input.observedAt],
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
             AND (outcome = 'started' OR (tool_name = 'read_messages' AND outcome = 'success' AND $3 = 'execution_error'))
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
