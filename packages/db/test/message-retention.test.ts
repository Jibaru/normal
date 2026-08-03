import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeMessageRetentionRepository } from "../src/message-retention";
import { runMigrations } from "../src/migrations";
import { makeStoredMediaRepository } from "../src/stored-media";

const accountId = "10000000-0000-4000-8000-000000000052";
const connectionId = "20000000-0000-4000-8000-000000000052";
const connectionPublicId = "con_000000000000000000052";
const objectKey = "stored-media/retention-52";
const recipientLocator = `wi1_${"A".repeat(43)}`;
const messageIdentity = `wi1_${"B".repeat(43)}`;
const itemIdentity = `wi1_${"C".repeat(43)}`;

describe("Message Retention Policy persistence", () => {
  let database: PGlite;

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
      `SELECT * FROM app_private.admit_personal_account_for_clerk(
        'user_retention52',$1,1,'arn:aws:kms:us-east-1:111122223333:key/content',decode('0102','hex'),3
      )`,
      [accountId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connections(id,personal_account_id,webhook_ingress_id,public_id,
        number_suffix,state,state_changed_at,created_at)
       VALUES($1,$2,'30000000-0000-4000-8000-000000000052',$3,'0052','connected',
        '2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`,
      [connectionId, accountId, connectionPublicId],
    );
  });

  afterEach(async () => database.close());

  const provider = () => ({
    withConnection: async <Value>(
      use: (connection: PGlite) => Promise<Value>,
    ) => {
      await database.exec("SET ROLE whatsapp_api_runtime");
      try {
        return await use(database);
      } finally {
        await database.exec("RESET ROLE");
      }
    },
  });

  test("updates with optimistic concurrency and purges content before releasing media quota", async () => {
    const repository = makeMessageRetentionRepository(provider());
    expect(
      await repository.getForUser({
        clerkUserId: "user_retention52",
        connectionPublicId,
      }),
    ).toMatchObject({ days: 30 });
    expect(
      await repository.updateForUser({
        clerkUserId: "user_retention52",
        connectionPublicId,
        days: 7,
        expectedDays: 90,
        updatedAt: "2026-08-03T00:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      await repository.updateForUser({
        clerkUserId: "user_retention52",
        connectionPublicId,
        days: 7,
        expectedDays: 30,
        updatedAt: "2026-08-03T00:00:00.000Z",
      }),
    ).toMatchObject({ days: 7 });

    await database.query(
      `INSERT INTO app.whatsapp_conversations(id,personal_account_id,whatsapp_connection_id,
      public_id,kind,recipient_locator,recipient_public_id,last_activity_at,last_activity_direction)
      VALUES('40000000-0000-4000-8000-000000000052',$1,$2,'cvs_000000000000000000052','direct',
      $3,'ctc_000000000000000000052','2026-07-01T00:00:00Z','inbound')`,
      [accountId, connectionId, recipientLocator],
    );
    await database.query(
      `INSERT INTO app.stored_messages(id,personal_account_id,whatsapp_connection_id,conversation_id,
      public_id,message_identity,direction,sent_at,content_type,content_ciphertext_version,content_key_version,
      content_nonce,content_ciphertext,received_at,webhook_item_identity)
      VALUES('50000000-0000-4000-8000-000000000052',$1,$2,'40000000-0000-4000-8000-000000000052',
      'msg_000000000000000000052',$3,'inbound','2026-07-01T00:00:00Z','image',1,1,
      decode(repeat('01',12),'hex'),decode(repeat('02',17),'hex'),'2026-07-01T00:00:00Z',$4)`,
      [accountId, connectionId, messageIdentity, itemIdentity],
    );
    await database.query(
      "UPDATE app.personal_accounts SET stored_media_used_bytes=100 WHERE id=$1",
      [accountId],
    );
    await database.query(
      `INSERT INTO app.stored_media(id,personal_account_id,whatsapp_connection_id,stored_message_id,
      public_id,state,media_type,object_key,plaintext_size_bytes,sha256,metadata_ciphertext_version,metadata_key_version,
      metadata_nonce,metadata_ciphertext)
      VALUES('60000000-0000-4000-8000-000000000052',$1,$2,'50000000-0000-4000-8000-000000000052',
      'med_000000000000000000052','ready','image',$3,100,repeat('a',64),1,1,
      decode(repeat('03',12),'hex'),decode(repeat('04',17),'hex'))`,
      [accountId, connectionId, objectKey],
    );

    expect(await repository.purgeExpired("2026-08-03T00:00:00.000Z", 100)).toBe(
      1,
    );
    const unavailable = await database.query<{
      content_expired_at: Date;
      state: string;
      stored_media_used_bytes: number;
    }>(
      `SELECT messages.content_expired_at,media.state,accounts.stored_media_used_bytes
       FROM app.stored_messages messages JOIN app.stored_media media ON media.stored_message_id=messages.id
       JOIN app.personal_accounts accounts ON accounts.id=messages.personal_account_id`,
    );
    expect(unavailable.rows[0]).toMatchObject({
      state: "purging",
      stored_media_used_bytes: 100,
    });
    await database.query(
      `UPDATE app.stored_messages SET content_type='text',content_ciphertext_version=1,
       content_key_version=1,content_nonce=decode(repeat('05',12),'hex'),
       content_ciphertext=decode(repeat('06',17),'hex') WHERE id='50000000-0000-4000-8000-000000000052'`,
    );
    const terminal = await database.query<{
      content_ciphertext: Uint8Array | null;
    }>(
      "SELECT content_ciphertext FROM app.stored_messages WHERE id='50000000-0000-4000-8000-000000000052'",
    );
    expect(terminal.rows).toEqual([{ content_ciphertext: null }]);

    const media = makeStoredMediaRepository(provider());
    await media.finishObjectDeletion({
      personalAccountId: accountId,
      objectKey,
    });
    const released = await database.query<{
      media_count: number;
      stored_media_used_bytes: number;
    }>(
      `SELECT (SELECT count(*)::int FROM app.stored_media) media_count,stored_media_used_bytes
       FROM app.personal_accounts WHERE id=$1`,
      [accountId],
    );
    expect(released.rows).toEqual([
      { media_count: 0, stored_media_used_bytes: 0 },
    ]);
  });
});
