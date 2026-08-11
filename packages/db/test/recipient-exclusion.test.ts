import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/migrations";
import { makeRecipientExclusionRepository } from "../src/recipient-exclusion";
import { makeStoredMediaRepository } from "../src/stored-media";

const clerkUserId = "user_exclusion70";
const accountId = "10000000-0000-4000-8000-000000000070";
const connectionId = "20000000-0000-4000-8000-000000000070";
const connectionPublicId = "con_000000000000000000070";
const otherAccountId = "10000000-0000-4000-8000-000000000071";
const otherConnectionPublicId = "con_000000000000000000071";
const contactLocator = `di1_${"A".repeat(43)}`;
const contactPublicId = "ctc_000000000000000000070";
const groupLocator = `wi1_${"B".repeat(43)}`;
const groupPublicId = "grp_000000000000000000070";
const conversationId = "40000000-0000-4000-8000-000000000070";
const messageId = "50000000-0000-4000-8000-000000000070";
const mediaObjectKey = "stored-media/exclusion-70";

describe("WhatsApp Recipient Exclusion persistence", () => {
  let database: PGlite;

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

  const repository = () => makeRecipientExclusionRepository(provider());

  const exclude = async (recipientPublicId: string) => {
    const prepared = await repository().prepareTransition({
      clerkUserId,
      connectionPublicId,
      excluded: true,
      expectedExcluded: false,
      idempotencyKey: `idem-${recipientPublicId}`,
      recipientPublicId,
    });
    if (prepared?.transitionId == null) throw new Error("transition missing");
    return {
      prepared,
      state: await repository().finalizeTransition({
        clerkUserId,
        connectionPublicId,
        observedAt: "2026-08-11T00:00:00.000Z",
        recipientPublicId,
        transitionId: prepared.transitionId,
      }),
    };
  };

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
      `SELECT * FROM public.admit_personal_account_for_clerk(
        $1,$2,1,'arn:aws:kms:us-east-1:111122223333:key/content',decode('0102','hex'),3
      )`,
      [clerkUserId, accountId],
    );
    await database.query(
      `SELECT * FROM public.admit_personal_account_for_clerk(
        'user_other71',$1,1,'arn:aws:kms:us-east-1:111122223333:key/content',decode('0102','hex'),3
      )`,
      [otherAccountId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections(id,personal_account_id,webhook_ingress_id,public_id,
        number_suffix,state,state_changed_at,created_at)
       VALUES($1,$2,'30000000-0000-4000-8000-000000000070',$3,'0070','connected',
        '2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`,
      [connectionId, accountId, connectionPublicId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections(id,personal_account_id,webhook_ingress_id,public_id,
        number_suffix,state,state_changed_at,created_at)
       VALUES('20000000-0000-4000-8000-000000000071',$1,'30000000-0000-4000-8000-000000000071',$2,
        '0071','connected','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`,
      [otherAccountId, otherConnectionPublicId],
    );
    await database.query(
      `INSERT INTO public.directory_contacts(personal_account_id,whatsapp_connection_id,id,public_id,
        provider_identity_index,provider_identity_ciphertext_version,provider_identity_key_version,
        provider_identity_nonce,provider_identity_ciphertext,display_name_sort,active,received_at)
       VALUES($1,$2,'50000000-0000-4000-8000-000000000071',$3,$4,1,1,
        decode(repeat('01',12),'hex'),decode(repeat('02',17),'hex'),'ada',true,'2026-06-02T00:00:00Z')`,
      [accountId, connectionId, contactPublicId, contactLocator],
    );
    await database.query(
      `INSERT INTO public.whatsapp_groups(id,personal_account_id,whatsapp_connection_id,public_id,
        provider_locator,provider_identity_ciphertext_version,provider_identity_key_version,
        provider_identity_nonce,provider_identity_ciphertext,joined,last_observed_at,created_at,updated_at)
       VALUES('60000000-0000-4000-8000-000000000071',$1,$2,$3,$4,1,1,
        decode(repeat('01',12),'hex'),decode(repeat('02',17),'hex'),true,
        '2026-06-02T00:00:00Z','2026-06-02T00:00:00Z','2026-06-02T00:00:00Z')`,
      [accountId, connectionId, groupPublicId, groupLocator],
    );
  });

  afterEach(async () => database.close());

  test("lists both recipient kinds with their current exclusion state", async () => {
    await exclude(groupPublicId);
    const contacts = await repository().listEncryptedRecipients({
      clerkUserId,
      connectionPublicId,
      cursorPublicId: null,
      kind: "contact",
      limit: 20,
      searchIndex: null,
    });
    const groups = await repository().listEncryptedRecipients({
      clerkUserId,
      connectionPublicId,
      cursorPublicId: null,
      kind: "group",
      limit: 20,
      searchIndex: null,
    });
    expect(contacts).toMatchObject([
      { excluded: false, publicId: contactPublicId },
    ]);
    expect(groups).toMatchObject([{ excluded: true, publicId: groupPublicId }]);
  });

  test("keeps another Personal Account from listing or changing exclusions", async () => {
    expect(
      await repository().listEncryptedRecipients({
        clerkUserId: "user_other71",
        connectionPublicId,
        cursorPublicId: null,
        kind: "contact",
        limit: 20,
        searchIndex: null,
      }),
    ).toEqual([]);
    expect(
      await repository().prepareTransition({
        clerkUserId: "user_other71",
        connectionPublicId,
        excluded: true,
        expectedExcluded: false,
        idempotencyKey: "idem-cross-tenant-0001",
        recipientPublicId: contactPublicId,
      }),
    ).toBeNull();
    expect(
      await repository().prepareTransition({
        clerkUserId,
        connectionPublicId: otherConnectionPublicId,
        excluded: true,
        expectedExcluded: false,
        idempotencyKey: "idem-cross-connection-01",
        recipientPublicId: contactPublicId,
      }),
    ).toBeNull();
  });

  test("replays the same idempotency key and rejects stale expected state", async () => {
    const first = await repository().prepareTransition({
      clerkUserId,
      connectionPublicId,
      excluded: true,
      expectedExcluded: false,
      idempotencyKey: "idem-0123456789abcdef",
      recipientPublicId: contactPublicId,
    });
    const replay = await repository().prepareTransition({
      clerkUserId,
      connectionPublicId,
      excluded: true,
      expectedExcluded: false,
      idempotencyKey: "idem-0123456789abcdef",
      recipientPublicId: contactPublicId,
    });
    expect(replay?.transitionId).toBe(first?.transitionId ?? null);
    expect(
      await repository().listPendingTransitions({
        limit: 10,
        observedAt: "2099-01-01T00:00:00.000Z",
      }),
    ).toMatchObject([{ excluded: true, recipientKind: "contact" }]);

    const transitionId = first?.transitionId ?? "";
    await repository().finalizeTransition({
      clerkUserId,
      connectionPublicId,
      observedAt: "2026-08-11T00:00:00.000Z",
      recipientPublicId: contactPublicId,
      transitionId,
    });
    expect(
      await repository().finalizeTransition({
        clerkUserId,
        connectionPublicId,
        observedAt: "2026-08-11T00:00:01.000Z",
        recipientPublicId: contactPublicId,
        transitionId,
      }),
    ).toMatchObject({ excluded: true });
    expect(
      await repository().prepareTransition({
        clerkUserId,
        connectionPublicId,
        excluded: true,
        expectedExcluded: false,
        idempotencyKey: "idem-stale-expected-000",
        recipientPublicId: contactPublicId,
      }),
    ).toMatchObject({ outcome: "conflict" });
  });

  test("makes existing history unreadable before acknowledging and keeps quota until objects go", async () => {
    await database.query(
      `INSERT INTO public.whatsapp_conversations(id,personal_account_id,whatsapp_connection_id,
        public_id,kind,recipient_locator,recipient_public_id,last_activity_at,last_activity_direction)
       VALUES($1,$2,$3,'cvs_000000000000000000070','direct',$4,$5,'2026-07-01T00:00:00Z','inbound')`,
      [
        conversationId,
        accountId,
        connectionId,
        contactLocator,
        contactPublicId,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_messages(id,personal_account_id,whatsapp_connection_id,conversation_id,
        public_id,message_identity,direction,sent_at,content_type,content_ciphertext_version,
        content_key_version,content_nonce,content_ciphertext,received_at,webhook_item_identity)
       VALUES($1,$2,$3,$4,'msg_000000000000000000070',$5,'inbound','2026-07-01T00:00:00Z','image',1,1,
        decode(repeat('01',12),'hex'),decode(repeat('02',17),'hex'),'2026-07-01T00:00:00Z',$6)`,
      [
        messageId,
        accountId,
        connectionId,
        conversationId,
        `wi1_${"C".repeat(43)}`,
        `wi1_${"D".repeat(43)}`,
      ],
    );
    await database.query(
      "UPDATE public.personal_accounts SET stored_media_used_bytes=100 WHERE id=$1",
      [accountId],
    );
    await database.query(
      `INSERT INTO public.stored_media(id,personal_account_id,whatsapp_connection_id,stored_message_id,
        public_id,state,media_type,object_key,plaintext_size_bytes,sha256,metadata_ciphertext_version,
        metadata_key_version,metadata_nonce,metadata_ciphertext)
       VALUES('70000000-0000-4000-8000-000000000070',$1,$2,$3,'med_000000000000000000070','ready',
        'image',$4,100,repeat('a',64),1,1,decode(repeat('03',12),'hex'),decode(repeat('04',17),'hex'))`,
      [accountId, connectionId, messageId, mediaObjectKey],
    );

    const { state } = await exclude(contactPublicId);
    expect(state).toMatchObject({ excluded: true });

    const purged = await database.query<{
      content_ciphertext: Uint8Array | null;
      media_state: string;
      stored_media_used_bytes: number;
    }>(
      `SELECT messages.content_ciphertext, media.state AS media_state,
        accounts.stored_media_used_bytes
       FROM public.stored_messages messages
       JOIN public.stored_media media ON media.stored_message_id = messages.id
       JOIN public.personal_accounts accounts ON accounts.id = messages.personal_account_id`,
    );
    expect(purged.rows).toEqual([
      {
        content_ciphertext: null,
        media_state: "purging",
        stored_media_used_bytes: 100,
      },
    ]);

    expect(
      await repository().purgeExcludedHistory({
        limit: 100,
        observedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toBe(0);

    await makeStoredMediaRepository(provider()).finishObjectDeletion({
      objectKey: mediaObjectKey,
      personalAccountId: accountId,
    });
    expect(
      await repository().purgeExcludedHistory({
        limit: 100,
        observedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toBe(2);
    const remaining = await database.query<{
      conversations: number;
      media: number;
      messages: number;
      used: number;
    }>(
      `SELECT (SELECT count(*)::int FROM public.whatsapp_conversations) conversations,
        (SELECT count(*)::int FROM public.stored_media) media,
        (SELECT count(*)::int FROM public.stored_messages) messages,
        (SELECT stored_media_used_bytes::int FROM public.personal_accounts WHERE id=$1) used`,
      [accountId],
    );
    expect(remaining.rows).toEqual([
      { conversations: 0, media: 0, messages: 0, used: 0 },
    ]);
  });

  test("suppresses observations until a re-enable takes effect and keeps the purge cutoff", async () => {
    const suppressedAt = async (receivedAt: string) => {
      await database.query(
        "SELECT set_config('public.personal_account_id',$1,false)",
        [accountId],
      );
      const result = await database.query<{ suppressed: boolean }>(
        `SELECT public.whatsapp_recipient_observation_suppressed($1,$2,'contact',$3,$4) AS suppressed`,
        [accountId, connectionId, contactLocator, receivedAt],
      );
      return result.rows;
    };
    const excluded = await exclude(contactPublicId);
    const effectiveAt = excluded.state?.effectiveAt ?? "";
    expect(await suppressedAt("2026-08-12T00:00:00Z")).toEqual([
      { suppressed: true },
    ]);

    const reEnable = await repository().prepareTransition({
      clerkUserId,
      connectionPublicId,
      excluded: false,
      expectedExcluded: true,
      idempotencyKey: "idem-re-enable-00000001",
      recipientPublicId: contactPublicId,
    });
    const reEnabled = await repository().finalizeTransition({
      clerkUserId,
      connectionPublicId,
      observedAt: "2026-08-12T00:00:00.000Z",
      recipientPublicId: contactPublicId,
      transitionId: reEnable?.transitionId ?? "",
    });
    expect(reEnabled).toMatchObject({ excluded: false });
    expect(reEnabled?.purgeCutoffAt).toBe(
      excluded.state?.purgeCutoffAt ?? null,
    );
    expect(new Date(reEnabled?.effectiveAt ?? 0).valueOf()).toBeGreaterThan(
      new Date(effectiveAt).valueOf(),
    );

    expect(await suppressedAt(effectiveAt)).toEqual([{ suppressed: true }]);
    expect(await suppressedAt("2027-01-01T00:00:00Z")).toEqual([
      { suppressed: false },
    ]);
  });

  test("refuses to answer the enforcement predicates outside the owning tenant context", async () => {
    await exclude(contactPublicId);
    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      await database.exec("BEGIN");
      await database.query(
        "SELECT set_config('public.personal_account_id',$1,true)",
        [accountId],
      );
      const inContext = await database.query<{ excluded: boolean }>(
        "SELECT public.whatsapp_recipient_excluded($1,$2,'contact',$3) AS excluded",
        [accountId, connectionId, contactLocator],
      );
      expect(inContext.rows).toEqual([{ excluded: true }]);
      await database.exec("ROLLBACK");

      await database.exec("BEGIN");
      expect(
        database.query(
          "SELECT public.whatsapp_recipient_excluded($1,$2,'contact',$3) AS excluded",
          [accountId, connectionId, contactLocator],
        ),
      ).rejects.toThrow(/outside its Personal Account context/u);
      await database.exec("ROLLBACK");
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("drains replayed Stored Media object deletions before restore readiness", async () => {
    await database.query(
      `INSERT INTO public.whatsapp_conversations(id,personal_account_id,whatsapp_connection_id,
        public_id,kind,recipient_locator,recipient_public_id,last_activity_at,last_activity_direction)
       VALUES($1,$2,$3,'cvs_000000000000000000070','direct',$4,$5,'2026-07-01T00:00:00Z','inbound')`,
      [
        conversationId,
        accountId,
        connectionId,
        contactLocator,
        contactPublicId,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_messages(id,personal_account_id,whatsapp_connection_id,conversation_id,
        public_id,message_identity,direction,sent_at,content_type,content_ciphertext_version,
        content_key_version,content_nonce,content_ciphertext,received_at,webhook_item_identity)
       VALUES($1,$2,$3,$4,'msg_000000000000000000070',$5,'inbound','2026-07-01T00:00:00Z','image',1,1,
        decode(repeat('01',12),'hex'),decode(repeat('02',17),'hex'),'2026-07-01T00:00:00Z',$6)`,
      [
        messageId,
        accountId,
        connectionId,
        conversationId,
        `wi1_${"C".repeat(43)}`,
        `wi1_${"D".repeat(43)}`,
      ],
    );
    await database.query(
      "UPDATE public.personal_accounts SET stored_media_used_bytes=100 WHERE id=$1",
      [accountId],
    );
    await database.query(
      `INSERT INTO public.stored_media(id,personal_account_id,whatsapp_connection_id,stored_message_id,
        public_id,state,media_type,object_key,plaintext_size_bytes,sha256,metadata_ciphertext_version,
        metadata_key_version,metadata_nonce,metadata_ciphertext)
       VALUES('70000000-0000-4000-8000-000000000070',$1,$2,$3,'med_000000000000000000070','ready',
        'image',$4,100,repeat('a',64),1,1,decode(repeat('03',12),'hex'),decode(repeat('04',17),'hex'))`,
      [accountId, connectionId, messageId, mediaObjectKey],
    );

    await database.query(
      "SELECT * FROM public.begin_restore_replay('br-exclusion-70','2026-08-13T00:00:00Z')",
    );
    await database.query(
      `SELECT public.replay_whatsapp_recipient_exclusion(
        $1,$2,'contact',$3,$4,true,'2026-08-12T00:00:00Z','2026-08-12T00:00:00Z',
        '80000000-0000-4000-8000-000000000070','2026-08-13T00:00:00Z')`,
      [accountId, connectionId, contactLocator, contactPublicId],
    );
    await database.query(
      "SELECT public.purge_restore_expired('2026-08-13T00:00:00Z',1000)",
    );
    const queued = await database.query<{ bucket: string; object_key: string }>(
      "SELECT * FROM public.list_restore_object_deletions(1000)",
    );
    expect(queued.rows).toEqual([
      { bucket: "stored_media", object_key: mediaObjectKey },
    ]);
    await database.query(
      "SELECT public.finish_restore_object_deletion('stored_media',$1)",
      [mediaObjectKey],
    );
    await database.query(
      "SELECT public.purge_excluded_recipient_history('2026-08-13T00:00:00Z',1000)",
    );
    await database.query(
      "SELECT public.complete_restore_replay('br-exclusion-70','2026-08-13T00:00:00Z',0,0,0)",
    );
    const settled = await database.query<{
      conversations: number;
      media: number;
      messages: number;
      ready: boolean;
      used: number;
    }>(
      `SELECT (SELECT count(*)::int FROM public.whatsapp_conversations) conversations,
        (SELECT count(*)::int FROM public.stored_media) media,
        (SELECT count(*)::int FROM public.stored_messages) messages,
        (SELECT public.is_restore_ready('br-exclusion-70')) ready,
        (SELECT stored_media_used_bytes::int FROM public.personal_accounts WHERE id=$1) used`,
      [accountId],
    );
    expect(settled.rows).toEqual([
      { conversations: 0, media: 0, messages: 0, ready: true, used: 0 },
    ]);
  });

  test("replays an acknowledged transition for the same idempotency key", async () => {
    const { prepared } = await exclude(contactPublicId);
    const retry = await repository().prepareTransition({
      clerkUserId,
      connectionPublicId,
      excluded: true,
      // The retry still carries the original expected state, which is now
      // stale, but the binding must replay the completed result instead.
      expectedExcluded: false,
      idempotencyKey: `idem-${contactPublicId}`,
      recipientPublicId: contactPublicId,
    });
    expect(retry).toMatchObject({ excluded: true, outcome: "replayed" });
    expect(retry?.transitionId).toBeNull();

    const reEnable = await repository().prepareTransition({
      clerkUserId,
      connectionPublicId,
      excluded: false,
      expectedExcluded: true,
      idempotencyKey: "idem-re-enable-00000001",
      recipientPublicId: contactPublicId,
    });
    await repository().finalizeTransition({
      clerkUserId,
      connectionPublicId,
      observedAt: "2026-08-12T00:00:00.000Z",
      recipientPublicId: contactPublicId,
      transitionId: reEnable?.transitionId ?? "",
    });
    // A much later retry of the original key must not re-exclude the
    // recipient behind the User's back.
    const delayed = await repository().prepareTransition({
      clerkUserId,
      connectionPublicId,
      excluded: true,
      expectedExcluded: false,
      idempotencyKey: `idem-${contactPublicId}`,
      recipientPublicId: contactPublicId,
    });
    expect(delayed).toMatchObject({ excluded: true, outcome: "replayed" });
    const state = await database.query<{ excluded: boolean }>(
      "SELECT excluded FROM public.whatsapp_recipient_exclusions",
    );
    expect(state.rows).toEqual([{ excluded: false }]);
    expect(prepared.transitionId).not.toBeNull();
  });

  test("removes a Deleted Message Tombstone and its conversation", async () => {
    await database.query(
      `INSERT INTO public.whatsapp_conversations(id,personal_account_id,whatsapp_connection_id,
        public_id,kind,recipient_locator,recipient_public_id,last_activity_at,last_activity_direction)
       VALUES($1,$2,$3,'cvs_000000000000000000070','direct',$4,$5,'2026-07-01T00:00:00Z','inbound')`,
      [
        conversationId,
        accountId,
        connectionId,
        contactLocator,
        contactPublicId,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_messages(id,personal_account_id,whatsapp_connection_id,conversation_id,
        public_id,message_identity,direction,sent_at,received_at,webhook_item_identity,deleted_at)
       VALUES($1,$2,$3,$4,'msg_000000000000000000070',$5,'inbound','2026-07-01T00:00:00Z',
        '2026-07-01T00:00:00Z',$6,'2026-07-02T00:00:00Z')`,
      [
        messageId,
        accountId,
        connectionId,
        conversationId,
        `wi1_${"C".repeat(43)}`,
        `wi1_${"D".repeat(43)}`,
      ],
    );

    await exclude(contactPublicId);
    expect(
      await repository().purgeExcludedHistory({
        limit: 100,
        observedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toBe(2);
    const remaining = await database.query<{
      conversations: number;
      messages: number;
    }>(
      `SELECT (SELECT count(*)::int FROM public.whatsapp_conversations) conversations,
        (SELECT count(*)::int FROM public.stored_messages) messages`,
    );
    expect(remaining.rows).toEqual([{ conversations: 0, messages: 0 }]);
  });

  test("keeps restore replay closed until every prepared transition resolves", async () => {
    await repository().prepareTransition({
      clerkUserId,
      connectionPublicId,
      excluded: true,
      expectedExcluded: false,
      idempotencyKey: "idem-restore-gate-00001",
      recipientPublicId: contactPublicId,
    });
    await database.query(
      "SELECT * FROM public.begin_restore_replay('br-exclusion-70','2026-08-11T00:00:00Z')",
    );
    expect(
      database.query(
        "SELECT public.complete_restore_replay('br-exclusion-70','2026-08-11T00:00:00Z',0,0,0)",
      ),
    ).rejects.toThrow(/recipient exclusion transitions remain unresolved/u);
  });

  test("replays a journalled transition over a restored snapshot", async () => {
    const replayed = await database.query<{ replayed: boolean }>(
      `SELECT public.replay_whatsapp_recipient_exclusion(
        $1,$2,'contact',$3,$4,true,'2026-08-11T00:00:00Z','2026-08-11T00:00:00Z',
        '80000000-0000-4000-8000-000000000070','2026-08-13T00:00:00Z') AS replayed`,
      [accountId, connectionId, contactLocator, contactPublicId],
    );
    expect(replayed.rows).toEqual([{ replayed: true }]);
    const scanned = await database.query<{ recipient_locator: string }>(
      "SELECT recipient_locator FROM public.list_restore_recipient_identities(100,NULL) ORDER BY scan_key",
    );
    expect(scanned.rows.map((row) => row.recipient_locator)).toEqual([
      contactLocator,
      groupLocator,
    ]);
    const state = await database.query<{
      excluded: boolean;
      purge_cutoff_at: Date;
    }>(
      "SELECT excluded, purge_cutoff_at FROM public.whatsapp_recipient_exclusions",
    );
    expect(state.rows[0]).toMatchObject({ excluded: true });
  });
});
