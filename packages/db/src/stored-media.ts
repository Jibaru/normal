import { makeQueryConnection } from "./database";

export interface StoredMediaConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface StoredMediaConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: StoredMediaConnection) => Promise<Value>,
  ) => Promise<Value>;
}

export interface StoredMediaCiphertext {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
}

export type StoredMediaType =
  | "audio"
  | "document"
  | "image"
  | "sticker"
  | "video";

export interface PendingStoredMediaCandidate {
  readonly accountKey: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly kmsKeyId: string;
    readonly personalAccountId: string;
    readonly version: 1;
  };
  readonly authority: StoredMediaCiphertext;
  readonly connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: string;
    readonly connectionId: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly personalAccountId: string;
    readonly version: 1;
  };
  readonly id: string;
  readonly mediaType: StoredMediaType;
  readonly personalAccountId: string;
  readonly source: StoredMediaCiphertext;
  readonly whatsappConnectionId: string;
}

export interface StoredMediaObjectDeletion {
  readonly objectKey: string;
  readonly personalAccountId: string;
}

export interface CreatePendingStoredMediaInput {
  readonly id: string;
  readonly mediaType: StoredMediaType;
  readonly personalAccountId: string;
  readonly publicId: string;
  readonly source: StoredMediaCiphertext;
  readonly storedMessageId: string;
  readonly whatsappConnectionId: string;
}

export interface FinalizeStoredMediaInput {
  readonly id: string;
  readonly metadata: StoredMediaCiphertext;
  readonly objectKey: string;
  readonly personalAccountId: string;
  readonly plaintextSizeBytes: number;
  readonly sha256: string;
}

export type FinalizeStoredMediaOutcome =
  | "already_terminal"
  | "quota_exceeded"
  | "ready";

const decode = (value: string, name: string): Uint8Array => {
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (bytes.byteLength === 0) throw new Error(`invalid ${name}`);
  return bytes;
};

const encode = (value: unknown, name: string): string => {
  if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value))
    throw new Error(`invalid ${name}`);
  return Buffer.from(value).toString("base64");
};

const positiveInteger = (value: unknown, name: string): number => {
  const parsed =
    typeof value === "bigint" || typeof value === "string"
      ? Number(value)
      : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`invalid ${name}`);
  return parsed;
};

const pendingCandidate = (
  row: Record<string, unknown>,
): PendingStoredMediaCandidate => {
  const personalAccountId = row.personal_account_id;
  const whatsappConnectionId = row.whatsapp_connection_id;
  const id = row.id;
  const mediaType = row.media_type;
  if (
    typeof personalAccountId !== "string" ||
    typeof whatsappConnectionId !== "string" ||
    typeof id !== "string" ||
    !["audio", "document", "image", "sticker", "video"].includes(
      String(mediaType),
    ) ||
    typeof row.account_kms_key_id !== "string"
  )
    throw new Error("invalid pending Stored Media candidate");
  const protectedValue = (
    prefix: "authority" | "source",
  ): StoredMediaCiphertext => {
    const version = positiveInteger(
      row[`${prefix}_ciphertext_version`],
      `${prefix} version`,
    );
    if (version !== 1) throw new Error(`invalid ${prefix} version`);
    return {
      ciphertext: encode(row[`${prefix}_ciphertext`], `${prefix} ciphertext`),
      keyVersion: positiveInteger(
        row[`${prefix}_key_version`],
        `${prefix} key version`,
      ),
      nonce: encode(row[`${prefix}_nonce`], `${prefix} nonce`),
      version: 1,
    };
  };
  return {
    accountKey: {
      ciphertext: encode(row.account_key_ciphertext, "account key ciphertext"),
      keyVersion: positiveInteger(
        row.account_key_version,
        "account key version",
      ),
      kmsKeyId: row.account_kms_key_id,
      personalAccountId,
      version: 1,
    },
    authority: protectedValue("authority"),
    connectionKey: {
      accountKeyVersion: positiveInteger(
        row.connection_key_account_version,
        "connection account key version",
      ),
      ciphertext: encode(
        row.connection_key_ciphertext,
        "connection key ciphertext",
      ),
      connectionId: whatsappConnectionId,
      keyVersion: positiveInteger(
        row.connection_key_version,
        "connection key version",
      ),
      nonce: encode(row.connection_key_nonce, "connection key nonce"),
      personalAccountId,
      version: 1,
    },
    id,
    mediaType: mediaType as StoredMediaType,
    personalAccountId,
    source: protectedValue("source"),
    whatsappConnectionId,
  };
};

