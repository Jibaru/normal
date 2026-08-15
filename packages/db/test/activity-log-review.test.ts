import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type ActivityLogRepository,
  makeActivityLogRepository,
} from "../src/activity-log";
import { makeMcpAuthorizationRepository } from "../src/mcp-authorization";
import { runMigrations } from "../src/migrations";

const accountId = "10000000-0000-4000-8000-000000000036";
const authorizationId = "40000000-0000-4000-8000-000000000036";
const connectionId = "20000000-0000-4000-8000-000000000036";
const connectionPublicId = "con_123456789012345678901";
const clerkUserId = "user_toolcalllogs36";
const otherAccountId = "10000000-0000-4000-8000-000000000037";
const otherAuthorizationId = "40000000-0000-4000-8000-000000000037";
const otherClerkUserId = "user_toolcalllogs37";
const otherConnectionId = "20000000-0000-4000-8000-000000000037";
const otherConnectionPublicId = "con_123456789012345678902";

describe("Activity Log repository", () => {
  let database: PGlite;
  let repository: ActivityLogRepository;

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
        $1, $2, 1, $3, decode('0102', 'hex'), 6
      )`,
      [
        clerkUserId,
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_fallback, public_id
       ) VALUES ($1, $2, $3, 'Bright Badger', $4)`,
      [
        connectionId,
        accountId,
        "30000000-0000-4000-8000-000000000036",
        connectionPublicId,
      ],
    );
    const provider = {
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
    };
    await makeMcpAuthorizationRepository(provider).create({
      authorizationId,
      authorizedAt: new Date("2026-06-01T12:00:00.000Z"),
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      clerkUserId,
      connectionIds: [connectionPublicId],
      expiresAt: new Date("2026-08-30T12:00:00.000Z"),
      oauthSubject: "A".repeat(43),
      reverifiedAt: new Date("2026-06-01T11:59:00.000Z"),
      scopes: ["connections:read", "messages:send"],
    });
    await database.query(
      `SELECT * FROM public.admit_personal_account_for_clerk(
        $1, $2, 2, $3, decode('0304', 'hex'), 6
      )`,
      [
        otherClerkUserId,
        otherAccountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_fallback, public_id
       ) VALUES ($1, $2, $3, 'Calm Falcon', $4)`,
      [
        otherConnectionId,
        otherAccountId,
        "30000000-0000-4000-8000-000000000037",
        otherConnectionPublicId,
      ],
    );
    await makeMcpAuthorizationRepository(provider).create({
      authorizationId: otherAuthorizationId,
      authorizedAt: new Date("2026-06-01T12:00:00.000Z"),
      clientClass: "approved",
      clientId: "other-client",
      clientName: "Other MCP Client",
      clerkUserId: otherClerkUserId,
      connectionIds: [otherConnectionPublicId],
      expiresAt: new Date("2026-08-30T12:00:00.000Z"),
      oauthSubject: "B".repeat(43),
      reverifiedAt: new Date("2026-06-01T11:59:00.000Z"),
      scopes: ["connections:read"],
    });
    repository = makeActivityLogRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  test("lists only safe metadata for the owning active Personal Account", async () => {
    await database.query(
      `INSERT INTO public.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, tool_name,
         started_at, completed_at, outcome, error_code, result_count,
         latency_ms, quota_reserved, media_bytes_reserved, expires_at,
         connection_public_id
       ) VALUES
         ($1, $2, $3, 'list_connections', $4, $5, 'success', NULL, 2,
          120, true, 0, $4::timestamptz + interval '90 days', $9),
         ($6, $2, $3, 'read_messages', $7, $8, 'execution_error',
          'service_unavailable', NULL, 45, true, 0,
          $7::timestamptz + interval '90 days', $9)`,
      [
        "50000000-0000-4000-8000-000000000036",
        accountId,
        authorizationId,
        new Date("2026-07-31T12:00:00.000Z"),
        new Date("2026-07-31T12:00:00.120Z"),
        "50000000-0000-4000-8000-000000000035",
        new Date("2026-04-30T12:00:00.000Z"),
        new Date("2026-04-30T12:00:00.045Z"),
        connectionPublicId,
      ],
    );
    await database.query(
      `INSERT INTO public.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, tool_name,
         started_at, completed_at, outcome, result_count, latency_ms,
         quota_reserved, expires_at
       ) VALUES ($1, $2, $3, 'list_connections', $4, $4, 'success', 1, 0,
         true, $4::timestamptz + interval '90 days')`,
      [
        "50000000-0000-4000-8000-000000000037",
        otherAccountId,
        otherAuthorizationId,
        new Date("2026-07-31T11:00:00.000Z"),
      ],
    );

    const page = await repository.listForUser(
      clerkUserId,
      new Date("2026-08-01T12:00:00.000Z"),
      null,
      100,
    );
    expect(page).toEqual({
      logs: [
        {
          apiKeyId: null,
          authorizationId: expect.stringMatching(/^mca_[A-Za-z0-9_-]{21}$/u),
          channel: "mcp",
          clientId: "approved-client",
          clientName: "Approved MCP Client",
          completedAt: new Date("2026-07-31T12:00:00.120Z"),
          connectionId: connectionPublicId,
          errorCode: null,
          latencyMs: 120,
          mediaBytes: 0,
          outcome: "success",
          resultCount: 2,
          sendId: null,
          startedAt: new Date("2026-07-31T12:00:00.000Z"),
          toolName: "list_connections",
        },
      ],
      nextCursor: null,
    });
    expect(
      await repository.listForUser(
        otherClerkUserId,
        new Date("2026-08-01T12:00:00.000Z"),
        null,
        100,
      ),
    ).toMatchObject({
      logs: [{ clientId: "other-client" }],
    });
    expect(
      await repository.listForUser("another_user", new Date(), null, 100),
    ).toBeNull();
  });

  test("paginates a stable tenant-scoped 90-day history", async () => {
    await database.query(
      `INSERT INTO public.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, tool_name,
         started_at, completed_at, outcome, result_count, latency_ms,
         quota_reserved, expires_at
       ) VALUES
         ($1, $2, $3, 'list_connections', $4, $4, 'success', 1, 0,
          true, $4::timestamptz + interval '90 days'),
         ($5, $2, $3, 'list_connections', $4, $4, 'success', 2, 0,
          true, $4::timestamptz + interval '90 days')`,
      [
        "50000000-0000-4000-8000-000000000031",
        accountId,
        authorizationId,
        new Date("2026-08-01T11:00:00.000Z"),
        "50000000-0000-4000-8000-000000000032",
      ],
    );

    const first = await repository.listForUser(
      clerkUserId,
      new Date("2026-08-01T12:00:00.000Z"),
      null,
      1,
    );
    expect(first?.logs).toHaveLength(1);
    expect(first?.nextCursor).toMatch(/^tcl_[A-Za-z0-9_-]{21}$/u);
    const second = await repository.listForUser(
      clerkUserId,
      new Date("2026-08-01T12:00:00.000Z"),
      first?.nextCursor ?? null,
      1,
    );
    expect(second?.logs).toHaveLength(1);
    expect(second?.logs[0]?.resultCount).not.toBe(first?.logs[0]?.resultCount);
    expect(second?.nextCursor).toBeNull();
  });

  test("purges expired rows through the bounded restricted-role function", async () => {
    await database.query(
      `INSERT INTO public.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, tool_name,
         started_at, completed_at, outcome, result_count, latency_ms,
         quota_reserved, expires_at
       ) VALUES ($1, $2, $3, 'list_connections',
         statement_timestamp() - interval '91 days',
         statement_timestamp() - interval '91 days', 'success', 0, 0,
         true, statement_timestamp() - interval '1 day')`,
      ["50000000-0000-4000-8000-000000000034", accountId, authorizationId],
    );

    await expect(
      database.query("SELECT public.purge_expired_tool_call_logs($1, $2)", [
        new Date("2099-01-01T00:00:00.000Z"),
        500,
      ]),
    ).rejects.toThrow();
    expect(await repository.purgeExpired(500)).toBe(1);
    expect(
      (await database.query("SELECT id FROM public.tool_call_logs")).rows,
    ).toEqual([]);
  });

  test("lists API-channel Activity Logs with allowlisted key presentation", async () => {
    await database.query(
      `INSERT INTO public.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, channel, api_key_id,
         api_key_public_id, api_key_name, tool_name, started_at, completed_at,
         outcome, result_count, latency_ms, quota_reserved, expires_at,
         connection_public_id
       ) VALUES (
         $1, $2, NULL, 'api', $3, $4, 'Billing automation', 'list_connections',
         $5, $6, 'success', 1, 40, true, $5::timestamptz + interval '90 days',
         $7
       )`,
      [
        "50000000-0000-4000-8000-000000000038",
        accountId,
        "60000000-0000-4000-8000-000000000038",
        "apk_123456789012345678901",
        new Date("2026-07-31T13:00:00.000Z"),
        new Date("2026-07-31T13:00:00.040Z"),
        connectionPublicId,
      ],
    );

    const page = await repository.listForUser(
      clerkUserId,
      new Date("2026-08-01T12:00:00.000Z"),
      null,
      100,
    );
    expect(page).toEqual({
      logs: [
        {
          apiKeyId: "apk_123456789012345678901",
          authorizationId: null,
          channel: "api",
          clientId: "apk_123456789012345678901",
          clientName: "Billing automation",
          completedAt: new Date("2026-07-31T13:00:00.040Z"),
          connectionId: connectionPublicId,
          errorCode: null,
          latencyMs: 40,
          mediaBytes: 0,
          outcome: "success",
          resultCount: 1,
          sendId: null,
          startedAt: new Date("2026-07-31T13:00:00.000Z"),
          toolName: "list_connections",
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(page)).not.toMatch(
      /normal_|digest|credential|phone|payload/iu,
    );
  });
});
