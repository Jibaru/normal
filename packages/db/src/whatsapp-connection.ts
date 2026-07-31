import type { WhatsAppConnectionState } from "@whatsapp-mcp/domain/whatsapp-connection";
import type { Client as PgClient } from "pg";

export interface WhatsAppConnectionConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface WhatsAppConnectionConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: WhatsAppConnectionConnection) => Promise<Value>,
  ) => Promise<Value>;
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

interface VersionedCiphertext {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
}

export interface WhatsAppConnectionRecord {
  readonly displayName: string | null;
  readonly numberSuffix: string;
  readonly publicId: string;
  readonly state: WhatsAppConnectionState;
  readonly stateChangedAt: string;
}

export type ConnectionSetupActivation =
  | {
      readonly outcome:
        | "pending"
        | "provisioning_failed"
        | "provisioning_quarantined";
    }
  | {
      readonly outcome: "activated";
      readonly connection: WhatsAppConnectionRecord;
    }
  | {
      readonly outcome: "provisioned";
      readonly setup: {
        readonly accountKey: AccountKeyEnvelope;
        readonly numberCiphertext: VersionedCiphertext;
        readonly personalAccountId: string;
        readonly setupId: string;
        readonly setupKey: ConnectionKeyEnvelope;
      };
    };

export interface ActivateWhatsAppConnectionInput {
  readonly accountKeyVersion: number;
  readonly authorityCiphertext: Uint8Array;
  readonly authorityCiphertextVersion: number;
  readonly authorityKeyVersion: number;
  readonly authorityNonce: Uint8Array;
  readonly connectionId: string;
  readonly connectionKeyCiphertext: Uint8Array;
  readonly connectionKeyNonce: Uint8Array;
  readonly connectionKeyVersion: number;
  readonly connectedAt: string;
  readonly locatorCiphertext: Uint8Array;
  readonly locatorCiphertextVersion: number;
  readonly locatorKeyVersion: number;
  readonly locatorNonce: Uint8Array;
  readonly numberSuffix: string;
  readonly personalAccountId: string;
  readonly publicId: string;
  readonly setupId: string;
  readonly webhookIngressId: string;
  readonly webhookSecretCiphertext: Uint8Array;
  readonly webhookSecretCiphertextVersion: number;
  readonly webhookSecretKeyVersion: number;
  readonly webhookSecretNonce: Uint8Array;
}

export interface WhatsAppConnectionRepository {
  readonly activate: (
    input: ActivateWhatsAppConnectionInput,
  ) => Promise<WhatsAppConnectionRecord>;
  readonly listForUser: (
    clerkUserId: string,
  ) => Promise<ReadonlyArray<WhatsAppConnectionRecord>>;
  readonly loadSetupForActivation: (input: {
    readonly clerkUserId: string;
    readonly setupId: string;
  }) => Promise<ConnectionSetupActivation | null>;
}

