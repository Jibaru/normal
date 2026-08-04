import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/migrations";

const accountA = "10000000-0000-4000-8000-000000000001";
const accountB = "10000000-0000-4000-8000-000000000002";
const requestId = "90000000-0000-4000-8000-000000000001";

describe("two-person break-glass authority", () => {
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
      `INSERT INTO public.personal_accounts (id, state) VALUES ($1, 'active'), ($2, 'active')`,
      [accountA, accountB],
    );
  });

  afterEach(async () => database.close());

  const asRole = async <T>(role: string, action: () => Promise<T>) => {
    await database.exec(`SET ROLE ${role}`);
    try {
      return await action();
    } finally {
      await database.exec("RESET ROLE");
    }
  };

  const createRequest = () =>
    asRole("whatsapp_break_glass_requester", () =>
      database.query(
        `SELECT public.create_break_glass_request($1, $2, $3, $4, $5, $6)`,
        [
          requestId,
          "incident-58",
          "requester",
          accountA,
          "message_content",
          new Date(Date.now() + 30 * 60_000),
        ],
      ),
    );

  const approveRequest = (approver: string) =>
    asRole("whatsapp_break_glass_approver", () =>
      database.query(`SELECT public.approve_break_glass_request($1, $2)`, [
        requestId,
        approver,
      ]),
    );

  const issueCredential = (digest: string) =>
    asRole("whatsapp_break_glass_runtime", () =>
      database.query(`SELECT public.issue_break_glass_credential($1, $2, $3)`, [
        requestId,
        "issuer",
        digest,
      ]),
    );

  test("requires two distinct approvals and rejects self-approval", async () => {
    await createRequest();
    await expect(approveRequest("requester")).rejects.toThrow();
    await approveRequest("approver-a");
    await expect(issueCredential("a".repeat(64))).rejects.toThrow();
    await expect(approveRequest("approver-a")).rejects.toThrow();
    await approveRequest("approver-b");
    const issued = (await issueCredential("a".repeat(64))) as {
      rows: Array<{ issue_break_glass_credential: Date }>;
    };
    expect(issued.rows[0]?.issue_break_glass_credential).toBeInstanceOf(Date);
  });

  test("fails closed for expiry, wrong account, ordinary role, and scope expansion", async () => {
    await createRequest();
    await database.query(`SELECT public.approve_break_glass_request($1, $2)`, [
      requestId,
      "approver-a",
    ]);
    await database.query(`SELECT public.approve_break_glass_request($1, $2)`, [
      requestId,
      "approver-b",
    ]);
    await database.query(
      `SELECT public.issue_break_glass_credential($1, $2, $3)`,
      [requestId, "issuer", "b".repeat(64)],
    );

    await database.exec("SET ROLE whatsapp_break_glass_runtime");
    const missingCredential = await database.query<{
      authorize_break_glass_attempt: boolean;
    }>(`SELECT public.authorize_break_glass_attempt($1, NULL, $2, $3)`, [
      requestId,
      accountA,
      "message_content",
    ]);
    expect(missingCredential.rows[0]?.authorize_break_glass_attempt).toBe(
      false,
    );
    await expect(
      database.query(
        `SELECT public.record_break_glass_decryption_result($1, NULL, true)`,
        [requestId],
      ),
    ).rejects.toThrow();
    const wrongAccount = await database.query<{
      authorize_break_glass_attempt: boolean;
    }>(`SELECT public.authorize_break_glass_attempt($1, $2, $3, $4)`, [
      requestId,
      "b".repeat(64),
      accountB,
      "message_content",
    ]);
    expect(wrongAccount.rows[0]?.authorize_break_glass_attempt).toBe(false);
    const expandedScope = await database.query<{
      authorize_break_glass_attempt: boolean;
    }>(`SELECT public.authorize_break_glass_attempt($1, $2, $3, $4)`, [
      requestId,
      "b".repeat(64),
      accountA,
      "stored_media",
    ]);
    expect(expandedScope.rows[0]?.authorize_break_glass_attempt).toBe(false);
    await database.exec("RESET ROLE; SET ROLE whatsapp_api_runtime");
    await expect(
      database.query(
        `SELECT public.authorize_break_glass_attempt($1, $2, $3, $4)`,
        [requestId, "b".repeat(64), accountA, "message_content"],
      ),
    ).rejects.toThrow();
  });

  test("records immutable audit and queues User notification after use", async () => {
    await createRequest();
    await database.query(`SELECT public.approve_break_glass_request($1, $2)`, [
      requestId,
      "approver-a",
    ]);
    await database.query(`SELECT public.approve_break_glass_request($1, $2)`, [
      requestId,
      "approver-b",
    ]);
    await database.query(
      `SELECT public.issue_break_glass_credential($1, $2, $3)`,
      [requestId, "issuer", "c".repeat(64)],
    );
    await database.exec("SET ROLE whatsapp_break_glass_runtime");
    await database.query(
      `SELECT public.authorize_break_glass_attempt($1, $2, $3, $4)`,
      [requestId, "c".repeat(64), accountA, "message_content"],
    );
    await database.query(
      `SELECT public.record_break_glass_decryption_result($1, $2, true)`,
      [requestId, "c".repeat(64)],
    );
    await database.exec("RESET ROLE");

    const events = await database.query<{ event_type: string }>(
      `SELECT event_type FROM public.break_glass_audit_events WHERE request_id = $1 ORDER BY occurred_at, id`,
      [requestId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "requested",
      "approved",
      "approved",
      "credential_issued",
      "decryption_attempt_allowed",
      "decryption_succeeded",
    ]);
    const notification = await database.query(
      `SELECT request_id FROM public.break_glass_user_notifications WHERE request_id = $1`,
      [requestId],
    );
    expect(notification.rows).toHaveLength(1);
    await expect(
      database.query(
        `DELETE FROM public.break_glass_audit_events WHERE request_id = $1`,
        [requestId],
      ),
    ).rejects.toThrow();
  });

  test("rejects an expired approval", async () => {
    await database.query(
      `SELECT public.create_break_glass_request($1, $2, $3, $4, $5, statement_timestamp() + interval '10 milliseconds')`,
      [requestId, "incident-58", "requester", accountA, "message_content"],
    );
    await Bun.sleep(20);
    await expect(
      database.query(`SELECT public.approve_break_glass_request($1, $2)`, [
        requestId,
        "approver-a",
      ]),
    ).rejects.toThrow();
  });

  test("records legal prohibition and does not queue notification", async () => {
    await database.query(
      `SELECT public.create_break_glass_request($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        requestId,
        "incident-58",
        "requester",
        accountA,
        "message_content",
        new Date(Date.now() + 30 * 60_000),
        "Investigate integrity incident",
        "Court order reference legal-opaque-1",
      ],
    );
    await database.query(`SELECT public.approve_break_glass_request($1, $2)`, [
      requestId,
      "approver-a",
    ]);
    await database.query(`SELECT public.approve_break_glass_request($1, $2)`, [
      requestId,
      "approver-b",
    ]);
    await database.query(
      `SELECT public.issue_break_glass_credential($1, $2, $3)`,
      [requestId, "issuer", "d".repeat(64)],
    );
    await database.exec("SET ROLE whatsapp_break_glass_runtime");
    await database.query(
      `SELECT public.authorize_break_glass_attempt($1, $2, $3, $4)`,
      [requestId, "d".repeat(64), accountA, "message_content"],
    );
    await database.exec("RESET ROLE");
    const notifications = await database.query(
      `SELECT request_id FROM public.break_glass_user_notifications WHERE request_id = $1`,
      [requestId],
    );
    expect(notifications.rows).toHaveLength(0);
  });
});
