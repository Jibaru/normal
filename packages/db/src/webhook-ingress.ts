import { sql } from "drizzle-orm";
import {
  makeDatabase,
  type QueryConnection,
  withPgQueryConnection,
} from "./database";

export interface WebhookIngressConnection extends QueryConnection {}

export interface WebhookIngressConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: WebhookIngressConnection) => Promise<Value>,
  ) => Promise<Value>;
}

export interface WebhookIngressMaterial {
  readonly accountKey: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly kmsKeyId: string;
    readonly personalAccountId: string;
    readonly version: 1;
  };
  readonly connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: string;
    readonly connectionId: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly personalAccountId: string;
    readonly version: 1;
  };
  readonly personalAccountId: string;
  readonly providerAuthority: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly version: 1;
  };
  readonly whatsappConnectionId: string;
}

export interface WebhookIngressRepository {
  readonly resolve: (
    webhookIngressId: string,
  ) => Promise<WebhookIngressMaterial | null>;
}

interface IngressRow extends Record<string, unknown> {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly account_kms_key_id: unknown;
  readonly authority_ciphertext: unknown;
  readonly authority_ciphertext_version: unknown;
  readonly authority_key_version: unknown;
  readonly authority_nonce: unknown;
  readonly connection_key_account_version: unknown;
  readonly connection_key_ciphertext: unknown;
  readonly connection_key_nonce: unknown;
  readonly connection_key_version: unknown;
  readonly personal_account_id: unknown;
  readonly whatsapp_connection_id: unknown;
}

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

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );

const material = (
  row: IngressRow | undefined,
): WebhookIngressMaterial | null => {
  if (row === undefined) return null;
  const accountKeyCiphertext = bytes(row.account_key_ciphertext);
  const accountKeyVersion = positiveInteger(row.account_key_version);
  const authorityCiphertext = bytes(row.authority_ciphertext);
  const authorityCiphertextVersion = positiveInteger(
    row.authority_ciphertext_version,
  );
  const authorityKeyVersion = positiveInteger(row.authority_key_version);
  const authorityNonce = bytes(row.authority_nonce);
  const connectionKeyAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const connectionKeyCiphertext = bytes(row.connection_key_ciphertext);
  const connectionKeyNonce = bytes(row.connection_key_nonce);
  const connectionKeyVersion = positiveInteger(row.connection_key_version);
  if (
    !uuid(row.personal_account_id) ||
    !uuid(row.whatsapp_connection_id) ||
    typeof row.account_kms_key_id !== "string" ||
    row.account_kms_key_id.length === 0 ||
    accountKeyCiphertext === null ||
    accountKeyVersion === null ||
    connectionKeyAccountVersion === null ||
    connectionKeyCiphertext === null ||
    connectionKeyNonce === null ||
    connectionKeyVersion === null ||
    authorityCiphertextVersion !== 1 ||
    authorityKeyVersion === null ||
    authorityNonce === null ||
    authorityCiphertext === null
  ) {
    throw new Error("invalid Webhook Event ingress material");
  }
  return {
    accountKey: {
      ciphertext: encodeBase64(accountKeyCiphertext),
      keyVersion: accountKeyVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    connectionKey: {
      accountKeyVersion: connectionKeyAccountVersion,
      ciphertext: encodeBase64(connectionKeyCiphertext),
      connectionId: row.whatsapp_connection_id,
      keyVersion: connectionKeyVersion,
      nonce: encodeBase64(connectionKeyNonce),
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    personalAccountId: row.personal_account_id,
    providerAuthority: {
      ciphertext: encodeBase64(authorityCiphertext),
      keyVersion: authorityKeyVersion,
      nonce: encodeBase64(authorityNonce),
      version: 1,
    },
    whatsappConnectionId: row.whatsapp_connection_id,
  };
};

export const makeWebhookIngressRepository = (
  provider: WebhookIngressConnectionProvider,
): WebhookIngressRepository => ({
  resolve: (webhookIngressId) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const result = await db.execute<IngressRow>(sql`
        SELECT * FROM public.bootstrap_whatsapp_connection_for_ingress(
          ${webhookIngressId}
        )
      `);
      return material(result[0]);
    }),
});

const makePgConnectionProvider = (
  connectionString: string,
): WebhookIngressConnectionProvider => ({
  withConnection: (use) => withPgQueryConnection(connectionString, use),
});

export const makePgWebhookIngressRepository = (
  connectionString: string,
): WebhookIngressRepository =>
  makeWebhookIngressRepository(makePgConnectionProvider(connectionString));
