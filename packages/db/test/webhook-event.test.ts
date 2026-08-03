import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/migrations";
import {
  makeWebhookEventRepository,
  type WebhookEventConnectionProvider,
} from "../src/webhook-event";
import {
  makeWhatsAppConnectionRepository,
  type WhatsAppConnectionConnectionProvider,
} from "../src/whatsapp-connection";

const accountId = "10000000-0000-4000-8000-000000000033";
const otherAccountId = "10000000-0000-4000-8000-000000000034";
const connectionId = "20000000-0000-4000-8000-000000000033";
const otherConnectionId = "20000000-0000-4000-8000-000000000034";
const publicId = "con_000000000000000000033";
const firstEventId = "40000000-0000-4000-8000-000000000033";
const secondEventId = "40000000-0000-4000-8000-000000000034";
const receivedAt = "2026-07-31T12:10:00.000Z";

const eventInput = (eventId: string, observedAt = receivedAt) => ({
  ciphertextSha256: "a".repeat(64),
  eventId,
  payloadBytes: 128,
  personalAccountId: accountId,
  receivedAt: observedAt,
  whatsappConnectionId: connectionId,
});

const version = (occurredAt: string) => `test:${occurredAt}`;
const itemIdentity = (value: string) =>
  `wi1_${value.padEnd(43, "0").slice(0, 43)}`;

const compareVersions = async (left: string, right: string) => {
  const leftValue = Date.parse(left.slice("test:".length));
  const rightValue = Date.parse(right.slice("test:".length));
  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
    return "incomparable" as const;
  }
  return leftValue === rightValue
    ? ("equal" as const)
    : leftValue < rightValue
      ? ("before" as const)
      : ("after" as const);
};

