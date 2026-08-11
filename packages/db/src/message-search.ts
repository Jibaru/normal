import { and, eq, sql } from "drizzle-orm";
import { type Database, withPgQueryConnection } from "./database";
import {
  messageSearchBackfillCoverageInApp,
  storedMessagesInApp,
  whatsappConnectionSecretsInApp,
  whatsappConnectionsInApp,
} from "./schema";
import { withTransaction } from "./transaction";

export interface MessageSearchCiphertext {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
  readonly version: 1;
}

export interface MessageSearchBackfillCandidate {
  readonly content: MessageSearchCiphertext;
  readonly messageId: string;
  readonly messageIdentity: string;
  readonly sentAt: string;
}

export interface MessageSearchBackfillBatch {
  readonly candidates: ReadonlyArray<MessageSearchBackfillCandidate>;
  readonly state: "complete" | "pending";
}

export interface MessageSearchEncryptionMaterial {
  readonly accountKey: {
    readonly ciphertext: Uint8Array;
    readonly keyVersion: number;
    readonly kmsKeyId: string;
  };
  readonly connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: Uint8Array;
    readonly keyVersion: number;
    readonly nonce: Uint8Array;
  };
  readonly messageSearchKey: MessageSearchCiphertext | null;
}

export interface MessageSearchBackfillConnection {
  readonly personalAccountId: string;
  readonly whatsappConnectionId: string;
}

export interface MessageSearchConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: {
      readonly query: <
        Row extends Record<string, unknown> = Record<string, unknown>,
      >(
        text: string,
        values?: Array<unknown>,
      ) => Promise<{ readonly rows: Array<Row> }>;
    }) => Promise<Value>,
  ) => Promise<Value>;
}

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  throw new Error("invalid message-search ciphertext");
};

const timestamp = (value: unknown): string => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.valueOf())) throw new Error("invalid timestamp");
  return parsed.toISOString();
};

const enterTenant = (db: Database, personalAccountId: string) =>
  db.execute(
    sql`select set_config('public.personal_account_id', ${personalAccountId}, true)`,
  );

const validateTokens = (tokens: ReadonlyArray<string>): Array<string> => {
  if (
    new Set(tokens).size !== tokens.length ||
    tokens.some((token) => !/^msi1_[A-Za-z0-9_-]{43}$/u.test(token))
  ) {
    throw new Error("invalid message-search tokens");
  }
  return [...tokens];
};

