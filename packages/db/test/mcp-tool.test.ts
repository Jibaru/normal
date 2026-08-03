import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeMcpAuthorizationRepository } from "../src/mcp-authorization";
import {
  type McpToolConnectionProvider,
  type McpToolRepository,
  makeMcpToolRepository,
} from "../src/mcp-tool";
import { runMigrations } from "../src/migrations";
import type { PersonalAccountConnectionProvider } from "../src/personal-account";

const accountId = "10000000-0000-4000-8000-000000000030";
const authorizationId = "40000000-0000-4000-8000-000000000030";
const oauthSubject = "A".repeat(43);
const connectionA = "con_123456789012345678930";
const connectionB = "con_123456789012345678931";
const connectionLater = "con_123456789012345678932";
const connectionWithoutSuffix = "con_123456789012345678933";
const observedAt = new Date("2026-07-31T12:00:00.000Z");

describe("MCP tool repository", () => {
  let database: PGlite;
  let repository: McpToolRepository;

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
        "user_mcptool30",
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_ciphertext, public_id, number_suffix, state,
         state_changed_at
       ) VALUES
         ('20000000-0000-4000-8000-000000000030', $1,
          '30000000-0000-4000-8000-000000000030', NULL, $2, '1234',
          'connected', $6),
         ('20000000-0000-4000-8000-000000000031', $1,
          '30000000-0000-4000-8000-000000000031', NULL, $3, '5678',
          'deleting', $6),
         ('20000000-0000-4000-8000-000000000032', $1,
          '30000000-0000-4000-8000-000000000032', NULL, $4, '9012',
          'connected', $6),
         ('20000000-0000-4000-8000-000000000033', $1,
          '30000000-0000-4000-8000-000000000033', NULL, $5, NULL,
          'connecting', $6)`,
      [
        accountId,
        connectionA,
        connectionB,
        connectionLater,
        connectionWithoutSuffix,
        observedAt,
      ],
    );

    const provider: McpToolConnectionProvider &
      PersonalAccountConnectionProvider = {
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    const authorizations = makeMcpAuthorizationRepository(provider);
    await authorizations.create({
      authorizationId,
      authorizedAt: observedAt,
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      clerkUserId: "user_mcptool30",
      connectionIds: [connectionA, connectionB, connectionWithoutSuffix],
      expiresAt: new Date("2026-10-29T12:00:00.000Z"),
      oauthSubject,
      reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
      scopes: ["connections:read"],
    });
    repository = makeMcpToolRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  const authorization = {
    authorizationId,
    clientId: "approved-client",
    oauthSubject,
  } as const;

  test("discovers current scopes and lists only explicitly selected non-deleting Connections", async () => {
    const inspected = await repository.inspectAuthorization({
      ...authorization,
      observedAt,
    });
    expect(inspected).toEqual({ scopes: ["connections:read"] });

    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000030",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000030",
      outcome: "started",
    });

    await expect(
      repository.listConnections({
        ...authorization,
        observedAt,
      }),
    ).resolves.toEqual([
      {
        displayName: null,
        numberLastFour: "1234",
        publicId: connectionA,
        state: "connected",
        stateChangedAt: "2026-07-31T12:00:00.000Z",
      },
      {
        displayName: null,
        numberLastFour: null,
        publicId: connectionWithoutSuffix,
        state: "connecting",
        stateChangedAt: "2026-07-31T12:00:00.000Z",
      },
    ]);

    await repository.completeToolCall({
      auditLogId: "50000000-0000-4000-8000-000000000030",
      completedAt: new Date("2026-07-31T12:00:00.025Z"),
      errorCode: null,
      outcome: "success",
      resultCount: 2,
    });
    const persisted = await database.query<{
      error_code: string | null;
      outcome: string;
      quota_reserved: boolean;
      result_count: number | null;
      tool_name: string;
    }>(
      `SELECT tool_name, outcome, error_code, result_count, quota_reserved
       FROM app.tool_call_logs`,
    );
    expect(persisted.rows).toEqual([
      {
        error_code: null,
        outcome: "success",
        quota_reserved: true,
        result_count: 2,
        tool_name: "list_connections",
      },
    ]);
  });

  test("atomically audits rate-limit rejection without another reservation", async () => {
    for (const [index, time] of [
      [30, "2026-07-31T11:59:30.000Z"],
      [31, "2026-07-31T11:59:45.000Z"],
    ] as const) {
      await expect(
        repository.beginToolCall({
          ...authorization,
          auditLogId: `50000000-0000-4000-8000-0000000000${index}`,
          hourLimit: 3,
          minuteLimit: 2,
          observedAt: new Date(time),
          toolName: "list_connections",
        }),
      ).resolves.toMatchObject({ outcome: "started" });
    }

    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000032",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000032",
      outcome: "rate_limited",
      resetsAt: new Date("2026-07-31T12:00:30.000Z"),
      retryAfterSeconds: 30,
    });

    const persisted = await database.query<{
      outcome: string;
      quota_reserved: boolean;
    }>(
      `SELECT outcome, quota_reserved
       FROM app.tool_call_logs
       WHERE id = '50000000-0000-4000-8000-000000000032'`,
    );
    expect(persisted.rows).toEqual([
      { outcome: "rate_limited", quota_reserved: false },
    ]);
  });

  test("reports the reset that restores capacity after a quota reduction", async () => {
    for (const [index, time] of [
      [40, "2026-07-31T11:59:10.000Z"],
      [41, "2026-07-31T11:59:20.000Z"],
      [42, "2026-07-31T11:59:30.000Z"],
    ] as const) {
      await expect(
        repository.beginToolCall({
          ...authorization,
          auditLogId: `50000000-0000-4000-8000-0000000000${index}`,
          hourLimit: 10,
          minuteLimit: 3,
          observedAt: new Date(time),
          toolName: "list_connections",
        }),
      ).resolves.toMatchObject({ outcome: "started" });
    }

    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000043",
        hourLimit: 10,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000043",
      outcome: "rate_limited",
      resetsAt: new Date("2026-07-31T12:00:20.000Z"),
      retryAfterSeconds: 20,
    });
  });

  test("rechecks scope and revocation at audit and protected-read boundaries", async () => {
    await database.query(
      `UPDATE app.mcp_authorizations
       SET scopes = ARRAY['messages:send']::text[]
       WHERE id = $1`,
      [authorizationId],
    );
    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000033",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toMatchObject({ outcome: "authorization_denied" });

    await database.query(
      `UPDATE app.mcp_authorizations
       SET scopes = ARRAY['connections:read']::text[]
       WHERE id = $1`,
      [authorizationId],
    );
    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000034",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await database.query(
      `UPDATE app.mcp_authorizations
       SET state = 'revoked', revoked_at = $2
       WHERE id = $1`,
      [authorizationId, observedAt],
    );
    await expect(
      repository.listConnections({
        ...authorization,
        observedAt,
      }),
    ).resolves.toBeNull();
  });

  test("returns an empty list after every selected Connection is purged", async () => {
    await database.query(
      `DELETE FROM app.whatsapp_connections
       WHERE personal_account_id = $1
         AND public_id IN ($2, $3, $4)`,
      [accountId, connectionA, connectionB, connectionWithoutSuffix],
    );

    await expect(
      repository.inspectAuthorization({
        ...authorization,
        observedAt,
      }),
    ).resolves.toEqual({ scopes: ["connections:read"] });
    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000035",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await expect(
      repository.listConnections({
        ...authorization,
        observedAt,
      }),
    ).resolves.toEqual([]);
  });

  test("rechecks directory scope, selected connection, and joined state for encrypted groups", async () => {
    await database.query(
      `UPDATE app.mcp_authorizations
       SET scopes = ARRAY['directory:read']::text[]
       WHERE id = $1`,
      [authorizationId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connection_key_envelopes (
         personal_account_id, whatsapp_connection_id, account_key_version,
         key_version, nonce, ciphertext
       ) VALUES ($1, '20000000-0000-4000-8000-000000000030', 1, 1,
         decode(repeat('01', 12), 'hex'), decode(repeat('02', 32), 'hex'))`,
      [accountId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_group_directory_states (
         personal_account_id, whatsapp_connection_id, as_of,
         stale, partial, updated_at
       ) VALUES ($1, '20000000-0000-4000-8000-000000000030', $2,
         false, false, $2)`,
      [accountId, observedAt],
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: null,
      }),
    ).resolves.toMatchObject({ groups: [] });
    await expect(
      repository.loadGroupSearchMaterial({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
      }),
    ).resolves.toBeNull();
    await database.query(
      `INSERT INTO app.whatsapp_connection_secrets (
         personal_account_id, whatsapp_connection_id, credential_ciphertext,
         credential_ciphertext_version, credential_key_version,
         credential_nonce
       ) VALUES ($1, '20000000-0000-4000-8000-000000000030',
         decode(repeat('07', 32), 'hex'), 1, 1,
         decode(repeat('08', 12), 'hex'))`,
      [accountId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_groups (
         id, personal_account_id, whatsapp_connection_id, public_id,
         provider_locator, display_name_ciphertext_version,
         display_name_key_version, display_name_nonce,
         display_name_ciphertext, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, name_prefix_indexes, joined, last_observed_at,
         created_at, updated_at
       ) VALUES (
         '30000000-0000-4000-8000-000000000039', $1,
         '20000000-0000-4000-8000-000000000030',
         'grp_123456789012345678939', $2, 1, 1,
         decode(repeat('03', 12), 'hex'), decode(repeat('04', 20), 'hex'),
         1, 1, decode(repeat('05', 12), 'hex'),
         decode(repeat('06', 20), 'hex'),
         ARRAY[$4::app.group_name_blind_index], true, $3, $3, $3
       )`,
      [accountId, `wi1_${"A".repeat(43)}`, observedAt, `gi1_${"A".repeat(43)}`],
    );

    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000039",
        hourLimit: 10,
        minuteLimit: 10,
        observedAt,
        toolName: "list_groups",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await expect(
      repository.loadGroupSearchMaterial({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
      }),
    ).resolves.toMatchObject({
      identityKey: { keyVersion: 1, version: 1 },
    });
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: `gi1_${"B".repeat(43)}`,
      }),
    ).resolves.toMatchObject({ groups: [] });
    const page = await repository.listGroups({
      ...authorization,
      connectionPublicId: connectionA,
      observedAt,
      searchIndex: `gi1_${"A".repeat(43)}`,
    });
    expect(page).toMatchObject({
      asOf: "2026-07-31T12:00:00.000Z",
      groups: [
        {
          id: "30000000-0000-4000-8000-000000000039",
          publicId: "grp_123456789012345678939",
        },
      ],
      partial: false,
      stale: false,
    });
    expect(page?.groups[0]?.displayName?.ciphertext).not.toContain("Family");

    await database.query(
      `UPDATE app.whatsapp_groups
       SET joined = false,
           name_prefix_indexes = ARRAY[]::app.group_name_blind_index[]
       WHERE public_id = 'grp_123456789012345678939'`,
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: `gi1_${"A".repeat(43)}`,
      }),
    ).resolves.toMatchObject({ groups: [] });
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionLater,
        observedAt,
        searchIndex: null,
      }),
    ).resolves.toBeNull();

    await database.query(
      `UPDATE app.whatsapp_groups SET joined = true
       WHERE public_id = 'grp_123456789012345678939'`,
    );
    await database.query(
      `UPDATE app.mcp_authorizations
       SET state = 'revoked', revoked_at = $2
       WHERE id = $1`,
      [authorizationId, observedAt],
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: null,
      }),
    ).resolves.toBeNull();
    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountId],
      );
      const protectedBoundary = await database.query(
        `SELECT * FROM app_private.load_mcp_group_projection_material(
          $1, $2, $3, $4, $5
        )`,
        [
          authorizationId,
          authorization.oauthSubject,
          authorization.clientId,
          observedAt,
          connectionA,
        ],
      );
      expect(protectedBoundary.rows).toEqual([]);
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });
});
