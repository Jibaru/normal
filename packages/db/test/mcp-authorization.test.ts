import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type McpAuthorizationRepository,
  makeMcpAuthorizationRepository,
} from "../src/mcp-authorization";
import { runMigrations } from "../src/migrations";

const accountId = "10000000-0000-4000-8000-000000000027";
const authorizationId = "40000000-0000-4000-8000-000000000027";
const connectionA = "con_123456789012345678901";
const connectionB = "con_123456789012345678902";
const oauthSubject = "A".repeat(43);

describe("MCP Authorization repository", () => {
  let database: PGlite;
  let repository: McpAuthorizationRepository;

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
        "user_authorization27",
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_ciphertext, public_id
       ) VALUES
         ('20000000-0000-4000-8000-000000000027', $1,
          '30000000-0000-4000-8000-000000000027', decode('01', 'hex'), $2),
         ('20000000-0000-4000-8000-000000000028', $1,
          '30000000-0000-4000-8000-000000000028', decode('02', 'hex'), $3)`,
      [accountId, connectionA, connectionB],
    );
    repository = makeMcpAuthorizationRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("persists only the explicitly selected connections and independent scopes", async () => {
    expect(
      await repository.create({
        authorizationId,
        authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
        clientClass: "approved",
        clientId: "approved-client",
        clerkUserId: "user_authorization27",
        connectionIds: [connectionA],
        expiresAt: new Date("2026-10-29T12:00:00.000Z"),
        oauthSubject,
        reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
        scopes: ["messages:send"],
      }),
    ).toBe(true);

    const persisted = await database.query<{
      public_id: string;
      scopes: string[];
    }>(
      `SELECT connections.public_id, authorizations.scopes
       FROM app.mcp_authorizations AS authorizations
       JOIN app.mcp_authorization_connections AS selected
         ON selected.mcp_authorization_id = authorizations.id
       JOIN app.whatsapp_connections AS connections
         ON connections.id = selected.whatsapp_connection_id`,
    );
    expect(persisted.rows).toEqual([
      { public_id: connectionA, scopes: ["messages:send"] },
    ]);

    await database.query(
      `INSERT INTO app.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_ciphertext, public_id
       ) VALUES (
         '20000000-0000-4000-8000-000000000029', $1,
         '30000000-0000-4000-8000-000000000029', decode('03', 'hex'),
         'con_123456789012345678903'
       )`,
      [accountId],
    );
    const selectedAfterLaterConnection = await database.query<{
      public_id: string;
    }>(
      `SELECT connections.public_id
       FROM app.mcp_authorization_connections AS selected
       JOIN app.whatsapp_connections AS connections
         ON connections.id = selected.whatsapp_connection_id
       WHERE selected.mcp_authorization_id = $1`,
      [authorizationId],
    );
    expect(selectedAfterLaterConnection.rows).toEqual([
      { public_id: connectionA },
    ]);
  });

  test("uses the restricted role and fails closed for cross-account selections or expiry", async () => {
    expect(await repository.listConnections("user_authorization27")).toEqual([
      { connectionId: connectionA },
      { connectionId: connectionB },
    ]);
    expect(
      await repository.create({
        authorizationId,
        authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
        clientClass: "approved",
        clientId: "approved-client",
        clerkUserId: "user_authorization27",
        connectionIds: ["con_999999999999999999999"],
        expiresAt: new Date("2026-10-29T12:00:00.000Z"),
        oauthSubject,
        reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
        scopes: ["connections:read"],
      }),
    ).toBe(false);

    await repository.create({
      authorizationId,
      authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
      clientClass: "approved",
      clientId: "approved-client",
      clerkUserId: "user_authorization27",
      connectionIds: [connectionA],
      expiresAt: new Date("2026-10-29T12:00:00.000Z"),
      oauthSubject,
      reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
      scopes: ["connections:read"],
    });

    expect(
      await repository.isActive({
        authorizationId,
        clientId: "approved-client",
        observedAt: new Date("2026-08-01T12:00:00.000Z"),
        oauthSubject,
      }),
    ).toBe(true);
    expect(
      await repository.isActive({
        authorizationId,
        clientId: "approved-client",
        observedAt: new Date("2026-10-29T12:00:00.000Z"),
        oauthSubject,
      }),
    ).toBe(false);
  });

  test("enforces recent reverification and the absolute session bound in Neon", async () => {
    await expect(
      repository.create({
        authorizationId: "40000000-0000-4000-8000-000000000028",
        authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
        clientClass: "approved",
        clientId: "approved-client",
        clerkUserId: "user_authorization27",
        connectionIds: [connectionA],
        expiresAt: new Date("2026-10-29T12:00:00.000Z"),
        oauthSubject: "B".repeat(43),
        reverifiedAt: new Date("2026-07-31T11:55:00.000Z"),
        scopes: ["connections:read"],
      }),
    ).rejects.toThrow();

    await expect(
      repository.create({
        authorizationId: "40000000-0000-4000-8000-000000000029",
        authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
        clientClass: "approved",
        clientId: "approved-client",
        clerkUserId: "user_authorization27",
        connectionIds: [connectionA],
        expiresAt: new Date("2026-10-29T12:00:00.001Z"),
        oauthSubject: "C".repeat(43),
        reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
        scopes: ["connections:read"],
      }),
    ).rejects.toThrow();
  });
});
