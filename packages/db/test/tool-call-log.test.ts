import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeMcpAuthorizationRepository } from "../src/mcp-authorization";
import { runMigrations } from "../src/migrations";
import {
  makeToolCallLogRepository,
  type ToolCallLogRepository,
} from "../src/tool-call-log";

const accountId = "10000000-0000-4000-8000-000000000036";
const authorizationId = "40000000-0000-4000-8000-000000000036";
const connectionId = "20000000-0000-4000-8000-000000000036";
const connectionPublicId = "con_123456789012345678901";
const clerkUserId = "user_toolcalllogs36";

describe("Tool Call Log repository", () => {
  let database: PGlite;
  let repository: ToolCallLogRepository;

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
        $1, $2, 1, $3, decode('0102', 'hex'), 6
      )`,
      [
        clerkUserId,
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_ciphertext, public_id
       ) VALUES ($1, $2, $3, decode('01', 'hex'), $4)`,
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
    repository = makeToolCallLogRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  test("lists only safe metadata for the owning active Personal Account", async () => {
    await database.query(
      `INSERT INTO app.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, tool_name,
         started_at, completed_at, outcome, error_code, result_count,
         latency_ms, quota_reserved, media_bytes_reserved, expires_at
       ) VALUES
         ($1, $2, $3, 'list_connections', $4, $5, 'success', NULL, 2,
          120, true, 0, $4::timestamptz + interval '90 days'),
         ($6, $2, $3, 'read_messages', $7, $8, 'execution_error',
          'service_unavailable', NULL, 45, true, 0,
          $7::timestamptz + interval '90 days')`,
      [
        "50000000-0000-4000-8000-000000000036",
        accountId,
        authorizationId,
        new Date("2026-07-31T12:00:00.000Z"),
        new Date("2026-07-31T12:00:00.120Z"),
        "50000000-0000-4000-8000-000000000035",
        new Date("2026-04-30T12:00:00.000Z"),
        new Date("2026-04-30T12:00:00.045Z"),
      ],
    );

    const logs = await repository.listForUser(
      clerkUserId,
      new Date("2026-08-01T12:00:00.000Z"),
    );
    expect(logs).toEqual([
      {
        authorizationId: expect.stringMatching(/^mca_[A-Za-z0-9_-]{21}$/u),
        clientId: "approved-client",
        clientName: "Approved MCP Client",
        completedAt: new Date("2026-07-31T12:00:00.120Z"),
        connectionId: null,
        errorCode: null,
        latencyMs: 120,
        mediaBytes: 0,
        outcome: "success",
        resultCount: 2,
        sendId: null,
        startedAt: new Date("2026-07-31T12:00:00.000Z"),
        toolName: "list_connections",
      },
    ]);
    expect(await repository.listForUser("another_user", new Date())).toBeNull();
  });

  test("purges expired rows through the bounded restricted-role function", async () => {
    await database.query(
      `INSERT INTO app.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, tool_name,
         started_at, completed_at, outcome, result_count, latency_ms,
         quota_reserved, expires_at
       ) VALUES ($1, $2, $3, 'list_connections', $4, $4, 'success', 0, 0,
         true, $4::timestamptz + interval '90 days')`,
      [
        "50000000-0000-4000-8000-000000000034",
        accountId,
        authorizationId,
        new Date("2026-04-30T12:00:00.000Z"),
      ],
    );

    expect(
      await repository.purgeExpired(new Date("2026-08-01T12:00:00.000Z"), 500),
    ).toBe(1);
    expect(
      (await database.query("SELECT id FROM app.tool_call_logs")).rows,
    ).toEqual([]);
  });
});
