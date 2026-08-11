import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type MessageSearchConnectionProvider,
  makeMessageSearchRepository,
} from "../src/message-search";
import { runMigrations } from "../src/migrations";

const accountA = "10000000-0000-4000-8000-000000000061";
const accountB = "10000000-0000-4000-8000-000000000062";
const connectionA = "20000000-0000-4000-8000-000000000061";
const connectionB = "20000000-0000-4000-8000-000000000062";
const conversationA = "40000000-0000-4000-8000-000000000061";
const conversationB = "40000000-0000-4000-8000-000000000062";
const installedAt = "2026-08-01T12:10:00.000Z";
const equalSentAt = "2026-08-01T12:03:00.000Z";
const tokenA = `msi1_${"A".repeat(43)}`;
const tokenB = `msi1_${"B".repeat(43)}`;

const messageId = (suffix: string) =>
  `50000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const messagePublicId = (suffix: string) => `msg_${suffix.padStart(21, "0")}`;
const messageIdentity = (suffix: string) => `wi1_${suffix.padStart(43, "0")}`;

describe("Message Search backfill repository", () => {
  let database: PGlite;
  let provider: MessageSearchConnectionProvider;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE neon_superuser NOLOGIN BYPASSRLS;
      CREATE ROLE whatsapp_api_runtime LOGIN;
      CREATE ROLE whatsapp_webhook_runtime LOGIN;
      GRANT neon_superuser TO whatsapp_api_runtime;
      GRANT neon_superuser TO whatsapp_webhook_runtime;
    `);
    await runMigrations(database);

    await database.query(
      `INSERT INTO public.personal_accounts (id, state)
       VALUES ($1, 'active'), ($2, 'active')`,
      [accountA, accountB],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id, public_id, number_suffix,
         state, state_changed_at, created_at
       ) VALUES
         ($1, $2, '30000000-0000-4000-8000-000000000061',
          'con_000000000000000000061', '0061', 'connected',
          '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z'),
         ($3, $4, '30000000-0000-4000-8000-000000000062',
          'con_000000000000000000062', '0062', 'connected',
          '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z')`,
      [connectionA, accountA, connectionB, accountB],
    );
    await database.query(
      `INSERT INTO public.personal_account_key_envelopes
         (personal_account_id, key_version, kms_key_id, ciphertext)
       VALUES
         ($1, 1, 'kms-account-a', decode('0102', 'hex')),
         ($2, 1, 'kms-account-b', decode('0304', 'hex'))`,
      [accountA, accountB],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_key_envelopes
         (personal_account_id, whatsapp_connection_id, account_key_version,
          key_version, nonce, ciphertext)
       VALUES
         ($1, $2, 1, 1, decode(repeat('05', 12), 'hex'), decode(repeat('06', 32), 'hex')),
         ($3, $4, 1, 1, decode(repeat('07', 12), 'hex'), decode(repeat('08', 32), 'hex'))`,
      [accountA, connectionA, accountB, connectionB],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_secrets
         (personal_account_id, whatsapp_connection_id, credential_ciphertext,
          credential_ciphertext_version, credential_key_version, credential_nonce)
       VALUES
         ($1, $2, decode(repeat('09', 32), 'hex'), 1, 1, decode(repeat('0a', 12), 'hex')),
         ($3, $4, decode(repeat('0b', 32), 'hex'), 1, 1, decode(repeat('0c', 12), 'hex'))`,
      [accountA, connectionA, accountB, connectionB],
    );
    await database.query(
      `INSERT INTO public.message_search_backfill_coverage
         (personal_account_id, whatsapp_connection_id, index_version, state, updated_at)
       VALUES
         ($1, $2, 1, 'pending', '2026-08-01T12:00:00Z'),
         ($3, $4, 1, 'pending', '2026-08-01T12:01:00Z')`,
      [accountA, connectionA, accountB, connectionB],
    );
    await database.query(
      `INSERT INTO public.whatsapp_conversations
         (id, personal_account_id, whatsapp_connection_id, public_id, kind,
          recipient_locator, recipient_public_id, last_activity_at,
          last_activity_direction)
       VALUES
         ($1, $2, $3, 'cvs_000000000000000000061', 'direct',
          $4, 'ctc_000000000000000000061', '2026-08-01T12:00:00Z', 'inbound'),
         ($5, $6, $7, 'cvs_000000000000000000062', 'direct',
          $8, 'ctc_000000000000000000062', '2026-08-01T12:00:00Z', 'inbound')`,
      [
        conversationA,
        accountA,
        connectionA,
        messageIdentity("61"),
        conversationB,
        accountB,
        connectionB,
        messageIdentity("62"),
      ],
    );

    provider = {
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
  });

  afterEach(async () => database.close());

  test("loads encryption material only within the requested Personal Account", async () => {
    const repository = makeMessageSearchRepository(provider);

    expect(
      await repository.loadEncryptionMaterial({
        personalAccountId: accountA,
        whatsappConnectionId: connectionA,
      }),
    ).toMatchObject({
      accountKey: { keyVersion: 1, kmsKeyId: "kms-account-a" },
      connectionKey: { accountKeyVersion: 1, keyVersion: 1 },
      messageSearchKey: null,
    });
    expect(
      await repository.loadEncryptionMaterial({
        personalAccountId: accountA,
        whatsappConnectionId: connectionB,
      }),
    ).toBeNull();
  });

  test("backfills bounded candidates with honest coverage through completion", async () => {
    const repository = makeMessageSearchRepository(provider);
    const retained = [
      { id: messageId("611"), sentAt: "2026-08-01T12:04:00.000Z" },
      { id: messageId("614"), sentAt: equalSentAt },
      { id: messageId("613"), sentAt: equalSentAt },
      { id: messageId("612"), sentAt: equalSentAt },
    ] as const;
    const excluded = [
      {
        id: messageId("615"),
        lifecycle: "deleted",
        sentAt: "2026-08-01T12:05:00.000Z",
      },
      {
        id: messageId("616"),
        lifecycle: "expired",
        sentAt: "2026-08-01T12:02:00.000Z",
      },
    ] as const;

    for (const [index, message] of [...retained, ...excluded].entries()) {
      await database.query(
        `INSERT INTO public.stored_messages
           (id, personal_account_id, whatsapp_connection_id, conversation_id,
            public_id, message_identity, direction, sent_at, content_type,
            content_ciphertext_version, content_key_version, content_nonce,
            content_ciphertext, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'inbound', $7, 'text', 1, 1,
           decode(repeat('0d', 12), 'hex'), decode(repeat('0e', 32), 'hex'), $7)`,
        [
          message.id,
          accountA,
          connectionA,
          conversationA,
          messagePublicId(String(611 + index)),
          messageIdentity(String(611 + index)),
          message.sentAt,
        ],
      );
    }
    await database.query(
      `UPDATE public.stored_messages SET deleted_at='2026-08-01T12:06:00Z',
         content_type=NULL, content_ciphertext_version=NULL, content_key_version=NULL,
         content_nonce=NULL, content_ciphertext=NULL
       WHERE id=$1`,
      [excluded[0].id],
    );
    await database.query(
      `UPDATE public.stored_messages SET content_expired_at='2026-08-01T12:06:00Z',
         content_type=NULL, content_ciphertext_version=NULL, content_key_version=NULL,
         content_nonce=NULL, content_ciphertext=NULL
       WHERE id=$1`,
      [excluded[1].id],
    );

    expect(await repository.listPendingConnections(1)).toEqual([
      { personalAccountId: accountA, whatsappConnectionId: connectionA },
    ]);
    expect(await repository.listPendingConnections(100)).toHaveLength(2);

    expect(
      await repository.installKey({
        installedAt,
        key: {
          ciphertext: new Uint8Array(32).fill(15),
          keyVersion: 1,
          nonce: new Uint8Array(12).fill(16),
          version: 1,
        },
        personalAccountId: accountA,
        whatsappConnectionId: connectionA,
      }),
    ).toBe(true);
    expect(
      await repository.installKey({
        installedAt,
        key: {
          ciphertext: new Uint8Array(32).fill(17),
          keyVersion: 1,
          nonce: new Uint8Array(12).fill(18),
          version: 1,
        },
        personalAccountId: accountA,
        whatsappConnectionId: connectionA,
      }),
    ).toBe(false);

    const initialCoverage = await database.query<{
      searchable_from: Date;
      state: string;
    }>(
      `SELECT searchable_from, state FROM public.message_search_backfill_coverage
       WHERE personal_account_id=$1 AND whatsapp_connection_id=$2`,
      [accountA, connectionA],
    );
    expect(initialCoverage.rows).toEqual([
      { searchable_from: new Date(installedAt), state: "pending" },
    ]);

    const first = await repository.loadCandidates({
      limit: 2,
      personalAccountId: accountA,
      whatsappConnectionId: connectionA,
    });
    expect(first.state).toBe("pending");
    expect(first.candidates.map(({ messageId: id }) => id)).toEqual([
      retained[0].id,
      retained[1].id,
    ]);
    expect(
      first.candidates.some(({ messageId: id }) =>
        excluded.some((message) => message.id === id),
      ),
    ).toBe(false);

    expect(
      await repository.commitBatch({
        committedAt: "2026-08-01T12:11:00.000Z",
        personalAccountId: accountA,
        tokens: first.candidates.map((candidate, index) => ({
          messageId: candidate.messageId,
          sentAt: candidate.sentAt,
          tokens: index === 0 ? [tokenA, tokenB] : [tokenA],
        })),
        whatsappConnectionId: connectionA,
      }),
    ).toEqual({ state: "pending" });

    const partialCoverage = await database.query<{
      excludes_equal_timestamp: boolean;
      state: string;
    }>(
      `SELECT state, searchable_from > $3::timestamptz AS excludes_equal_timestamp
       FROM public.message_search_backfill_coverage
       WHERE personal_account_id=$1 AND whatsapp_connection_id=$2`,
      [accountA, connectionA, equalSentAt],
    );
    expect(partialCoverage.rows).toEqual([
      { excludes_equal_timestamp: true, state: "pending" },
    ]);

    const committed = await database.query<{
      message_search_index_version: number;
      tokens_committed: boolean;
    }>(
      `SELECT message_search_index_version,
         message_search_tokens = ARRAY[$2, $3]::public.message_search_token[]
           AS tokens_committed
       FROM public.stored_messages WHERE id=$1`,
      [retained[0].id, tokenA, tokenB],
    );
    expect(committed.rows).toEqual([
      {
        message_search_index_version: 1,
        tokens_committed: true,
      },
    ]);

    const second = await repository.loadCandidates({
      limit: 2,
      personalAccountId: accountA,
      whatsappConnectionId: connectionA,
    });
    expect(second.candidates.map(({ messageId: id }) => id)).toEqual([
      retained[2].id,
      retained[3].id,
    ]);
    expect(
      await repository.commitBatch({
        committedAt: "2026-08-01T12:12:00.000Z",
        personalAccountId: accountA,
        tokens: second.candidates.map((candidate) => ({
          messageId: candidate.messageId,
          sentAt: candidate.sentAt,
          tokens: [tokenB],
        })),
        whatsappConnectionId: connectionA,
      }),
    ).toEqual({ state: "complete" });
    expect(
      await repository.loadCandidates({
        limit: 2,
        personalAccountId: accountA,
        whatsappConnectionId: connectionA,
      }),
    ).toEqual({ candidates: [], state: "complete" });

    const finalCoverage = await database.query<{
      cursor_message_id: string | null;
      cursor_sent_at: Date | null;
      searchable_from: Date;
      state: string;
    }>(
      `SELECT state, searchable_from, cursor_sent_at, cursor_message_id
       FROM public.message_search_backfill_coverage
       WHERE personal_account_id=$1 AND whatsapp_connection_id=$2`,
      [accountA, connectionA],
    );
    expect(finalCoverage.rows).toEqual([
      {
        cursor_message_id: null,
        cursor_sent_at: null,
        searchable_from: new Date(equalSentAt),
        state: "complete",
      },
    ]);
    expect(await repository.listPendingConnections(100)).toEqual([
      { personalAccountId: accountB, whatsappConnectionId: connectionB },
    ]);
  });
});