describe("Webhook Event repository", () => {
  let database: PGlite;
  let webhookProvider: WebhookEventConnectionProvider;
  let apiProvider: WhatsAppConnectionConnectionProvider;

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
      `INSERT INTO app.personal_accounts (id, state)
       VALUES ($1, 'active'), ($2, 'active')`,
      [accountId, otherAccountId],
    );
    await database.query(
      `INSERT INTO app_private.clerk_identities (
         clerk_user_id,
         personal_account_id
       )
       VALUES ('user_webhook_event', $1)`,
      [accountId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connections (
         id,
         personal_account_id,
         webhook_ingress_id,
         public_id,
         number_suffix,
         state,
         state_changed_at,
         created_at
       )
       VALUES ($1, $2, $3, $4, '0033', 'connecting', $5, $5)`,
      [
        connectionId,
        accountId,
        "30000000-0000-4000-8000-000000000033",
        publicId,
        "2026-07-31T12:00:00.000Z",
      ],
    );
    await database.query(
      `INSERT INTO app.personal_account_key_envelopes (
         personal_account_id,
         key_version,
         kms_key_id,
         ciphertext
       )
       VALUES ($1, 1, 'kms-content-root', decode('0102', 'hex'))`,
      [accountId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connection_key_envelopes (
         personal_account_id,
         whatsapp_connection_id,
         account_key_version,
         key_version,
         nonce,
         ciphertext
       )
       VALUES (
         $1, $2, 1, 1,
         decode(repeat('03', 12), 'hex'),
         decode(repeat('04', 32), 'hex')
       )`,
      [accountId, connectionId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connection_secrets (
         personal_account_id,
         whatsapp_connection_id,
         credential_ciphertext,
         credential_ciphertext_version,
         credential_key_version,
         credential_nonce
       )
       VALUES (
         $1, $2,
         decode(repeat('05', 32), 'hex'),
         1,
         1,
         decode(repeat('06', 12), 'hex')
       )`,
      [accountId, connectionId],
    );

    webhookProvider = {
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_webhook_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    apiProvider = {
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

  afterEach(async () => {
    await database.close();
  });

  test("persists one encrypted-source Event and loads only connection-bound keys", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);

    const prepared = await repository.prepare(eventInput(firstEventId));
    const replay = await repository.prepare(eventInput(firstEventId));
    const crossTenant = await repository.prepare({
      ...eventInput(secondEventId),
      personalAccountId: otherAccountId,
    });

    expect(prepared).toEqual({
      accountKey: {
        ciphertext: "AQI=",
        keyVersion: 1,
        kmsKeyId: "kms-content-root",
        personalAccountId: accountId,
        version: 1,
      },
      connectionKey: {
        accountKeyVersion: 1,
        ciphertext: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
        connectionId,
        keyVersion: 1,
        nonce: "AwMDAwMDAwMDAwMD",
        personalAccountId: accountId,
        version: 1,
      },
      identityKey: {
        ciphertext: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
        keyVersion: 1,
        nonce: "BgYGBgYGBgYGBgYG",
        version: 1,
      },
    });
    expect(replay).toEqual(prepared);
    expect(crossTenant).toBeNull();

    const events = await database.query<{
      ciphertext_sha256: string;
      event_count: number;
      source_expires_at: Date;
    }>(
      `SELECT
         count(*)::integer AS event_count,
         min(ciphertext_sha256) AS ciphertext_sha256,
         min(source_expires_at) AS source_expires_at
       FROM app.webhook_events`,
    );
    expect(events.rows[0]).toMatchObject({
      ciphertext_sha256: "a".repeat(64),
      event_count: 1,
      source_expires_at: new Date("2026-08-07T12:10:00.000Z"),
    });
  });

  test("finds only encrypted ingress objects that Queue processing has not claimed", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    const first = eventInput(firstEventId);
    const second = eventInput(secondEventId, "2026-07-31T12:11:00.000Z");

    expect(await repository.filterUnclaimed([first, second])).toEqual([
      first,
      second,
    ]);
    await repository.prepare(first);
    expect(await repository.filterUnclaimed([first, second])).toEqual([second]);
  });

  test("records one evidence-based processing gap before DLQ acknowledgement", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    const input = {
      ...eventInput(firstEventId),
      deadLetteredAt: "2026-08-01T09:10:00.000Z",
    };

    const firstDeadLetter = await repository.deadLetter(input);
    expect(firstDeadLetter).toMatchObject({ outcome: "gap_recorded" });
    expect(firstDeadLetter.incidentReference).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await repository.deadLetter(input)).toEqual(firstDeadLetter);

    const recorded = await database.query<{
      cause: string;
      dead_lettered_at: Date;
      evidence_webhook_event_id: string;
      gap_count: number;
      starts_at: Date;
    }>(
      `SELECT
         gaps.cause,
         events.dead_lettered_at,
         gaps.evidence_webhook_event_id,
         count(*) OVER ()::integer AS gap_count,
         gaps.starts_at
       FROM app.ingestion_gaps AS gaps
       JOIN app.webhook_events AS events
         ON events.id = gaps.evidence_webhook_event_id`,
    );
    expect(recorded.rows).toEqual([
      {
        cause: "processing_failure",
        dead_lettered_at: new Date("2026-08-01T09:10:00.000Z"),
        evidence_webhook_event_id: firstEventId,
        gap_count: 1,
        starts_at: new Date(receivedAt),
      },
    ]);

    await database.query(
      `INSERT INTO app.whatsapp_connections (
         id,
         personal_account_id,
         webhook_ingress_id,
         public_id,
         number_suffix,
         state,
         state_changed_at
       )
       VALUES ($1, $2, $3, $4, '0034', 'connecting', $5)`,
      [
        otherConnectionId,
        otherAccountId,
        "30000000-0000-4000-8000-000000000034",
        "con_000000000000000000034",
        receivedAt,
      ],
    );
    await database.query(
      `INSERT INTO app.webhook_events (
         personal_account_id,
         whatsapp_connection_id,
         id,
         ciphertext_sha256,
         payload_bytes,
         received_at,
         source_expires_at
       )
       VALUES ($1, $2, $3, $4, 128, $5, $5::timestamptz + interval '7 days')`,
      [
        otherAccountId,
        otherConnectionId,
        secondEventId,
        "b".repeat(64),
        receivedAt,
      ],
    );
    await expect(
      database.query(
        `INSERT INTO app.ingestion_gaps (
           personal_account_id,
           whatsapp_connection_id,
           cause,
           history_window_started_at,
           starts_at,
           detected_at,
           updated_at,
           evidence_webhook_event_id
         )
         VALUES ($1, $2, 'processing_failure', $3, $3, $3, $3, $4)`,
        [accountId, connectionId, receivedAt, secondEventId],
      ),
    ).rejects.toThrow();

    await database.query("DELETE FROM app.webhook_events WHERE id = $1", [
      firstEventId,
    ]);
    const retainedGap = await database.query<{
      evidence_webhook_event_id: string | null;
    }>("SELECT evidence_webhook_event_id FROM app.ingestion_gaps");
    expect(retainedGap.rows).toEqual([{ evidence_webhook_event_id: null }]);
  });

  test("does not create a false gap when a duplicate reaches DLQ after completion", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));
    await repository.complete({
      completedAt: "2026-07-31T12:10:01.000Z",
      eventId: firstEventId,
      personalAccountId: accountId,
      whatsappConnectionId: connectionId,
    });

    expect(
      await repository.deadLetter({
        ...eventInput(firstEventId),
        deadLetteredAt: "2026-08-01T09:10:00.000Z",
      }),
    ).toEqual({ incidentReference: null, outcome: "already_completed" });
    const gaps = await database.query("SELECT id FROM app.ingestion_gaps");
    expect(gaps.rows).toEqual([]);
  });

  test("keeps Webhook Events tenant-scoped and unavailable to the API role", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));

    await database.exec("SET ROLE whatsapp_webhook_runtime");
    try {
      const withoutContext = await database.query(
        "SELECT id FROM app.webhook_events",
      );
      expect(withoutContext.rows).toEqual([]);
    } finally {
      await database.exec("RESET ROLE");
    }

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      await expect(
        database.query("SELECT id FROM app.webhook_events"),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("converges correlated Send Status evidence with the restricted webhook role", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    const authorizationId = "40000000-0000-4000-8000-000000000050";
    const auditLogId = "50000000-0000-4000-8000-000000000050";
    const sendId = "60000000-0000-4000-8000-000000000050";
    const messageIdentity = itemIdentity("send-message");
    await database.query(
      `INSERT INTO app.mcp_authorizations (
         id, personal_account_id, oauth_subject, client_id, client_class,
         scopes, reverified_at, authorized_at, absolute_expires_at
       ) VALUES ($1,$2,$3,'send-status-client','approved',ARRAY['messages:send'],$4,$4,$4::timestamptz + interval '90 days')`,
      [authorizationId, accountId, "S".repeat(43), receivedAt],
    );
    await database.query(
      `INSERT INTO app.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, tool_name, started_at,
         outcome, quota_reserved, expires_at
       ) VALUES ($1,$2,$3,'send_text_message',$4,'started',true,$4::timestamptz + interval '90 days')`,
      [auditLogId, accountId, authorizationId, receivedAt],
    );
    await database.query(
      `INSERT INTO app.send_operations (
         id, public_id, personal_account_id, mcp_authorization_id,
         tool_call_log_id, whatsapp_connection_id, recipient_type,
         recipient_public_id, status, created_at, status_changed_at,
         attempt_claimed_at, lease_expires_at, expires_at, message_identity
       ) VALUES ($1,'snd_000000000000000000050',$2,$3,$4,$5,'contact',
         'ctc_000000000000000000050','processing',$6,$6,$6,
         $6::timestamptz + interval '30 seconds',
         $6::timestamptz + interval '90 days',$7)`,
      [
        sendId,
        accountId,
        authorizationId,
        auditLogId,
        connectionId,
        receivedAt,
        messageIdentity,
      ],
    );
    await repository.prepare(eventInput(firstEventId));

    const project = (
      status: "sent" | "delivered" | "read" | "failed",
      index: number,
    ) =>
      repository.projectSendEvidence({
        eventId: firstEventId,
        evidence: { occurredAt: null, version: null },
        itemIdentity: itemIdentity(`send-${status}-${index}`),
        itemIndex: index,
        messageIdentity,
        personalAccountId: accountId,
        receivedAt,
        status,
        whatsappConnectionId: connectionId,
      });

    expect(await project("delivered", 0)).toBe("applied");
    await expect(project("failed", 1)).resolves.toBe("superseded");
    await expect(project("read", 2)).resolves.toBe("applied");
    await expect(project("sent", 3)).resolves.toBe("superseded");
    await database.query(
      "UPDATE app.send_operations SET status='unknown' WHERE id=$1",
      [sendId],
    );
    await expect(project("failed", 4)).resolves.toBe("applied");
    await expect(project("sent", 5)).resolves.toBe("applied");
    const persisted = await database.query<{ status: string }>(
      "SELECT status FROM app.send_operations WHERE id=$1",
      [sendId],
    );
    expect(persisted.rows).toEqual([{ status: "sent" }]);

    const privileges = await database.query<{
      can_delete_pending: boolean;
      can_select_pending_identity: boolean;
      can_update_message_identity: boolean;
    }>(
      `SELECT has_table_privilege(
         'whatsapp_webhook_runtime', 'app.pending_send_contents', 'DELETE'
       ) AS can_delete_pending,
       has_column_privilege(
         'whatsapp_webhook_runtime', 'app.pending_send_contents',
         'personal_account_id', 'SELECT'
       ) AND has_column_privilege(
         'whatsapp_webhook_runtime', 'app.pending_send_contents',
         'send_operation_id', 'SELECT'
       ) AS can_select_pending_identity,
       has_column_privilege(
         'whatsapp_webhook_runtime', 'app.send_operations',
         'message_identity', 'UPDATE'
       ) AS can_update_message_identity`,
    );
    expect(privileges.rows).toEqual([
      {
        can_delete_pending: true,
        can_select_pending_identity: true,
        can_update_message_identity: false,
      },
    ]);
  });

  test("claims and projects connection state atomically across duplicates and reordering", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));

    const connected = await repository.projectConnectionState(
      {
        eventId: firstEventId,
        evidence: {
          occurredAt: "2026-07-31T12:05:00.000Z",
          version: version("2026-07-31T12:05:00.000Z"),
        },
        itemIdentity: itemIdentity("connected"),
        itemIndex: 0,
        personalAccountId: accountId,
        receivedAt,
        state: "connected",
        whatsappConnectionId: connectionId,
      },
      compareVersions,
    );
    const duplicate = await repository.projectConnectionState(
      {
        eventId: firstEventId,
        evidence: {
          occurredAt: "2026-07-31T12:05:00.000Z",
          version: version("2026-07-31T12:05:00.000Z"),
        },
        itemIdentity: itemIdentity("connected"),
        itemIndex: 1,
        personalAccountId: accountId,
        receivedAt,
        state: "connected",
        whatsappConnectionId: connectionId,
      },
      compareVersions,
    );
    const older = await repository.projectConnectionState(
      {
        eventId: firstEventId,
        evidence: {
          occurredAt: "2026-07-31T12:04:00.000Z",
          version: version("2026-07-31T12:04:00.000Z"),
        },
        itemIdentity: itemIdentity("older"),
        itemIndex: 2,
        personalAccountId: accountId,
        receivedAt: "2026-07-31T12:11:00.000Z",
        state: "reconnect_required",
        whatsappConnectionId: connectionId,
      },
      compareVersions,
    );
    const weakerLate = await repository.projectConnectionState(
      {
        eventId: firstEventId,
        evidence: { occurredAt: null, version: null },
        itemIdentity: itemIdentity("weaker_late"),
        itemIndex: 3,
        personalAccountId: accountId,
        receivedAt: "2026-07-31T12:12:00.000Z",
        state: "degraded",
        whatsappConnectionId: connectionId,
      },
      compareVersions,
    );

    expect([connected, duplicate, older, weakerLate]).toEqual([
      "applied",
      "duplicate",
      "superseded",
      "superseded",
    ]);
    await expect(
      makeWhatsAppConnectionRepository(apiProvider).listForUser(
        "user_webhook_event",
      ),
    ).resolves.toEqual([
      {
        displayName: null,
        numberSuffix: "0033",
        publicId,
        state: "connected",
        stateChangedAt: "2026-07-31T12:05:00.000Z",
      },
    ]);

    const claims = await database.query<{
      item_count: number;
      outcomes: string[];
    }>(
      `SELECT
         count(*)::integer AS item_count,
         array_agg(outcome ORDER BY item_index) AS outcomes
       FROM app.webhook_items`,
    );
    expect(claims.rows).toEqual([
      {
        item_count: 3,
        outcomes: ["applied", "superseded", "superseded"],
      },
    ]);
  });

  test("idempotently projects encrypted contact upserts and removals", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));
    const encrypted = (byte: string) => ({
      ciphertext: Buffer.from(byte.repeat(32), "hex").toString("base64"),
      keyVersion: 1,
      nonce: Buffer.from("09".repeat(12), "hex").toString("base64"),
      version: 1 as const,
    });
    const common = {
      displayNameCiphertext: encrypted("07"),
      displayNameSort: "ada",
      eventId: firstEventId,
      evidence: {
        occurredAt: "2026-07-31T12:05:00.000Z",
        version: version("2026-07-31T12:05:00.000Z"),
      },
      itemIdentity: itemIdentity("contact-upsert"),
      itemIndex: 0,
      namePrefixIndexes: [`di1_${"n".repeat(43)}`],
      personalAccountId: accountId,
      phoneCiphertext: encrypted("08"),
      phoneIndex: `di1_${"p".repeat(43)}`,
      providerIdentityCiphertext: encrypted("06"),
      providerIdentityIndex: `di1_${"i".repeat(43)}`,
      publicId: "ctc_123456789012345678901",
      receivedAt,
      whatsappConnectionId: connectionId,
    } as const;

    expect(
      await repository.projectDirectoryContact(
        { ...common, active: true },
        compareVersions,
      ),
    ).toBe("applied");
    expect(
      await repository.projectDirectoryContact(
        { ...common, active: true },
        compareVersions,
      ),
    ).toBe("duplicate");
    expect(
      await repository.projectDirectoryContact(
        {
          ...common,
          active: false,
          displayNameCiphertext: null,
          displayNameSort: "",
          evidence: {
            occurredAt: "2026-07-31T12:06:00.000Z",
            version: version("2026-07-31T12:06:00.000Z"),
          },
          itemIdentity: itemIdentity("contact-remove"),
          itemIndex: 1,
          namePrefixIndexes: [],
          phoneCiphertext: null,
          phoneIndex: null,
          receivedAt: "2026-07-31T12:11:00.000Z",
        },
        compareVersions,
      ),
    ).toBe("applied");

    const contacts = await database.query<{
      active: boolean;
      display_name_ciphertext: Uint8Array | null;
      phone_ciphertext: Uint8Array | null;
      provider_identity_ciphertext: Uint8Array;
      public_id: string;
    }>(
      `SELECT active, display_name_ciphertext, phone_ciphertext,
              provider_identity_ciphertext, public_id
       FROM app.directory_contacts`,
    );
    expect(contacts.rows).toEqual([
      {
        active: false,
        display_name_ciphertext: null,
        phone_ciphertext: null,
        provider_identity_ciphertext: expect.any(Uint8Array),
        public_id: "ctc_123456789012345678901",
      },
    ]);
  });

  test("converges regrouped and concurrent deliveries on one later state", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));
    await repository.prepare(
      eventInput(secondEventId, "2026-07-31T12:11:00.000Z"),
    );

    const common = {
      evidence: {
        occurredAt: "2026-07-31T12:05:00.000Z",
        version: version("2026-07-31T12:05:00.000Z"),
      },
      itemIdentity: itemIdentity("regrouped"),
      itemIndex: 0,
      personalAccountId: accountId,
      receivedAt,
      state: "connected" as const,
      whatsappConnectionId: connectionId,
    };
    expect(
      await repository.projectConnectionState(
        { ...common, eventId: firstEventId },
        compareVersions,
      ),
    ).toBe("applied");
    expect(
      await repository.projectConnectionState(
        { ...common, eventId: secondEventId },
        compareVersions,
      ),
    ).toBe("duplicate");

    const concurrentResults = await Promise.all([
      repository.projectConnectionState(
        {
          ...common,
          eventId: firstEventId,
          evidence: {
            occurredAt: "2026-07-31T12:06:00.000Z",
            version: version("2026-07-31T12:06:00.000Z"),
          },
          itemIdentity: itemIdentity("concurrent_older"),
          itemIndex: 1,
          state: "degraded",
        },
        compareVersions,
      ),
      repository.projectConnectionState(
        {
          ...common,
          eventId: secondEventId,
          evidence: {
            occurredAt: "2026-07-31T12:07:00.000Z",
            version: version("2026-07-31T12:07:00.000Z"),
          },
          itemIdentity: itemIdentity("concurrent_later"),
          itemIndex: 1,
          receivedAt: "2026-07-31T12:11:00.000Z",
          state: "disconnected",
        },
        compareVersions,
      ),
    ]);

    expect(concurrentResults).toHaveLength(2);
    await expect(
      makeWhatsAppConnectionRepository(apiProvider).listForUser(
        "user_webhook_event",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        publicId,
        state: "disconnected",
        stateChangedAt: "2026-07-31T12:07:00.000Z",
      }),
    ]);
  });

  test("keeps deletion terminal and replaces prior ciphertext with the newest edit", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));
    const messageIdentity = itemIdentity("message");
    const base = {
      eventId: firstEventId,
      itemIndex: 0,
      personalAccountId: accountId,
      receivedAt,
      whatsappConnectionId: connectionId,
    };
    const content = (value: number) => ({
      ciphertext: Buffer.alloc(32, value).toString("base64"),
      keyVersion: 1,
      nonce: Buffer.alloc(12, value).toString("base64"),
      version: 1 as const,
    });
    const upsert = {
      ...base,
      content: content(1),
      contentType: "image" as const,
      conversationId: "50000000-0000-4000-8000-000000000044",
      conversationPublicId: "cvs_000000000000000000044",
      direction: "inbound" as const,
      evidence: {
        occurredAt: "2026-07-31T12:00:00.000Z",
        version: version("2026-07-31T12:00:00.000Z"),
      },
      itemIdentity: itemIdentity("upsert"),
      messageId: "60000000-0000-4000-8000-000000000044",
      messageIdentity,
      messagePublicId: "msg_000000000000000000044",
      media: {
        id: "70000000-0000-4000-8000-000000000044",
        publicId: "med_000000000000000000044",
        source: content(4),
      },
      recipientKind: "group" as const,
      recipientLocator: itemIdentity("group"),
      recipientPublicId: "grp_000000000000000000044",
      sentAt: "2026-07-31T12:00:00.000Z",
    };
    expect(await repository.projectStoredMessage(upsert, compareVersions)).toBe(
      "applied",
    );
    expect(
      await database.query(
        `SELECT state,media_type,source_ciphertext IS NOT NULL AS protected FROM app.stored_media`,
      ),
    ).toMatchObject({
      rows: [{ state: "pending", media_type: "image", protected: true }],
    });
    expect(
      await repository.projectStoredMessageEdit(
        {
          ...base,
          content: content(3),
          contentType: "text",
          editedAt: "2026-07-31T11:55:00.000Z",
          evidence: {
            occurredAt: "2026-07-31T11:55:00.000Z",
            version: version("2026-07-31T11:55:00.000Z"),
          },
          itemIdentity: itemIdentity("older-edit"),
          messageIdentity,
        },
        compareVersions,
      ),
    ).toBe("superseded");
    expect(
      await repository.projectStoredMessageEdit(
        {
          ...base,
          content: content(2),
          contentType: "text",
          editedAt: "2026-07-31T12:05:00.000Z",
          evidence: {
            occurredAt: "2026-07-31T12:05:00.000Z",
            version: version("2026-07-31T12:05:00.000Z"),
          },
          itemIdentity: itemIdentity("edit"),
          messageIdentity,
        },
        compareVersions,
      ),
    ).toBe("applied");
    expect(
      await repository.projectStoredMessage(
        { ...upsert, itemIdentity: itemIdentity("late-upsert") },
        compareVersions,
      ),
    ).toBe("superseded");
    expect(
      await repository.projectStoredMessageDeletion({
        ...base,
        conversationId: upsert.conversationId,
        conversationPublicId: upsert.conversationPublicId,
        deletedAt: "2026-07-31T12:10:00.000Z",
        direction: "inbound",
        evidence: {
          occurredAt: "2026-07-31T12:10:00.000Z",
          version: version("2026-07-31T12:10:00.000Z"),
        },
        itemIdentity: itemIdentity("delete"),
        messageId: upsert.messageId,
        messageIdentity,
        messagePublicId: upsert.messagePublicId,
        recipientKind: "group",
        recipientLocator: upsert.recipientLocator,
        recipientPublicId: upsert.recipientPublicId,
        sentAt: upsert.sentAt,
      }),
    ).toBe("applied");
    expect(
      await repository.projectStoredMessage(
        {
          ...upsert,
          itemIdentity: itemIdentity("resurrection"),
          evidence: {
            occurredAt: "2026-07-31T12:20:00.000Z",
            version: version("2026-07-31T12:20:00.000Z"),
          },
        },
        compareVersions,
      ),
    ).toBe("superseded");
    const row = await database.query<Record<string, unknown>>(
      `SELECT content_ciphertext, edited_at, deleted_at FROM app.stored_messages WHERE message_identity=$1`,
      [messageIdentity],
    );
    expect(row.rows[0]).toMatchObject({
      content_ciphertext: null,
      deleted_at: new Date("2026-07-31T12:10:00.000Z"),
    });
  });

  test("atomically deduplicates encrypted group joins and applies a later unjoin", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));
    const protect = async () => ({
      displayName: {
        ciphertext: new Uint8Array(20).fill(7),
        keyVersion: 1,
        nonce: new Uint8Array(12).fill(8),
        version: 1 as const,
      },
      providerIdentity: {
        ciphertext: new Uint8Array(20).fill(9),
        keyVersion: 1,
        nonce: new Uint8Array(12).fill(10),
        version: 1 as const,
      },
    });
    const locator = itemIdentity("group-locator");
    const joinInput = {
      displayName: "Family",
      eventId: firstEventId,
      evidence: {
        occurredAt: "2026-07-31T12:05:00.000Z",
        version: version("2026-07-31T12:05:00.000Z"),
      },
      groupId: "60000000-0000-4000-8000-000000000039",
      itemIdentity: itemIdentity("group-join"),
      itemIndex: 0,
      joined: true,
      locator,
      namePrefixIndexes: [`gi1_${"A".repeat(43)}`],
      personalAccountId: accountId,
      providerIdentity: "sealed-provider-group",
      publicId: "grp_123456789012345678939",
      receivedAt,
      whatsappConnectionId: connectionId,
    } as const;

    await expect(
      repository.projectGroup(joinInput, protect, compareVersions),
    ).resolves.toBe("applied");
    await expect(
      repository.projectGroup(joinInput, protect, compareVersions),
    ).resolves.toBe("duplicate");
    await expect(
      repository.projectGroup(
        {
          ...joinInput,
          displayName: "Family renamed",
          evidence: {
            occurredAt: "2026-07-31T12:06:00.000Z",
            version: version("2026-07-31T12:06:00.000Z"),
          },
          itemIdentity: itemIdentity("group-unjoin"),
          itemIndex: 1,
          joined: false,
          namePrefixIndexes: [],
          receivedAt: "2026-07-31T12:11:00.000Z",
        },
        protect,
        compareVersions,
      ),
    ).resolves.toBe("applied");

    const groups = await database.query<{
      count: number;
      index_count: number;
      joined: boolean;
      plaintext_matches: boolean;
    }>(
      `SELECT
         count(*)::integer AS count,
         max(cardinality(name_prefix_indexes))::integer AS index_count,
         bool_and(NOT convert_from(display_name_ciphertext, 'UTF8') LIKE '%Family%')
           AS plaintext_matches,
         bool_and(joined) AS joined
       FROM app.whatsapp_groups`,
    );
    expect(groups.rows).toEqual([
      { count: 1, index_count: 0, joined: false, plaintext_matches: true },
    ]);
    const items = await database.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM app.webhook_items
       WHERE item_kind = 'directory_group'`,
    );
    expect(items.rows).toEqual([{ count: 2 }]);
  });

  test("orders provider occurrence evidence even when no version is available", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));

    const occurrenceOnly = await repository.projectConnectionState(
      {
        eventId: firstEventId,
        evidence: {
          occurredAt: "2026-07-31T12:08:00.000Z",
          version: null,
        },
        itemIdentity: itemIdentity("occurrence_only"),
        itemIndex: 0,
        personalAccountId: accountId,
        receivedAt,
        state: "connected",
        whatsappConnectionId: connectionId,
      },
      compareVersions,
    );
    const receiveOrderOnly = await repository.projectConnectionState(
      {
        eventId: firstEventId,
        evidence: { occurredAt: null, version: null },
        itemIdentity: itemIdentity("receive_order_only"),
        itemIndex: 1,
        personalAccountId: accountId,
        receivedAt: "2026-07-31T12:12:00.000Z",
        state: "degraded",
        whatsappConnectionId: connectionId,
      },
      compareVersions,
    );

    expect([occurrenceOnly, receiveOrderOnly]).toEqual([
      "applied",
      "superseded",
    ]);
  });

  test("does not let late provider evidence predate a confirmed health snapshot", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));
    await database.query(
      `UPDATE app.whatsapp_connections
       SET
         state = 'connected',
         state_changed_at = '2026-07-31T12:20:00.000Z',
         state_received_at = '2026-07-31T12:20:00.000Z',
         state_snapshot_observed_at = '2026-07-31T12:20:00.000Z'
       WHERE id = $1`,
      [connectionId],
    );

    const stale = await repository.projectConnectionState(
      {
        eventId: firstEventId,
        evidence: {
          occurredAt: "2026-07-31T12:19:00.000Z",
          version: null,
        },
        itemIdentity: itemIdentity("before_health_snapshot"),
        itemIndex: 0,
        personalAccountId: accountId,
        receivedAt: "2026-07-31T12:21:00.000Z",
        state: "disconnected",
        whatsappConnectionId: connectionId,
      },
      compareVersions,
    );
    const newer = await repository.projectConnectionState(
      {
        eventId: firstEventId,
        evidence: {
          occurredAt: "2026-07-31T12:20:01.000Z",
          version: null,
        },
        itemIdentity: itemIdentity("after_health_snapshot"),
        itemIndex: 1,
        personalAccountId: accountId,
        receivedAt: "2026-07-31T12:21:01.000Z",
        state: "disconnected",
        whatsappConnectionId: connectionId,
      },
      compareVersions,
    );

    expect([stale, newer]).toEqual(["superseded", "applied"]);
  });

  test("does not let a version-only webhook received before a health snapshot regress it", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));
    await database.query(
      `UPDATE app.whatsapp_connections
       SET
         state = 'connected',
         state_changed_at = '2026-07-31T12:20:00.000Z',
         state_received_at = '2026-07-31T12:20:00.000Z',
         state_snapshot_observed_at = '2026-07-31T12:20:00.000Z'
       WHERE id = $1`,
      [connectionId],
    );

    const outcome = await repository.projectConnectionState(
      {
        eventId: firstEventId,
        evidence: { occurredAt: null, version: "101" },
        itemIdentity: itemIdentity("version_before_health_snapshot"),
        itemIndex: 0,
        personalAccountId: accountId,
        receivedAt: "2026-07-31T12:19:59.000Z",
        state: "disconnected",
        whatsappConnectionId: connectionId,
      },
      compareVersions,
    );

    expect(outcome).toBe("superseded");
  });

  test("quarantines permanent item failures without blocking valid siblings", async () => {
    const repository = makeWebhookEventRepository(webhookProvider);
    await repository.prepare(eventInput(firstEventId));

    await repository.quarantine({
      classification: "invalid_item_shape",
      eventId: firstEventId,
      itemIdentity: null,
      itemIndex: 0,
      itemKind: "malformed",
      personalAccountId: accountId,
      receivedAt,
      whatsappConnectionId: connectionId,
    });
    const applied = await repository.projectConnectionState(
      {
        eventId: firstEventId,
        evidence: {
          occurredAt: "2026-07-31T12:08:00.000Z",
          version: version("2026-07-31T12:08:00.000Z"),
        },
        itemIdentity: itemIdentity("valid_sibling"),
        itemIndex: 1,
        personalAccountId: accountId,
        receivedAt,
        state: "connected",
        whatsappConnectionId: connectionId,
      },
      compareVersions,
    );
    await repository.complete({
      completedAt: "2026-07-31T12:10:01.000Z",
      eventId: firstEventId,
      personalAccountId: accountId,
      whatsappConnectionId: connectionId,
    });

    expect(applied).toBe("applied");
    const result = await database.query<{
      completed_at: Date;
      quarantine_count: number;
      state: string;
    }>(
      `SELECT
         events.processing_completed_at AS completed_at,
         (SELECT count(*)::integer FROM app.webhook_item_quarantines)
           AS quarantine_count,
         connections.state
       FROM app.webhook_events AS events
       JOIN app.whatsapp_connections AS connections
         ON connections.personal_account_id = events.personal_account_id
        AND connections.id = events.whatsapp_connection_id
       WHERE events.id = $1`,
      [firstEventId],
    );
    expect(result.rows).toEqual([
      {
        completed_at: new Date("2026-07-31T12:10:01.000Z"),
        quarantine_count: 1,
        state: "connected",
      },
    ]);
  });
});
