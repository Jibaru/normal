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
const credentialHash = new Uint8Array(32).fill(1);
const rotatedCredentialHash = new Uint8Array(32).fill(2);
const secondAccountId = "10000000-0000-4000-8000-000000000029";

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
      `SELECT * FROM public.admit_personal_account_for_clerk(
        $1, $2, 1, $3, decode('0102', 'hex'), 6
      )`,
      [
        "user_authorization27",
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
          id, personal_account_id, webhook_ingress_id,
          display_name_fallback, public_id, number_suffix
        ) VALUES
          ('20000000-0000-4000-8000-000000000027', $1,
           '30000000-0000-4000-8000-000000000027', 'Bright Badger', $2,
           '3456'),
          ('20000000-0000-4000-8000-000000000028', $1,
           '30000000-0000-4000-8000-000000000028', 'Calm Falcon', $3,
           '7890')`,
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
        clientName: "Approved MCP Client",
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
       FROM public.mcp_authorizations AS authorizations
       JOIN public.mcp_authorization_connections AS selected
         ON selected.mcp_authorization_id = authorizations.id
       JOIN public.whatsapp_connections AS connections
         ON connections.id = selected.whatsapp_connection_id`,
    );
    expect(persisted.rows).toEqual([
      { public_id: connectionA, scopes: ["messages:send"] },
    ]);

    await database.query(
      `INSERT INTO public.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_fallback, public_id
       ) VALUES (
         '20000000-0000-4000-8000-000000000029', $1,
         '30000000-0000-4000-8000-000000000029', 'Clever Fox',
         'con_123456789012345678903'
       )`,
      [accountId],
    );
    const selectedAfterLaterConnection = await database.query<{
      public_id: string;
    }>(
      `SELECT connections.public_id
       FROM public.mcp_authorization_connections AS selected
       JOIN public.whatsapp_connections AS connections
         ON connections.id = selected.whatsapp_connection_id
       WHERE selected.mcp_authorization_id = $1`,
      [authorizationId],
    );
    expect(selectedAfterLaterConnection.rows).toEqual([
      { public_id: connectionA },
    ]);
  });

  test("lists safe grant details and idempotently revokes authorization and refresh access for only the owning User", async () => {
    await repository.create({
      authorizationId,
      authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      clerkUserId: "user_authorization27",
      connectionIds: [connectionA, connectionB],
      expiresAt: new Date("2026-10-29T12:00:00.000Z"),
      oauthSubject,
      reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
      scopes: ["connections:read", "messages:send"],
    });
    expect(
      await repository.registerRefreshCredential({
        clientId: "approved-client",
        credentialHash,
        oauthSubject,
        observedAt: new Date("2026-07-31T12:01:00.000Z"),
      }),
    ).toBe(true);

    const listed = await repository.list(
      "user_authorization27",
      new Date("2026-08-01T12:00:00.000Z"),
    );
    expect(listed).toHaveLength(1);
    expect(listed?.[0]).toMatchObject({
      authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      connectionIds: [connectionA, connectionB],
      expired: false,
      expiresAt: new Date("2026-10-29T12:00:00.000Z"),
      revoked: false,
      revokedAt: null,
      scopes: ["connections:read", "messages:send"],
    });
    expect(listed?.[0]?.authorizationId).toMatch(/^mca_[A-Za-z0-9_-]{21}$/u);
    expect(listed?.[0]).not.toHaveProperty("oauthSubject");
    expect(listed?.[0]).not.toHaveProperty("credentialHash");
    expect(
      await repository.isActive({
        authorizationId,
        observedAt: new Date("2026-08-01T12:00:00.000Z"),
        oauthSubject,
      }),
    ).toBe(true);

    const publicAuthorizationId = listed?.[0]?.authorizationId;
    if (publicAuthorizationId === undefined) {
      throw new Error("authorization was not listed");
    }
    const firstRevocation = await repository.revoke({
      authorizationId: publicAuthorizationId,
      clerkUserId: "user_authorization27",
      revokedAt: new Date("2026-08-01T12:05:00.000Z"),
    });
    const replayedRevocation = await repository.revoke({
      authorizationId: publicAuthorizationId,
      clerkUserId: "user_authorization27",
      revokedAt: new Date("2026-08-01T13:05:00.000Z"),
    });
    expect(firstRevocation).toEqual({
      revokedAt: new Date("2026-08-01T12:05:00.000Z"),
    });
    expect(replayedRevocation).toEqual(firstRevocation);
    expect(
      await repository.isActive({
        authorizationId,
        clientId: "approved-client",
        observedAt: new Date("2026-08-01T12:05:00.000Z"),
        oauthSubject,
      }),
    ).toBe(false);
    expect(
      await repository.rotateRefreshCredential(
        {
          clientId: "approved-client",
          credentialHash,
          oauthSubject,
          observedAt: new Date("2026-08-01T12:05:00.000Z"),
        },
        async () => ({
          credentialHash: rotatedCredentialHash,
          value: "must-not-issue",
        }),
      ),
    ).toEqual({ outcome: "invalid" });

    const afterRevocation = await repository.list(
      "user_authorization27",
      new Date("2026-10-29T12:00:00.000Z"),
    );
    expect(afterRevocation?.[0]).toMatchObject({
      expired: true,
      revoked: true,
      revokedAt: new Date("2026-08-01T12:05:00.000Z"),
    });

    await database.query(
      `SELECT * FROM public.admit_personal_account_for_clerk(
        $1, $2, 1, $3, decode('0304', 'hex'), 6
      )`,
      [
        "user_authorization29",
        secondAccountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    expect(
      await repository.revoke({
        authorizationId: publicAuthorizationId,
        clerkUserId: "user_authorization29",
        revokedAt: new Date("2026-08-01T14:05:00.000Z"),
      }),
    ).toBeNull();
    expect(
      await repository.revoke({
        authorizationId: "mca_999999999999999999999",
        clerkUserId: "user_authorization27",
        revokedAt: new Date("2026-08-01T14:05:00.000Z"),
      }),
    ).toBeNull();
    expect(
      await repository.list(
        "user_authorization29",
        new Date("2026-08-01T14:05:00.000Z"),
      ),
    ).toEqual([]);
  });

  test("uses the restricted role and fails closed for cross-account selections or expiry", async () => {
    expect(await repository.listConnections("user_authorization27")).toEqual([
      {
        accountKey: null,
        connectionId: connectionA,
        connectionKey: null,
        displayName: null,
        displayNameFallback: "Bright Badger",
        numberSuffix: "3456",
      },
      {
        accountKey: null,
        connectionId: connectionB,
        connectionKey: null,
        displayName: null,
        displayNameFallback: "Calm Falcon",
        numberSuffix: "7890",
      },
    ]);
    expect(
      await repository.create({
        authorizationId,
        authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
        clientClass: "approved",
        clientId: "approved-client",
        clientName: "Approved MCP Client",
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
      clientName: "Approved MCP Client",
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
        clientName: "Approved MCP Client",
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
        clientName: "Approved MCP Client",
        clerkUserId: "user_authorization27",
        connectionIds: [connectionA],
        expiresAt: new Date("2026-10-29T12:00:00.001Z"),
        oauthSubject: "C".repeat(43),
        reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
        scopes: ["connections:read"],
      }),
    ).rejects.toThrow();
  });

  test("rotates a refresh credential once and revokes the family when the consumed credential is reused", async () => {
    await repository.create({
      authorizationId,
      authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      clerkUserId: "user_authorization27",
      connectionIds: [connectionA],
      expiresAt: new Date("2026-10-29T12:00:00.000Z"),
      oauthSubject,
      reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
      scopes: ["connections:read"],
    });

    expect(
      await repository.registerRefreshCredential({
        clientId: "approved-client",
        credentialHash,
        oauthSubject,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      }),
    ).toBe(true);

    let issueCount = 0;
    const rotation = await repository.rotateRefreshCredential(
      {
        clientId: "approved-client",
        credentialHash,
        oauthSubject,
        observedAt: new Date("2026-08-01T12:00:00.000Z"),
      },
      async () => {
        issueCount += 1;
        return {
          credentialHash: rotatedCredentialHash,
          value: "new-token-pair",
        };
      },
    );

    expect(rotation).toEqual({
      outcome: "rotated",
      value: "new-token-pair",
    });
    expect(issueCount).toBe(1);

    const persisted = await database.query<{
      consumed_at: Date | null;
      credential_hash: Uint8Array;
    }>(
      `SELECT credential_hash, consumed_at
       FROM public.mcp_refresh_credentials
       WHERE mcp_authorization_id = $1
       ORDER BY issued_at`,
      [authorizationId],
    );
    expect(persisted.rows).toHaveLength(2);
    expect(persisted.rows[0]?.consumed_at).not.toBeNull();
    expect(persisted.rows[1]?.consumed_at).toBeNull();

    const reuse = await repository.rotateRefreshCredential(
      {
        clientId: "approved-client",
        credentialHash,
        oauthSubject,
        observedAt: new Date("2026-08-01T12:00:01.000Z"),
      },
      async () => {
        issueCount += 1;
        return {
          credentialHash: new Uint8Array(32).fill(3),
          value: "must-not-be-issued",
        };
      },
    );
    expect(reuse).toEqual({ outcome: "reuse" });
    expect(issueCount).toBe(1);
    expect(
      await repository.isActive({
        authorizationId,
        clientId: "approved-client",
        observedAt: new Date("2026-08-01T12:00:02.000Z"),
        oauthSubject,
      }),
    ).toBe(false);
  });

  test("denies inactivity and rechecks the current User, Personal Account, MCP Authorization, and selected connections", async () => {
    await repository.create({
      authorizationId,
      authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      clerkUserId: "user_authorization27",
      connectionIds: [connectionA],
      expiresAt: new Date("2026-10-29T12:00:00.000Z"),
      oauthSubject,
      reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
      scopes: ["connections:read"],
    });
    await repository.registerRefreshCredential({
      clientId: "approved-client",
      credentialHash,
      oauthSubject,
      observedAt: new Date("2026-07-31T12:00:01.000Z"),
    });

    let issueCount = 0;
    const inactive = await repository.rotateRefreshCredential(
      {
        clientId: "approved-client",
        credentialHash,
        oauthSubject,
        observedAt: new Date("2026-08-30T12:00:01.000Z"),
      },
      async () => {
        issueCount += 1;
        return {
          credentialHash: rotatedCredentialHash,
          value: "must-not-be-issued",
        };
      },
    );
    expect(inactive).toEqual({ outcome: "invalid" });

    await database.query(
      "DELETE FROM public.clerk_identities WHERE personal_account_id = $1",
      [accountId],
    );
    const missingUser = await repository.rotateRefreshCredential(
      {
        clientId: "approved-client",
        credentialHash,
        oauthSubject,
        observedAt: new Date("2026-08-01T12:00:00.000Z"),
      },
      async () => {
        issueCount += 1;
        return {
          credentialHash: rotatedCredentialHash,
          value: "must-not-be-issued",
        };
      },
    );
    expect(missingUser).toEqual({ outcome: "invalid" });

    await database.query(
      `INSERT INTO public.clerk_identities (
         clerk_user_id, personal_account_id
       ) VALUES ($1, $2)`,
      ["user_authorization27", accountId],
    );
    await database.query(
      "UPDATE public.personal_accounts SET state = 'deleting' WHERE id = $1",
      [accountId],
    );
    expect(
      await repository.rotateRefreshCredential(
        {
          clientId: "approved-client",
          credentialHash,
          oauthSubject,
          observedAt: new Date("2026-08-01T12:00:00.000Z"),
        },
        async () => {
          issueCount += 1;
          return {
            credentialHash: rotatedCredentialHash,
            value: "must-not-be-issued",
          };
        },
      ),
    ).toEqual({ outcome: "invalid" });

    await database.query(
      "UPDATE public.personal_accounts SET state = 'active' WHERE id = $1",
      [accountId],
    );
    await database.query(
      `UPDATE public.mcp_authorizations
       SET state = 'revoked', revoked_at = $2
       WHERE id = $1`,
      [authorizationId, new Date("2026-08-01T11:00:00.000Z")],
    );
    expect(
      await repository.rotateRefreshCredential(
        {
          clientId: "approved-client",
          credentialHash,
          oauthSubject,
          observedAt: new Date("2026-08-01T12:00:00.000Z"),
        },
        async () => {
          issueCount += 1;
          return {
            credentialHash: rotatedCredentialHash,
            value: "must-not-be-issued",
          };
        },
      ),
    ).toEqual({ outcome: "invalid" });

    await database.query(
      `UPDATE public.mcp_authorizations
       SET state = 'active', revoked_at = NULL
       WHERE id = $1`,
      [authorizationId],
    );
    await database.query(
      `DELETE FROM public.mcp_authorization_connections
       WHERE mcp_authorization_id = $1`,
      [authorizationId],
    );
    expect(
      await repository.rotateRefreshCredential(
        {
          clientId: "approved-client",
          credentialHash,
          oauthSubject,
          observedAt: new Date("2026-08-01T12:00:00.000Z"),
        },
        async () => {
          issueCount += 1;
          return {
            credentialHash: rotatedCredentialHash,
            value: "must-not-be-issued",
          };
        },
      ),
    ).toEqual({ outcome: "invalid" });
    expect(issueCount).toBe(0);
  });

  test("caps refresh credentials at the 90-day absolute authorization session", async () => {
    await repository.create({
      authorizationId,
      authorizedAt: new Date("2026-05-01T12:00:00.000Z"),
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      clerkUserId: "user_authorization27",
      connectionIds: [connectionA],
      expiresAt: new Date("2026-07-30T12:00:00.000Z"),
      oauthSubject,
      reverifiedAt: new Date("2026-05-01T11:59:00.000Z"),
      scopes: ["connections:read"],
    });
    expect(
      await repository.registerRefreshCredential({
        clientId: "approved-client",
        credentialHash,
        oauthSubject,
        observedAt: new Date("2026-07-29T12:00:00.000Z"),
      }),
    ).toBe(true);

    const persisted = await database.query<{ inactive_expires_at: Date }>(
      `SELECT inactive_expires_at
       FROM public.mcp_refresh_credentials
       WHERE mcp_authorization_id = $1`,
      [authorizationId],
    );
    expect(persisted.rows[0]?.inactive_expires_at).toEqual(
      new Date("2026-07-30T12:00:00.000Z"),
    );

    expect(
      await repository.rotateRefreshCredential(
        {
          clientId: "approved-client",
          credentialHash,
          oauthSubject,
          observedAt: new Date("2026-07-30T12:00:00.000Z"),
        },
        async () => ({
          credentialHash: rotatedCredentialHash,
          value: "must-not-be-issued",
        }),
      ),
    ).toEqual({ outcome: "invalid" });
  });
});