const transaction = async <Value>(
  connection: StoredMediaConnection,
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

const enterAccount = (connection: StoredMediaConnection, accountId: string) =>
  connection.query(
    "SELECT pg_catalog.set_config('app.personal_account_id',$1,true)",
    [accountId],
  );

export const makeStoredMediaRepository = (
  provider: StoredMediaConnectionProvider,
) => ({
  enqueueObjectDeletion: (input: StoredMediaObjectDeletion): Promise<void> =>
    provider.withConnection((connection) =>
      transaction(connection, async () => {
        await enterAccount(connection, input.personalAccountId);
        await connection.query(
          `INSERT INTO app.stored_media_object_deletions(personal_account_id,object_key)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [input.personalAccountId, input.objectKey],
        );
      }),
    ),
  finishObjectDeletion: (input: StoredMediaObjectDeletion): Promise<void> =>
    provider.withConnection((connection) =>
      transaction(connection, async () => {
        await enterAccount(connection, input.personalAccountId);
        await connection.query(
          `SELECT app_private.finish_stored_media_object_deletion($1,$2)`,
          [input.personalAccountId, input.objectKey],
        );
      }),
    ),
  listObjectDeletions: (
    limit: number,
  ): Promise<ReadonlyArray<StoredMediaObjectDeletion>> =>
    provider.withConnection(async (connection) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("invalid Stored Media deletion limit");
      const result = await connection.query(
        "SELECT * FROM app_private.list_stored_media_object_deletions($1)",
        [limit],
      );
      return result.rows.map((row) => {
        if (
          typeof row.personal_account_id !== "string" ||
          typeof row.object_key !== "string"
        )
          throw new Error("invalid Stored Media object deletion");
        return {
          objectKey: row.object_key,
          personalAccountId: row.personal_account_id,
        };
      });
    }),
  listPending: (
    limit: number,
  ): Promise<ReadonlyArray<PendingStoredMediaCandidate>> =>
    provider.withConnection(async (connection) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("invalid pending Stored Media limit");
      const result = await connection.query(
        "SELECT * FROM app_private.list_pending_stored_media($1)",
        [limit],
      );
      return result.rows.map(pendingCandidate);
    }),
  createPending: (input: CreatePendingStoredMediaInput): Promise<boolean> =>
    provider.withConnection((connection) =>
      transaction(connection, async () => {
        await enterAccount(connection, input.personalAccountId);
        const result = await connection.query(
          `INSERT INTO app.stored_media (id,personal_account_id,whatsapp_connection_id,
             stored_message_id,public_id,state,media_type,source_ciphertext_version,
             source_key_version,source_nonce,source_ciphertext)
           VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10)
           ON CONFLICT (personal_account_id,whatsapp_connection_id,stored_message_id)
           DO NOTHING RETURNING id`,
          [
            input.id,
            input.personalAccountId,
            input.whatsappConnectionId,
            input.storedMessageId,
            input.publicId,
            input.mediaType,
            input.source.version,
            input.source.keyVersion,
            decode(input.source.nonce, "Stored Media source nonce"),
            decode(input.source.ciphertext, "Stored Media source ciphertext"),
          ],
        );
        return result.rows.length === 1;
      }),
    ),

  finalize: (
    input: FinalizeStoredMediaInput,
  ): Promise<FinalizeStoredMediaOutcome> =>
    provider.withConnection((connection) =>
      transaction(connection, async () => {
        if (
          !Number.isSafeInteger(input.plaintextSizeBytes) ||
          input.plaintextSizeBytes < 0
        )
          throw new Error("invalid Stored Media byte size");
        await enterAccount(connection, input.personalAccountId);
        const account = await connection.query<{ available: unknown }>(
          `SELECT stored_media_limit_bytes-stored_media_used_bytes AS available
             FROM app.personal_accounts WHERE id=$1 FOR UPDATE`,
          [input.personalAccountId],
        );
        const media = await connection.query<{ state: unknown }>(
          `SELECT state FROM app.stored_media WHERE personal_account_id=$1 AND id=$2 FOR UPDATE`,
          [input.personalAccountId, input.id],
        );
        if (media.rows[0]?.state !== "pending") return "already_terminal";
        const available = Number(account.rows[0]?.available);
        if (!Number.isSafeInteger(available))
          throw new Error("invalid Stored Media quota");
        if (available < input.plaintextSizeBytes) {
          await connection.query(
            `UPDATE app.stored_media SET state='failed',failure_code='quota_exceeded',
               source_ciphertext_version=NULL,source_key_version=NULL,source_nonce=NULL,
               source_ciphertext=NULL,updated_at=transaction_timestamp()
             WHERE personal_account_id=$1 AND id=$2`,
            [input.personalAccountId, input.id],
          );
          return "quota_exceeded";
        }
        await connection.query(
          `UPDATE app.personal_accounts SET stored_media_used_bytes=stored_media_used_bytes+$2
             WHERE id=$1`,
          [input.personalAccountId, input.plaintextSizeBytes],
        );
        await connection.query(
          `UPDATE app.stored_media SET state='ready',object_key=$3,plaintext_size_bytes=$4,
             sha256=$5,metadata_ciphertext_version=$6,metadata_key_version=$7,
             metadata_nonce=$8,metadata_ciphertext=$9,source_ciphertext_version=NULL,
             source_key_version=NULL,source_nonce=NULL,source_ciphertext=NULL,
             updated_at=transaction_timestamp()
           WHERE personal_account_id=$1 AND id=$2`,
          [
            input.personalAccountId,
            input.id,
            input.objectKey,
            input.plaintextSizeBytes,
            input.sha256,
            input.metadata.version,
            input.metadata.keyVersion,
            decode(input.metadata.nonce, "Stored Media metadata nonce"),
            decode(
              input.metadata.ciphertext,
              "Stored Media metadata ciphertext",
            ),
          ],
        );
        return "ready";
      }),
    ),

  fail: (input: {
    readonly code: "object_missing" | "policy_rejected" | "processing_failed";
    readonly id: string;
    readonly personalAccountId: string;
  }): Promise<boolean> =>
    provider.withConnection((connection) =>
      transaction(connection, async () => {
        await enterAccount(connection, input.personalAccountId);
        const result = await connection.query(
          `UPDATE app.stored_media SET state=CASE WHEN $3='policy_rejected' THEN 'rejected' ELSE 'failed' END,
             failure_code=$3,source_ciphertext_version=NULL,
             source_key_version=NULL,source_nonce=NULL,source_ciphertext=NULL,object_key=NULL,
             plaintext_size_bytes=NULL,sha256=NULL,metadata_ciphertext_version=NULL,
             metadata_key_version=NULL,metadata_nonce=NULL,metadata_ciphertext=NULL,
             updated_at=transaction_timestamp()
           WHERE personal_account_id=$1 AND id=$2 AND state='pending' RETURNING id`,
          [input.personalAccountId, input.id, input.code],
        );
        return result.rows.length === 1;
      }),
    ),

  markObjectMissing: (input: {
    readonly id: string;
    readonly personalAccountId: string;
  }): Promise<boolean> =>
    provider.withConnection((connection) =>
      transaction(connection, async () => {
        await enterAccount(connection, input.personalAccountId);
        await connection.query(
          `UPDATE app.personal_accounts accounts SET stored_media_used_bytes=
             stored_media_used_bytes-media.plaintext_size_bytes
           FROM app.stored_media media WHERE accounts.id=$1 AND media.personal_account_id=$1
             AND media.id=$2 AND media.state='ready'`,
          [input.personalAccountId, input.id],
        );
        const result = await connection.query(
          `UPDATE app.stored_media SET state='failed',failure_code='object_missing',
             object_key=NULL,plaintext_size_bytes=NULL,sha256=NULL,
             metadata_ciphertext_version=NULL,metadata_key_version=NULL,
             metadata_nonce=NULL,metadata_ciphertext=NULL,updated_at=transaction_timestamp()
           WHERE personal_account_id=$1 AND id=$2 AND state='ready' RETURNING id`,
          [input.personalAccountId, input.id],
        );
        return result.rows.length === 1;
      }),
    ),
});

const makePgConnectionProvider = (
  connectionString: string,
): StoredMediaConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: StoredMediaConnection) => Promise<Value>,
  ) => {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 70_000,
    });
    await client.connect();
    try {
      return await use(makeQueryConnection(client));
    } finally {
      await client.end();
    }
  },
});

export const makePgStoredMediaRepository = (connectionString: string) =>
  makeStoredMediaRepository(makePgConnectionProvider(connectionString));
