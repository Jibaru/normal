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
      readonly toolName: "list_connections" | "list_contacts";
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
  ) => Promise<ReadonlyArray<McpToolEncryptedContactRecord> | null>;
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

const requiredScope = (
  toolName: "list_connections" | "list_contacts",
): McpAuthorizationScope =>
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
        if ((await enterAuthorizationContext(connection, input)) === null) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("directory:read")) return null;
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
        return result.rows.map((row) => {
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
