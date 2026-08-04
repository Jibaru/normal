import { and, eq, sql } from "drizzle-orm";
import { makeDatabase, makeQueryConnection } from "./database";
import {
  personalAccountsInApp,
  storedMediaInApp,
  storedMediaObjectDeletionsInApp,
} from "./schema";

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
  const db = makeDatabase(connection);
  await db.execute(sql`BEGIN`);
  try {
    const value = await use();
    await db.execute(sql`COMMIT`);
    return value;
  } catch (error) {
    await db.execute(sql`ROLLBACK`);
    throw error;
  }
};

const enterAccount = (connection: StoredMediaConnection, accountId: string) =>
  makeDatabase(connection).execute(
    sql`SELECT pg_catalog.set_config('public.personal_account_id', ${accountId}, true)`,
  );

export const makeStoredMediaRepository = (
  provider: StoredMediaConnectionProvider,
) => ({
  enqueueObjectDeletion: (input: StoredMediaObjectDeletion): Promise<void> =>
    provider.withConnection((connection) =>
      transaction(connection, async () => {
        await enterAccount(connection, input.personalAccountId);
        await makeDatabase(connection)
          .insert(storedMediaObjectDeletionsInApp)
          .values({
            personalAccountId: input.personalAccountId,
            objectKey: input.objectKey,
          })
          .onConflictDoNothing();
      }),
    ),
  finishObjectDeletion: (input: StoredMediaObjectDeletion): Promise<void> =>
    provider.withConnection((connection) =>
      transaction(connection, async () => {
        await enterAccount(connection, input.personalAccountId);
        await makeDatabase(connection).execute(
          sql`SELECT public.finish_stored_media_object_deletion(
            ${input.personalAccountId}, ${input.objectKey}
          )`,
        );
      }),
    ),
  listObjectDeletions: (
    limit: number,
  ): Promise<ReadonlyArray<StoredMediaObjectDeletion>> =>
    provider.withConnection(async (connection) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("invalid Stored Media deletion limit");
      const result = await makeDatabase(connection).execute(sql`
        SELECT * FROM public.list_stored_media_object_deletions(${limit})
      `);
      return result.map((row) => {
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
      const result = await makeDatabase(connection).execute(sql`
        SELECT * FROM public.list_pending_stored_media(${limit})
      `);
      return result.map(pendingCandidate);
    }),
  createPending: (input: CreatePendingStoredMediaInput): Promise<boolean> =>
    provider.withConnection((connection) =>
      transaction(connection, async () => {
        await enterAccount(connection, input.personalAccountId);
        const result = await makeDatabase(connection)
          .insert(storedMediaInApp)
          .values({
            id: input.id,
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.whatsappConnectionId,
            storedMessageId: input.storedMessageId,
            publicId: input.publicId,
            state: "pending",
            mediaType: input.mediaType,
            sourceCiphertextVersion: input.source.version,
            sourceKeyVersion: input.source.keyVersion,
            sourceNonce: decode(
              input.source.nonce,
              "Stored Media source nonce",
            ),
            sourceCiphertext: decode(
              input.source.ciphertext,
              "Stored Media source ciphertext",
            ),
          })
          .onConflictDoNothing({
            target: [
              storedMediaInApp.personalAccountId,
              storedMediaInApp.whatsappConnectionId,
              storedMediaInApp.storedMessageId,
            ],
          })
          .returning({ id: storedMediaInApp.id });
        return result.length === 1;
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
        const db = makeDatabase(connection);
        const account = await db
          .select({
            available: sql<number>`${personalAccountsInApp.storedMediaLimitBytes} - ${personalAccountsInApp.storedMediaUsedBytes}`,
          })
          .from(personalAccountsInApp)
          .where(eq(personalAccountsInApp.id, input.personalAccountId))
          .for("update");
        const media = await db
          .select({ state: storedMediaInApp.state })
          .from(storedMediaInApp)
          .where(
            and(
              eq(storedMediaInApp.personalAccountId, input.personalAccountId),
              eq(storedMediaInApp.id, input.id),
            ),
          )
          .for("update");
        if (media[0]?.state !== "pending") return "already_terminal";
        const available = Number(account[0]?.available);
        if (!Number.isSafeInteger(available))
          throw new Error("invalid Stored Media quota");
        if (available < input.plaintextSizeBytes) {
          await makeDatabase(connection)
            .update(storedMediaInApp)
            .set({
              state: "failed",
              failureCode: "quota_exceeded",
              sourceCiphertextVersion: null,
              sourceKeyVersion: null,
              sourceNonce: null,
              sourceCiphertext: null,
              updatedAt: sql`transaction_timestamp()`,
            })
            .where(
              and(
                eq(storedMediaInApp.personalAccountId, input.personalAccountId),
                eq(storedMediaInApp.id, input.id),
              ),
            );
          return "quota_exceeded";
        }
        await db
          .update(personalAccountsInApp)
          .set({
            storedMediaUsedBytes: sql`${personalAccountsInApp.storedMediaUsedBytes} + ${input.plaintextSizeBytes}`,
          })
          .where(eq(personalAccountsInApp.id, input.personalAccountId));
        await db
          .update(storedMediaInApp)
          .set({
            state: "ready",
            objectKey: input.objectKey,
            plaintextSizeBytes: input.plaintextSizeBytes,
            sha256: input.sha256,
            metadataCiphertextVersion: input.metadata.version,
            metadataKeyVersion: input.metadata.keyVersion,
            metadataNonce: decode(
              input.metadata.nonce,
              "Stored Media metadata nonce",
            ),
            metadataCiphertext: decode(
              input.metadata.ciphertext,
              "Stored Media metadata ciphertext",
            ),
            sourceCiphertextVersion: null,
            sourceKeyVersion: null,
            sourceNonce: null,
            sourceCiphertext: null,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(
            and(
              eq(storedMediaInApp.personalAccountId, input.personalAccountId),
              eq(storedMediaInApp.id, input.id),
            ),
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
        const result = await makeDatabase(connection)
          .update(storedMediaInApp)
          .set({
            state: input.code === "policy_rejected" ? "rejected" : "failed",
            failureCode: input.code,
            sourceCiphertextVersion: null,
            sourceKeyVersion: null,
            sourceNonce: null,
            sourceCiphertext: null,
            objectKey: null,
            plaintextSizeBytes: null,
            sha256: null,
            metadataCiphertextVersion: null,
            metadataKeyVersion: null,
            metadataNonce: null,
            metadataCiphertext: null,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(
            and(
              eq(storedMediaInApp.personalAccountId, input.personalAccountId),
              eq(storedMediaInApp.id, input.id),
              eq(storedMediaInApp.state, "pending"),
            ),
          )
          .returning({ id: storedMediaInApp.id });
        return result.length === 1;
      }),
    ),

  markObjectMissing: (input: {
    readonly id: string;
    readonly personalAccountId: string;
  }): Promise<boolean> =>
    provider.withConnection((connection) =>
      transaction(connection, async () => {
        await enterAccount(connection, input.personalAccountId);
        const db = makeDatabase(connection);
        const media = await db
          .select({ plaintextSizeBytes: storedMediaInApp.plaintextSizeBytes })
          .from(storedMediaInApp)
          .where(
            and(
              eq(storedMediaInApp.personalAccountId, input.personalAccountId),
              eq(storedMediaInApp.id, input.id),
              eq(storedMediaInApp.state, "ready"),
            ),
          )
          .for("update");
        const plaintextSizeBytes = media[0]?.plaintextSizeBytes;
        if (plaintextSizeBytes == null) return false;
        await db
          .update(personalAccountsInApp)
          .set({
            storedMediaUsedBytes: sql`${personalAccountsInApp.storedMediaUsedBytes} - ${plaintextSizeBytes}`,
          })
          .where(eq(personalAccountsInApp.id, input.personalAccountId));
        const result = await db
          .update(storedMediaInApp)
          .set({
            state: "failed",
            failureCode: "object_missing",
            objectKey: null,
            plaintextSizeBytes: null,
            sha256: null,
            metadataCiphertextVersion: null,
            metadataKeyVersion: null,
            metadataNonce: null,
            metadataCiphertext: null,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(
            and(
              eq(storedMediaInApp.personalAccountId, input.personalAccountId),
              eq(storedMediaInApp.id, input.id),
              eq(storedMediaInApp.state, "ready"),
            ),
          )
          .returning({ id: storedMediaInApp.id });
        return result.length === 1;
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
