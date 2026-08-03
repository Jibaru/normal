import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/migrations";

const accountA = "10000000-0000-4000-8000-000000000059";
const accountB = "10000000-0000-4000-8000-000000000060";
const connectionA = "20000000-0000-4000-8000-000000000059";
const connectionB = "20000000-0000-4000-8000-000000000060";

describe("production authorization and isolation matrix", () => {
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
    for (const [user, account] of [
      ["user_isolation59", accountA],
      ["user_isolation60", accountB],
    ] as const) {
      await database.query(
        `SELECT * FROM app_private.admit_personal_account_for_clerk(
          $1, $2, 1, 'arn:aws:kms:us-east-1:111122223333:key/content-root-key',
          decode('0102', 'hex'), 6
        )`,
        [user, account],
      );
    }
    await database.query(
      `INSERT INTO app.whatsapp_connections (
        id, personal_account_id, webhook_ingress_id, display_name_ciphertext,
        public_id, number_suffix, state, state_changed_at
      ) VALUES
        ($1, $2, '30000000-0000-4000-8000-000000000059', NULL,
         'con_123456789012345678959', '0059', 'connected', now()),
        ($3, $4, '30000000-0000-4000-8000-000000000060', NULL,
         'con_123456789012345678960', '0060', 'connected', now())`,
      [connectionA, accountA, connectionB, accountB],
    );
  });

  afterEach(async () => {
    await database.close();
  });

  test("keeps every operational role least-privileged and unable to bypass RLS", async () => {
    const roles = await database.query<{
      rolbypassrls: boolean;
      rolinherit: boolean;
      rolname: string;
      rolsuper: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls, rolinherit
       FROM pg_roles
       WHERE rolname = ANY($1)
       ORDER BY rolname`,
      [
        [
          "whatsapp_api_runtime",
          "whatsapp_webhook_runtime",
          "whatsapp_deletion_runtime",
          "whatsapp_break_glass_requester",
          "whatsapp_break_glass_approver",
          "whatsapp_break_glass_runtime",
        ],
      ],
    );
    expect(roles.rows).toHaveLength(6);
    expect(roles.rows).toEqual(
      roles.rows.map((role) => ({
        rolbypassrls: false,
        rolinherit: false,
        rolname: role.rolname,
        rolsuper: false,
      })),
    );

    for (const role of ["whatsapp_api_runtime", "whatsapp_webhook_runtime"]) {
      await database.exec(`SET ROLE ${role}; BEGIN`);
      try {
        await database.query(
          "SELECT set_config('app.personal_account_id', $1, true)",
          [accountA],
        );
        const visible = await database.query<{ personal_account_id: string }>(
          "SELECT personal_account_id FROM app.whatsapp_connections",
        );
        expect(visible.rows).toEqual([{ personal_account_id: accountA }]);
      } finally {
        await database.exec("ROLLBACK; RESET ROLE");
      }
    }

    for (const role of [
      "whatsapp_deletion_runtime",
      "whatsapp_break_glass_requester",
      "whatsapp_break_glass_approver",
      "whatsapp_break_glass_runtime",
    ]) {
      await database.exec(`SET ROLE ${role}`);
      try {
        await expect(
          database.query("SELECT * FROM app.whatsapp_connections"),
        ).rejects.toThrow();
      } finally {
        await database.exec("RESET ROLE");
      }
    }
  });

  test("rejects cross-account composite relationships inside an API tenant transaction", async () => {
    const authorizationId = "40000000-0000-4000-8000-000000000059";
    await database.query(
      `INSERT INTO app.mcp_authorizations (
        id, personal_account_id, oauth_subject, client_id, client_class, scopes,
        reverified_at, authorized_at, absolute_expires_at
      ) VALUES ($1, $2, $3, 'approved-client', 'approved',
        ARRAY['messages:send']::text[], now(), now(), now() + interval '90 days')`,
      [authorizationId, accountA, "A".repeat(43)],
    );

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountA],
      );
      await expect(
        database.query(
          `INSERT INTO app.mcp_authorization_connections (
            personal_account_id, mcp_authorization_id, whatsapp_connection_id
          ) VALUES ($1, $2, $3)`,
          [accountA, authorizationId, connectionB],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });
});