export const makeMessageSearchRepository = (
  provider: MessageSearchConnectionProvider,
) => ({
  listPendingConnections: (
    limit: number,
  ): Promise<ReadonlyArray<MessageSearchBackfillConnection>> =>
    provider.withConnection(async (connection) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("invalid message-search connection limit");
      const result = await connection.query<Record<string, unknown>>(
        "SELECT * FROM public.list_message_search_backfill_connections($1)",
        [limit],
      );
      return result.rows.map((row) => {
        if (
          typeof row.personal_account_id !== "string" ||
          typeof row.whatsapp_connection_id !== "string"
        )
          throw new Error("invalid message-search backfill connection");
        return {
          personalAccountId: row.personal_account_id,
          whatsappConnectionId: row.whatsapp_connection_id,
        };
      });
    }),
  loadEncryptionMaterial: (input: {
    readonly personalAccountId: string;
    readonly whatsappConnectionId: string;
  }): Promise<MessageSearchEncryptionMaterial | null> =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        await enterTenant(db, input.personalAccountId);
        const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT account_keys.key_version AS account_key_version,
          account_keys.kms_key_id, account_keys.ciphertext AS account_key_ciphertext,
          connection_keys.account_key_version AS connection_account_key_version,
          connection_keys.key_version AS connection_key_version,
          connection_keys.nonce AS connection_key_nonce,
          connection_keys.ciphertext AS connection_key_ciphertext,
          secrets.message_search_key_ciphertext_version,
          secrets.message_search_key_version, secrets.message_search_key_nonce,
          secrets.message_search_key_ciphertext
        FROM public.whatsapp_connections connections
        JOIN public.personal_accounts accounts
          ON accounts.id=connections.personal_account_id AND accounts.state='active'
        JOIN public.personal_account_key_envelopes account_keys
          ON account_keys.personal_account_id=connections.personal_account_id
          AND account_keys.unavailable_at IS NULL
        JOIN public.whatsapp_connection_key_envelopes connection_keys
          ON connection_keys.personal_account_id=connections.personal_account_id
          AND connection_keys.whatsapp_connection_id=connections.id
          AND connection_keys.account_key_version=account_keys.key_version
          AND connection_keys.unavailable_at IS NULL
        JOIN public.whatsapp_connection_secrets secrets
          ON secrets.personal_account_id=connections.personal_account_id
          AND secrets.whatsapp_connection_id=connections.id
        WHERE connections.personal_account_id=${input.personalAccountId}
          AND connections.id=${input.whatsappConnectionId}
          AND connections.state<>'deleting'
      `);
        const row = rows[0];
        if (row === undefined) return null;
        const searchCiphertext = row.message_search_key_ciphertext;
        return {
          accountKey: {
            ciphertext: bytes(row.account_key_ciphertext),
            keyVersion: Number(row.account_key_version),
            kmsKeyId: String(row.kms_key_id),
          },
          connectionKey: {
            accountKeyVersion: Number(row.connection_account_key_version),
            ciphertext: bytes(row.connection_key_ciphertext),
            keyVersion: Number(row.connection_key_version),
            nonce: bytes(row.connection_key_nonce),
          },
          messageSearchKey:
            searchCiphertext === null
              ? null
              : {
                  ciphertext: bytes(searchCiphertext),
                  keyVersion: Number(row.message_search_key_version),
                  nonce: bytes(row.message_search_key_nonce),
                  version: 1,
                },
        };
      }),
    ),

  installKey: (input: {
    readonly installedAt: string;
    readonly key: MessageSearchCiphertext;
    readonly personalAccountId: string;
    readonly whatsappConnectionId: string;
  }) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        await enterTenant(db, input.personalAccountId);
        if (
          input.key.version !== 1 ||
          input.key.keyVersion < 1 ||
          input.key.nonce.byteLength !== 12 ||
          input.key.ciphertext.byteLength <= 16
        ) {
          throw new Error("invalid message-search key");
        }
        const installed = await db
          .update(whatsappConnectionSecretsInApp)
          .set({
            messageSearchKeyCiphertextVersion: 1,
            messageSearchKeyVersion: input.key.keyVersion,
            messageSearchKeyNonce: input.key.nonce,
            messageSearchKeyCiphertext: input.key.ciphertext,
            updatedAt: input.installedAt,
          })
          .where(
            and(
              eq(
                whatsappConnectionSecretsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                whatsappConnectionSecretsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              sql`${whatsappConnectionSecretsInApp.messageSearchKeyCiphertext} IS NULL`,
              sql`exists (select 1 from ${whatsappConnectionsInApp} connections where
                connections.personal_account_id = ${input.personalAccountId}
                and connections.id = ${input.whatsappConnectionId}
                and connections.state <> 'deleting')`,
            ),
          )
          .returning({
            id: whatsappConnectionSecretsInApp.whatsappConnectionId,
          });
        if (installed.length !== 1) return false;
        await db
          .insert(messageSearchBackfillCoverageInApp)
          .values({
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.whatsappConnectionId,
            indexVersion: 1,
            state: "pending",
            updatedAt: input.installedAt,
          })
          .onConflictDoUpdate({
            target: [
              messageSearchBackfillCoverageInApp.personalAccountId,
              messageSearchBackfillCoverageInApp.whatsappConnectionId,
              messageSearchBackfillCoverageInApp.indexVersion,
            ],
            set: {
              state: "pending",
              searchableFrom: input.installedAt,
              cursorSentAt: null,
              cursorMessageId: null,
              updatedAt: input.installedAt,
            },
          });
        return true;
      }),
    ),

  loadCandidates: (input: {
    readonly limit: number;
    readonly personalAccountId: string;
    readonly whatsappConnectionId: string;
  }): Promise<MessageSearchBackfillBatch> =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        if (
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 100
        ) {
          throw new Error("invalid message-search backfill limit");
        }
        await enterTenant(db, input.personalAccountId);
        const coverage = await db
          .select({
            cursorMessageId: messageSearchBackfillCoverageInApp.cursorMessageId,
            cursorSentAt: messageSearchBackfillCoverageInApp.cursorSentAt,
            state: messageSearchBackfillCoverageInApp.state,
          })
          .from(messageSearchBackfillCoverageInApp)
          .innerJoin(
            whatsappConnectionSecretsInApp,
            and(
              eq(
                whatsappConnectionSecretsInApp.personalAccountId,
                messageSearchBackfillCoverageInApp.personalAccountId,
              ),
              eq(
                whatsappConnectionSecretsInApp.whatsappConnectionId,
                messageSearchBackfillCoverageInApp.whatsappConnectionId,
              ),
              sql`${whatsappConnectionSecretsInApp.messageSearchKeyCiphertext} IS NOT NULL`,
            ),
          )
          .where(
            and(
              eq(
                messageSearchBackfillCoverageInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                messageSearchBackfillCoverageInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(messageSearchBackfillCoverageInApp.indexVersion, 1),
            ),
          )
          .for("update");
        const current = coverage[0];
        if (current === undefined)
          throw new Error("message-search backfill unavailable");
        if (current.state === "complete")
          return { candidates: [], state: "complete" };
        const rows = await db.execute<Record<string, unknown>>(sql`
          SELECT id, message_identity, sent_at, content_ciphertext_version,
            content_key_version, content_nonce, content_ciphertext
          FROM public.stored_messages
          WHERE personal_account_id = ${input.personalAccountId}
            AND whatsapp_connection_id = ${input.whatsappConnectionId}
            AND deleted_at IS NULL AND content_expired_at IS NULL
            AND message_search_index_version IS NULL
            AND (${current.cursorSentAt}::timestamptz IS NULL OR
              (sent_at, id) < (${current.cursorSentAt}::timestamptz, ${current.cursorMessageId}::uuid))
          ORDER BY sent_at DESC, id DESC LIMIT ${input.limit}
        `);
        return {
          candidates: rows.map((row) => ({
            content: {
              ciphertext: bytes(row.content_ciphertext),
              keyVersion: Number(row.content_key_version),
              nonce: bytes(row.content_nonce),
              version: 1,
            },
            messageId: String(row.id),
            messageIdentity: String(row.message_identity),
            sentAt: timestamp(row.sent_at),
          })),
          state: "pending",
        };
      }),
    ),

  commitBatch: (input: {
    readonly committedAt: string;
    readonly personalAccountId: string;
    readonly tokens: ReadonlyArray<{
      readonly messageId: string;
      readonly sentAt: string;
      readonly tokens: ReadonlyArray<string>;
    }>;
    readonly whatsappConnectionId: string;
  }) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        await enterTenant(db, input.personalAccountId);
        const coverage = await db
          .select({ state: messageSearchBackfillCoverageInApp.state })
          .from(messageSearchBackfillCoverageInApp)
          .where(
            and(
              eq(
                messageSearchBackfillCoverageInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                messageSearchBackfillCoverageInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(messageSearchBackfillCoverageInApp.indexVersion, 1),
            ),
          )
          .for("update");
        if (coverage[0]?.state !== "pending") {
          throw new Error("message-search backfill is not pending");
        }
        const ordered = [...input.tokens].sort(
          (left, right) =>
            right.sentAt.localeCompare(left.sentAt) ||
            right.messageId.localeCompare(left.messageId),
        );
        for (const item of ordered) {
          const updated = await db
            .update(storedMessagesInApp)
            .set({
              messageSearchIndexVersion: 1,
              messageSearchTokens: validateTokens(item.tokens),
            })
            .where(
              and(
                eq(
                  storedMessagesInApp.personalAccountId,
                  input.personalAccountId,
                ),
                eq(
                  storedMessagesInApp.whatsappConnectionId,
                  input.whatsappConnectionId,
                ),
                eq(storedMessagesInApp.id, item.messageId),
                eq(storedMessagesInApp.sentAt, item.sentAt),
                sql`${storedMessagesInApp.deletedAt} IS NULL`,
                sql`${storedMessagesInApp.contentExpiredAt} IS NULL`,
                sql`${storedMessagesInApp.messageSearchIndexVersion} IS NULL`,
              ),
            )
            .returning({ id: storedMessagesInApp.id });
          if (updated.length !== 1)
            throw new Error("message-search candidate changed");
        }
        const last = ordered.at(-1);
        const remaining = await db.execute<{ exists: unknown }>(sql`
          SELECT EXISTS (
            SELECT 1 FROM public.stored_messages
            WHERE personal_account_id = ${input.personalAccountId}
              AND whatsapp_connection_id = ${input.whatsappConnectionId}
              AND deleted_at IS NULL AND content_expired_at IS NULL
              AND message_search_index_version IS NULL
              AND (${last?.sentAt ?? null}::timestamptz IS NULL OR
                (sent_at, id) < (${last?.sentAt ?? null}::timestamptz, ${last?.messageId ?? null}::uuid))
          ) AS exists
        `);
        const complete = remaining[0]?.exists === false;
        await db
          .update(messageSearchBackfillCoverageInApp)
          .set({
            state: complete ? "complete" : "pending",
            searchableFrom: complete
              ? sql`coalesce((select min(sent_at) from public.stored_messages where personal_account_id=${input.personalAccountId} and whatsapp_connection_id=${input.whatsappConnectionId} and deleted_at is null and content_expired_at is null), (select created_at from public.whatsapp_connections where personal_account_id=${input.personalAccountId} and id=${input.whatsappConnectionId}))`
              : last === undefined
                ? null
                : sql`${last.sentAt}::timestamptz + interval '1 microsecond'`,
            cursorSentAt: complete ? null : (last?.sentAt ?? null),
            cursorMessageId: complete ? null : (last?.messageId ?? null),
            updatedAt: input.committedAt,
          })
          .where(
            and(
              eq(
                messageSearchBackfillCoverageInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                messageSearchBackfillCoverageInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(messageSearchBackfillCoverageInApp.indexVersion, 1),
            ),
          );
        return {
          state: complete ? ("complete" as const) : ("pending" as const),
        };
      }),
    ),
});

export const makePgMessageSearchRepository = (connectionString: string) =>
  makeMessageSearchRepository({
    withConnection: (use) => withPgQueryConnection(connectionString, use),
  });
