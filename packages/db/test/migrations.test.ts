import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  EXPECTED_SCHEMA_VERSION,
  MigrationDriftError,
  runMigrations,
} from "../src/migrations";
import { assertExpectedSchemaVersion } from "../src/readiness";

const accountA = "10000000-0000-4000-8000-000000000001";
const accountB = "10000000-0000-4000-8000-000000000002";
const connectionA = "20000000-0000-4000-8000-000000000001";
const connectionB = "20000000-0000-4000-8000-000000000002";
const ingressA = "30000000-0000-4000-8000-000000000001";

describe("production migrations", () => {
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
  });

  afterEach(async () => {
    await database.close();
  });

  test("applies the versioned schema once and records its checksum", async () => {
    await runMigrations(database);
    await runMigrations(database);

    const result = await database.query<{
      checksum: string;
      version: number;
    }>(
      "SELECT version, checksum FROM app_private.schema_migrations ORDER BY version",
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.version).toBe(EXPECTED_SCHEMA_VERSION);
    expect(result.rows[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  test("refuses an applied migration whose checksum has changed", async () => {
    await runMigrations(database);
    await database.query(
      `UPDATE app_private.schema_migrations
       SET checksum = repeat('0', 64)
       WHERE version = $1`,
      [EXPECTED_SCHEMA_VERSION],
    );

    await expect(runMigrations(database)).rejects.toBeInstanceOf(
      MigrationDriftError,
    );
  });

  test("exposes only the schema version needed by restricted readiness", async () => {
    await runMigrations(database);

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      await expect(
        assertExpectedSchemaVersion(database),
      ).resolves.toBeUndefined();
      await expect(
        database.query(
          "DELETE FROM app_private.schema_migrations WHERE version = 1",
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("removes elevated membership and leaves runtime roles restricted", async () => {
    await runMigrations(database);

    const roles = await database.query<{
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolname: string;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(`
      SELECT
        rolname,
        rolsuper,
        rolcreatedb,
        rolcreaterole,
        rolreplication,
        rolbypassrls,
        rolinherit
      FROM pg_catalog.pg_roles
      WHERE rolname IN ('whatsapp_api_runtime', 'whatsapp_webhook_runtime')
      ORDER BY rolname
    `);
    const memberships = await database.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM pg_catalog.pg_auth_members memberships
      JOIN pg_catalog.pg_roles granted_role
        ON granted_role.oid = memberships.roleid
      JOIN pg_catalog.pg_roles member_role
        ON member_role.oid = memberships.member
      WHERE granted_role.rolname = 'neon_superuser'
        AND member_role.rolname IN (
          'whatsapp_api_runtime',
          'whatsapp_webhook_runtime'
        )
    `);

    expect(roles.rows).toEqual([
      {
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolname: "whatsapp_api_runtime",
        rolreplication: false,
        rolsuper: false,
      },
      {
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolname: "whatsapp_webhook_runtime",
        rolreplication: false,
        rolsuper: false,
      },
    ]);
    expect(memberships.rows[0]?.count).toBe(0);

    const runtimeOwnedTables = await database.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM pg_catalog.pg_tables
      WHERE schemaname IN ('app', 'app_private')
        AND tableowner IN (
          'whatsapp_api_runtime',
          'whatsapp_webhook_runtime'
        )
    `);
    expect(runtimeOwnedTables.rows[0]?.count).toBe(0);
  });

  test("isolates reads and writes to transaction-local Personal Account context", async () => {
    await runMigrations(database);
    await seedTenants(database);

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      const withoutContext = await database.query(
        "SELECT id FROM app.whatsapp_connections",
      );
      expect(withoutContext.rows).toEqual([]);
      await expect(
        database.query(
          `INSERT INTO app.whatsapp_connections
            (personal_account_id, id, webhook_ingress_id, display_name_ciphertext)
           VALUES ($1, $2, gen_random_uuid(), decode('01', 'hex'))`,
          [accountA, "20000000-0000-4000-8000-000000000003"],
        ),
      ).rejects.toThrow();
      await database.exec("ROLLBACK; SET ROLE whatsapp_api_runtime; BEGIN");

      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountA],
      );
      const accountRows = await database.query<{ id: string }>(
        "SELECT id FROM app.whatsapp_connections ORDER BY id",
      );
      expect(accountRows.rows).toEqual([{ id: connectionA }]);

      await expect(
        database.query(
          `INSERT INTO app.whatsapp_connections
            (personal_account_id, id, webhook_ingress_id, display_name_ciphertext)
           VALUES ($1, $2, gen_random_uuid(), decode('01', 'hex'))`,
          [accountB, "20000000-0000-4000-8000-000000000004"],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("rejects cross-Personal Account relationships through composite keys", async () => {
    await runMigrations(database);
    await seedTenants(database);

    await expect(
      database.query(
        `INSERT INTO app.whatsapp_connection_secrets
          (personal_account_id, whatsapp_connection_id, credential_ciphertext)
         VALUES ($1, $2, decode('01', 'hex'))`,
        [accountB, connectionA],
      ),
    ).rejects.toThrow();
  });

  test("limits fixed-search-path bootstrap functions to their runtime identities", async () => {
    await runMigrations(database);
    await seedTenants(database);

    const functions = await database.query<{
      config: Array<string>;
      proname: string;
      prosecdef: boolean;
    }>(`
      SELECT proname, prosecdef, proconfig AS config
      FROM pg_catalog.pg_proc
      JOIN pg_catalog.pg_namespace
        ON pg_namespace.oid = pg_proc.pronamespace
      WHERE pg_namespace.nspname = 'app_private'
        AND proname LIKE 'bootstrap_%'
      ORDER BY proname
    `);
    expect(functions.rows).toEqual([
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_personal_account_for_clerk",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_whatsapp_connection_for_ingress",
        prosecdef: true,
      },
    ]);

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const clerkLookup = await database.query<{ account_id: string }>(
        "SELECT app_private.bootstrap_personal_account_for_clerk($1) AS account_id",
        ["clerk_user_a"],
      );
      expect(clerkLookup.rows[0]?.account_id).toBe(accountA);
      await expect(
        database.query(
          "SELECT * FROM app_private.bootstrap_whatsapp_connection_for_ingress($1)",
          [ingressA],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }

    await database.exec("SET ROLE whatsapp_webhook_runtime");
    try {
      const ingressLookup = await database.query<{
        personal_account_id: string;
        whatsapp_connection_id: string;
      }>(
        "SELECT * FROM app_private.bootstrap_whatsapp_connection_for_ingress($1)",
        [ingressA],
      );
      expect(ingressLookup.rows).toEqual([
        {
          personal_account_id: accountA,
          whatsapp_connection_id: connectionA,
        },
      ]);
      await expect(
        database.query(
          "SELECT app_private.bootstrap_personal_account_for_clerk($1)",
          ["clerk_user_a"],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }
  });
});

const seedTenants = async (database: PGlite) => {
  await database.query(
    `INSERT INTO app.personal_accounts (id, state)
     VALUES ($1, 'active'), ($2, 'active')`,
    [accountA, accountB],
  );
  await database.query(
    `INSERT INTO app_private.clerk_identities
      (clerk_user_id, personal_account_id)
     VALUES ('clerk_user_a', $1), ('clerk_user_b', $2)`,
    [accountA, accountB],
  );
  await database.query(
    `INSERT INTO app.whatsapp_connections
      (personal_account_id, id, webhook_ingress_id, display_name_ciphertext)
     VALUES
      ($1, $2, $3, decode('01', 'hex')),
      ($4, $5, gen_random_uuid(), decode('02', 'hex'))`,
    [accountA, connectionA, ingressA, accountB, connectionB],
  );
};