const withTransaction = async <Value>(
  connection: WhatsAppConnectionConnection,
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
  connection: WhatsAppConnectionConnection,
  personalAccountId: string,
): Promise<void> => {
  await connection.query(
    "SELECT set_config('app.personal_account_id', $1, true)",
    [personalAccountId],
  );
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

const connectionStates = new Set<WhatsAppConnectionState>([
  "connected",
  "connecting",
  "disconnected",
  "reconnect_required",
  "degraded",
  "deleting",
]);

interface ConnectionRow extends Record<string, unknown> {
  readonly connection_display_name?: unknown;
  readonly connection_number_suffix?: unknown;
  readonly connection_public_id?: unknown;
  readonly connection_state?: unknown;
  readonly connection_state_changed_at?: unknown;
  readonly display_name?: unknown;
  readonly number_suffix?: unknown;
  readonly public_id?: unknown;
  readonly state?: unknown;
  readonly state_changed_at?: unknown;
}

const connectionRecord = (
  row: ConnectionRow | undefined,
  prefix = "",
): WhatsAppConnectionRecord | null => {
  const displayName = row?.[`${prefix}display_name`];
  const numberSuffix = row?.[`${prefix}number_suffix`];
  const publicId = row?.[`${prefix}public_id`];
  const state = row?.[`${prefix}state`];
  const stateChangedAt = timestamp(row?.[`${prefix}state_changed_at`]);
  if (
    (displayName !== null && typeof displayName !== "string") ||
    typeof numberSuffix !== "string" ||
    !/^[0-9]{4}$/u.test(numberSuffix) ||
    typeof publicId !== "string" ||
    !/^con_[A-Za-z0-9_-]{21}$/u.test(publicId) ||
    typeof state !== "string" ||
    !connectionStates.has(state as WhatsAppConnectionState) ||
    stateChangedAt === null
  ) {
    return null;
  }
  return {
    displayName,
    numberSuffix,
    publicId,
    state: state as WhatsAppConnectionState,
    stateChangedAt,
  };
};

interface ActivationRow extends ConnectionRow {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly account_kms_key_id: unknown;
  readonly number_ciphertext: unknown;
  readonly number_ciphertext_version: unknown;
  readonly number_key_version: unknown;
  readonly number_nonce: unknown;
  readonly outcome: unknown;
  readonly personal_account_id: unknown;
  readonly setup_key_account_version: unknown;
  readonly setup_key_ciphertext: unknown;
  readonly setup_key_nonce: unknown;
  readonly setup_key_version: unknown;
}

const versionedCiphertext = (
  versionValue: unknown,
  keyVersionValue: unknown,
  nonceValue: unknown,
  ciphertextValue: unknown,
): VersionedCiphertext | null => {
  const version = positiveInteger(versionValue);
  const keyVersion = positiveInteger(keyVersionValue);
  const nonce = bytes(nonceValue);
  const ciphertext = bytes(ciphertextValue);
  return version === 1 &&
    keyVersion !== null &&
    nonce !== null &&
    ciphertext !== null
    ? {
        ciphertext: encodeBase64(ciphertext),
        keyVersion,
        nonce: encodeBase64(nonce),
        version: 1,
      }
    : null;
};

const activation = (
  setupId: string,
  row: ActivationRow | undefined,
): ConnectionSetupActivation | null => {
  if (row === undefined) return null;
  if (
    row.outcome === "pending" ||
    row.outcome === "provisioning_failed" ||
    row.outcome === "provisioning_quarantined"
  ) {
    return { outcome: row.outcome };
  }
  if (row.outcome === "activated") {
    const connection = connectionRecord(row, "connection_");
    if (connection === null) {
      throw new Error("invalid activated WhatsApp Connection");
    }
    return { connection, outcome: "activated" };
  }

  const accountKeyCiphertext = bytes(row.account_key_ciphertext);
  const accountKeyVersion = positiveInteger(row.account_key_version);
  const setupKeyAccountVersion = positiveInteger(row.setup_key_account_version);
  const setupKeyVersion = positiveInteger(row.setup_key_version);
  const setupKeyNonce = bytes(row.setup_key_nonce);
  const setupKeyCiphertext = bytes(row.setup_key_ciphertext);
  const numberCiphertext = versionedCiphertext(
    row.number_ciphertext_version,
    row.number_key_version,
    row.number_nonce,
    row.number_ciphertext,
  );
  if (
    row.outcome !== "provisioned" ||
    typeof row.personal_account_id !== "string" ||
    typeof row.account_kms_key_id !== "string" ||
    accountKeyCiphertext === null ||
    accountKeyVersion === null ||
    setupKeyAccountVersion === null ||
    setupKeyVersion === null ||
    setupKeyNonce === null ||
    setupKeyCiphertext === null ||
    numberCiphertext === null
  ) {
    throw new Error("invalid Connection Setup activation material");
  }
  return {
    outcome: "provisioned",
    setup: {
      accountKey: {
        ciphertext: encodeBase64(accountKeyCiphertext),
        keyVersion: accountKeyVersion,
        kmsKeyId: row.account_kms_key_id,
        personalAccountId: row.personal_account_id,
        version: 1,
      },
      numberCiphertext,
      personalAccountId: row.personal_account_id,
      setupId,
      setupKey: {
        accountKeyVersion: setupKeyAccountVersion,
        ciphertext: encodeBase64(setupKeyCiphertext),
        connectionId: setupId,
        keyVersion: setupKeyVersion,
        nonce: encodeBase64(setupKeyNonce),
        personalAccountId: row.personal_account_id,
        version: 1,
      },
    },
  };
};

export const makeWhatsAppConnectionRepository = (
  provider: WhatsAppConnectionConnectionProvider,
): WhatsAppConnectionRepository => ({
  activate: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterPersonalAccountContext(connection, input.personalAccountId);
        const result = await connection.query<ConnectionRow>(
          `SELECT *
           FROM app_private.activate_connection_setup(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
           )`,
          [
            input.personalAccountId,
            input.setupId,
            input.connectionId,
            input.publicId,
            input.webhookIngressId,
            input.numberSuffix,
            input.connectedAt,
            input.accountKeyVersion,
            input.connectionKeyVersion,
            input.connectionKeyNonce,
            input.connectionKeyCiphertext,
            input.locatorCiphertextVersion,
            input.locatorKeyVersion,
            input.locatorNonce,
            input.locatorCiphertext,
            input.authorityCiphertextVersion,
            input.authorityKeyVersion,
            input.authorityNonce,
            input.authorityCiphertext,
            input.webhookSecretCiphertextVersion,
            input.webhookSecretKeyVersion,
            input.webhookSecretNonce,
            input.webhookSecretCiphertext,
          ],
        );
        const record = connectionRecord(result.rows[0]);
        if (record === null) {
          throw new Error("WhatsApp Connection activation unavailable");
        }
        return record;
      }),
    ),
  listForUser: (clerkUserId) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const loaded = await connection.query<{ personal_account_id: unknown }>(
          `SELECT app_private.load_whatsapp_connection_account($1)
             AS personal_account_id`,
          [clerkUserId],
        );
        const personalAccountId = loaded.rows[0]?.personal_account_id;
        if (typeof personalAccountId !== "string") return [];
        await enterPersonalAccountContext(connection, personalAccountId);
        const result = await connection.query<ConnectionRow>(
          `SELECT
             public_id,
             NULL::text AS display_name,
             number_suffix,
             state,
             state_changed_at
           FROM app.whatsapp_connections
           WHERE number_suffix IS NOT NULL
           ORDER BY created_at, public_id`,
        );
        return result.rows.map((row) => {
          const record = connectionRecord(row);
          if (record === null) {
            throw new Error("invalid persisted WhatsApp Connection");
          }
          return record;
        });
      }),
    ),
  loadSetupForActivation: (input) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<ActivationRow>(
        `SELECT *
         FROM app_private.load_connection_setup_for_activation($1, $2)`,
        [input.clerkUserId, input.setupId],
      );
      return activation(input.setupId, result.rows[0]);
    }),
});

const makePgConnectionProvider = (
  connectionString: string,
): WhatsAppConnectionConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: WhatsAppConnectionConnection) => Promise<Value>,
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

export const makePgWhatsAppConnectionRepository = (
  connectionString: string,
): WhatsAppConnectionRepository =>
  makeWhatsAppConnectionRepository(makePgConnectionProvider(connectionString));
