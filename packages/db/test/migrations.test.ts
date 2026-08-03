import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  EXPECTED_SCHEMA_VERSION,
  MigrationDriftError,
  runMigrations,
} from "../src/migrations";
import { assertExpectedSchemaVersion } from "../src/readiness";

const accountA = "10000000-0000-4000-8000-000000000001";
const accountB = "10000000-0000-4000-8000-000000000002";
const accountC = "10000000-0000-4000-8000-000000000003";
const accountD = "10000000-0000-4000-8000-000000000004";
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

    expect(result.rows).toHaveLength(EXPECTED_SCHEMA_VERSION);
    expect(result.rows.at(-1)?.version).toBe(EXPECTED_SCHEMA_VERSION);
    expect(
      result.rows.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)),
    ).toBe(true);
  });

  test("clears only retention limitations superseded by a complete Directory snapshot", async () => {
    await runMigrations(database);
    await seedTenants(database);
    const initialSnapshot = new Date("2026-07-31T12:00:00.000Z");
    const partialSnapshot = new Date("2026-07-31T12:01:00.000Z");
    const completeSnapshot = new Date("2026-07-31T12:02:00.000Z");

    await database.query(
      `INSERT INTO app.directory_contact_projections (
         personal_account_id, whatsapp_connection_id, as_of,
         snapshot_observed_at, stale, partial, retention_limited, updated_at
       ) VALUES ($1, $2, $3, $3, false, true, true, $3)`,
      [accountA, connectionA, initialSnapshot],
    );
    await database.query(
      `INSERT INTO app.whatsapp_group_directory_states (
         personal_account_id, whatsapp_connection_id, as_of,
         snapshot_observed_at, stale, partial, retention_limited, updated_at
       ) VALUES ($1, $2, $3, $3, false, true, true, $3)`,
      [accountA, connectionA, initialSnapshot],
    );

    for (const table of [
      "directory_contact_projections",
      "whatsapp_group_directory_states",
    ]) {
      await database.query(
        `UPDATE app.${table}
         SET as_of = $3, snapshot_observed_at = $3, updated_at = $3
         WHERE personal_account_id = $1
           AND whatsapp_connection_id = $2`,
        [accountA, connectionA, partialSnapshot],
      );
      const partial = await database.query<{ retention_limited: boolean }>(
        `SELECT retention_limited FROM app.${table}
         WHERE personal_account_id = $1
           AND whatsapp_connection_id = $2`,
        [accountA, connectionA],
      );
      expect(partial.rows).toEqual([{ retention_limited: true }]);

      await database.query(
        `UPDATE app.${table}
         SET as_of = $3, snapshot_observed_at = $3,
             partial = false, updated_at = $3
         WHERE personal_account_id = $1
           AND whatsapp_connection_id = $2`,
        [accountA, connectionA, completeSnapshot],
      );
      const complete = await database.query<{ retention_limited: boolean }>(
        `SELECT retention_limited FROM app.${table}
         WHERE personal_account_id = $1
           AND whatsapp_connection_id = $2`,
        [accountA, connectionA],
      );
      expect(complete.rows).toEqual([{ retention_limited: false }]);
    }
  });

  test("preserves an activated connection ingress identity when upgrading from version 11", async () => {
    const migrationsDirectory = new URL("../migrations/", import.meta.url);
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort();
    await database.exec(`
      CREATE SCHEMA app_private;
      CREATE TABLE app_private.schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL,
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      );
    `);
    for (const migrationFile of migrationFiles.slice(0, 11)) {
      await database.exec(
        await readFile(new URL(migrationFile, migrationsDirectory), "utf8"),
      );
    }

    const setupId = "cst_000000000000000000001";
    await database.query(
      `INSERT INTO app.personal_accounts (id, state)
       VALUES ($1, 'active')`,
      [accountA],
    );
    await database.query(
      `INSERT INTO app.connection_setups (
        id,
        personal_account_id,
        idempotency_key,
        state,
        number_ciphertext_version,
        number_key_version,
        number_nonce,
        number_ciphertext,
        created_at,
        expires_at,
        updated_at
      )
      VALUES (
        $1, $2, '000000000000000000001', 'activated', 1, 1,
        decode(repeat('01', 12), 'hex'),
        decode(repeat('02', 17), 'hex'),
        '2026-07-31T12:00:00.000Z',
        '2026-07-31T12:15:00.000Z',
        '2026-07-31T12:01:00.000Z'
      )`,
      [setupId, accountA],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connections (
        id,
        personal_account_id,
        webhook_ingress_id,
        connection_setup_id
      )
      VALUES ($1, $2, $3, $4)`,
      [connectionA, accountA, ingressA, setupId],
    );

    const migration12 = migrationFiles[11];
    if (migration12 === undefined) throw new Error("migration 12 is missing");
    await database.exec(
      await readFile(new URL(migration12, migrationsDirectory), "utf8"),
    );

    const upgraded = await database.query<{
      connection_ingress_id: string;
      setup_ingress_id: string;
    }>(
      `SELECT
         connections.webhook_ingress_id AS connection_ingress_id,
         setups.webhook_ingress_id AS setup_ingress_id
       FROM app.whatsapp_connections AS connections
       JOIN app.connection_setups AS setups
         ON setups.personal_account_id = connections.personal_account_id
        AND setups.id = connections.connection_setup_id
       WHERE connections.id = $1`,
      [connectionA],
    );
    expect(upgraded.rows).toEqual([
      {
        connection_ingress_id: ingressA,
        setup_ingress_id: ingressA,
      },
    ]);
  });

  test("upgrades an applied version 19 schema without migration drift", async () => {
    const migrationsDirectory = new URL("../migrations/", import.meta.url);
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort()
      .slice(0, 19);
    await database.exec(`
      CREATE SCHEMA app_private;
      CREATE TABLE app_private.schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL,
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      );
    `);
    for (const [index, migrationFile] of migrationFiles.entries()) {
      const sql = await readFile(
        new URL(migrationFile, migrationsDirectory),
        "utf8",
      );
      await database.exec(sql);
      await database.query(
        `INSERT INTO app_private.schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [
          index + 1,
          migrationFile,
          createHash("sha256").update(sql).digest("hex"),
        ],
      );
    }

    await seedTenants(database);
    const snapshotAt = "2026-07-31T12:00:00.000Z";
    const webhookReceivedAt = "2026-07-31T12:01:00.000Z";
    const webhookEventId = "50000000-0000-4000-8000-000000000001";
    const providerIdentityIndex = `di1_${"i".repeat(43)}`;
    await database.query(
      `INSERT INTO app.directory_contact_projections (
         personal_account_id,
         whatsapp_connection_id,
         as_of,
         stale,
         partial,
         snapshot_observed_at
       ) VALUES ($1, $2, $3, false, false, $3)`,
      [accountA, connectionA, snapshotAt],
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
       ) VALUES ($1, $2, $3, repeat('a', 64), 128, $4, $4::timestamptz + interval '7 days')`,
      [accountA, connectionA, webhookEventId, webhookReceivedAt],
    );
    await database.query(
      `INSERT INTO app.directory_contacts (
         personal_account_id,
         whatsapp_connection_id,
         public_id,
         provider_identity_index,
         provider_identity_ciphertext_version,
         provider_identity_key_version,
         provider_identity_nonce,
         provider_identity_ciphertext,
         display_name_sort,
         active,
         received_at,
         webhook_event_id,
         webhook_item_identity
       ) VALUES (
         $1, $2, 'ctc_123456789012345678901', $3, 1, 1,
         decode(repeat('01', 12), 'hex'),
         decode(repeat('02', 17), 'hex'),
         'webhook contact', true, $4, $5, $6
       )`,
      [
        accountA,
        connectionA,
        providerIdentityIndex,
        webhookReceivedAt,
        webhookEventId,
        `wi1_${"w".repeat(43)}`,
      ],
    );

    await expect(runMigrations(database)).resolves.toBeUndefined();
    const column = await database.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'app'
         AND table_name = 'directory_contacts'
         AND column_name = 'snapshot_observed_at'`,
    );
    expect(column.rows).toEqual([{ column_name: "snapshot_observed_at" }]);
    const backfilled = await database.query<{ snapshot_observed_at: Date }>(
      `SELECT snapshot_observed_at
       FROM app.directory_contacts
       WHERE provider_identity_index = $1`,
      [providerIdentityIndex],
    );
    expect(backfilled.rows).toEqual([
      { snapshot_observed_at: new Date(snapshotAt) },
    ]);
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

  test("makes a WhatsApp Connection key durably unavailable and cannot restore it through the runtime role", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountA],
      );
      const first = await database.query<{ unavailable_at: Date }>(
        `SELECT app_private.make_whatsapp_connection_key_unavailable(
          $1, $2, $3::timestamptz
        ) AS unavailable_at`,
        [accountA, connectionA, "2026-07-31T12:00:00.000Z"],
      );
      const replay = await database.query<{ unavailable_at: Date }>(
        `SELECT app_private.make_whatsapp_connection_key_unavailable(
          $1, $2, $3::timestamptz
        ) AS unavailable_at`,
        [accountA, connectionA, "2026-07-31T13:00:00.000Z"],
      );
      const available = await database.query(
        `SELECT *
         FROM app_private.load_available_whatsapp_connection_key($1, $2)`,
        [accountA, connectionA],
      );

      expect(first.rows[0]?.unavailable_at).toEqual(
        new Date("2026-07-31T12:00:00.000Z"),
      );
      expect(replay.rows).toEqual(first.rows);
      expect(available.rows).toEqual([]);
      await expect(
        database.query(
          `UPDATE app.whatsapp_connection_key_envelopes
           SET ciphertext = decode('ff', 'hex'), unavailable_at = NULL
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2`,
          [accountA, connectionA],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `DELETE FROM app.whatsapp_connection_key_envelopes
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2`,
          [accountA, connectionA],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("makes a Personal Account key unavailable across ordinary runtime decryption", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountA],
      );
      await database.query(
        `SELECT app_private.make_personal_account_key_unavailable(
          $1, $2::timestamptz
        )`,
        [accountA, "2026-07-31T12:00:00.000Z"],
      );
      const accountKey = await database.query(
        "SELECT * FROM app_private.load_available_personal_account_key($1)",
        [accountA],
      );
      const connectionKey = await database.query(
        `SELECT *
         FROM app_private.load_available_whatsapp_connection_key($1, $2)`,
        [accountA, connectionA],
      );

      expect(accountKey.rows).toEqual([]);
      expect(connectionKey.rows).toEqual([]);
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("leaves an unavailability tombstone when no WhatsApp Connection envelope existed", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);
    await database.query(
      `DELETE FROM app.whatsapp_connection_key_envelopes
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = $2`,
      [accountA, connectionA],
    );

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountA],
      );
      const unavailable = await database.query<{ unavailable_at: Date }>(
        `SELECT app_private.make_whatsapp_connection_key_unavailable(
          $1, $2, $3::timestamptz
        ) AS unavailable_at`,
        [accountA, connectionA, "2026-07-31T12:00:00.000Z"],
      );

      expect(unavailable.rows[0]?.unavailable_at).toEqual(
        new Date("2026-07-31T12:00:00.000Z"),
      );
      await expect(
        database.query(
          `INSERT INTO app.whatsapp_connection_key_envelopes
            (
              personal_account_id,
              whatsapp_connection_id,
              account_key_version,
              key_version,
              nonce,
              ciphertext
            )
           VALUES ($1, $2, 1, 1, decode('0102', 'hex'), decode('0304', 'hex'))`,
          [accountA, connectionA],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("does not load a WhatsApp Connection envelope bound to another account-key version", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);
    await database.query(
      `UPDATE app.whatsapp_connection_key_envelopes
       SET account_key_version = 2
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = $2`,
      [accountA, connectionA],
    );

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountA],
      );
      const available = await database.query(
        `SELECT *
         FROM app_private.load_available_whatsapp_connection_key($1, $2)`,
        [accountA, connectionA],
      );

      expect(available.rows).toEqual([]);
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("restricts key unavailability and loading to the current Personal Account and API role", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountA],
      );
      await expect(
        database.query(
          `SELECT app_private.make_whatsapp_connection_key_unavailable(
            $1, $2, transaction_timestamp()
          )`,
          [accountB, connectionB],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }

    await database.exec("SET ROLE whatsapp_webhook_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountA],
      );
      await expect(
        database.query(
          "SELECT * FROM app_private.load_available_personal_account_key($1)",
          [accountA],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT app_private.make_whatsapp_connection_key_unavailable(
            $1, $2, transaction_timestamp()
          )`,
          [accountA, connectionA],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
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
        AND proname IN (
          'bootstrap_personal_account_for_clerk',
          'bootstrap_whatsapp_connection_for_ingress',
          'bootstrap_active_mcp_tool_call',
          'bootstrap_mcp_access_authorization',
          'bootstrap_mcp_authorization',
          'bootstrap_mcp_refresh_authorization',
          'bootstrap_mcp_refresh_credential',
          'bootstrap_mcp_tool_call',
          'bootstrap_tool_call_log',
          'admit_personal_account_for_clerk',
          'load_connection_setup_webhook_ingress_for_user',
          'load_connection_setup_webhook_ingress_for_worker',
          'resolve_personal_account_for_clerk'
        )
      ORDER BY proname
    `);
    expect(functions.rows).toEqual([
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "admit_personal_account_for_clerk",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_active_mcp_tool_call",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_mcp_access_authorization",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_mcp_authorization",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_mcp_refresh_authorization",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_mcp_refresh_credential",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_mcp_tool_call",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_personal_account_for_clerk",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_tool_call_log",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_whatsapp_connection_for_ingress",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "load_connection_setup_webhook_ingress_for_user",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "load_connection_setup_webhook_ingress_for_worker",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "resolve_personal_account_for_clerk",
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
      expect(
        (
          await database.query(
            `SELECT *
             FROM app_private.bootstrap_mcp_refresh_credential(
               decode(repeat('00', 32), 'hex'), $1, $2
             )`,
            ["A".repeat(43), "approved-client"],
          )
        ).rows,
      ).toEqual([]);
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
      expect(ingressLookup.rows).toEqual([]);
      await expect(
        database.query(
          "SELECT app_private.bootstrap_personal_account_for_clerk($1)",
          ["clerk_user_a"],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT *
           FROM app_private.bootstrap_mcp_refresh_credential(
             decode(repeat('00', 32), 'hex'), $1, $2
           )`,
          ["A".repeat(43), "approved-client"],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          "SELECT credential_hash FROM app.mcp_refresh_credentials",
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT app_private.load_connection_setup_webhook_ingress_for_user(
            $1, $2
          )`,
          ["clerk_user_a", "cst_000000000000000000001"],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT app_private.load_connection_setup_webhook_ingress_for_worker(
            $1, $2
          )`,
          [
            "cst_000000000000000000001",
            "cspw_0000000000000000000000000000000000000000000",
          ],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT app_private.bootstrap_mcp_access_authorization(
            $1, $2, transaction_timestamp()
          )`,
          ["40000000-0000-4000-8000-000000000001", "A".repeat(43)],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT app_private.bootstrap_mcp_authorization(
            $1, $2, $3, transaction_timestamp()
          )`,
          [
            "40000000-0000-4000-8000-000000000001",
            "A".repeat(43),
            "approved-client",
          ],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("resolves only an active ingress to encrypted connection material for the webhook role", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);
    await database.query(
      `INSERT INTO app.whatsapp_connection_provider_sessions (
        personal_account_id,
        whatsapp_connection_id,
        locator_ciphertext_version,
        locator_key_version,
        locator_nonce,
        locator_ciphertext,
        authority_ciphertext_version,
        authority_key_version,
        authority_nonce,
        authority_ciphertext,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2,
        1, 1, decode(repeat('11', 12), 'hex'), decode(repeat('12', 32), 'hex'),
        1, 1, decode(repeat('13', 12), 'hex'), decode(repeat('14', 32), 'hex'),
        transaction_timestamp(), transaction_timestamp()
      )`,
      [accountA, connectionA],
    );

    await database.exec("SET ROLE whatsapp_webhook_runtime");
    try {
      const resolved = await database.query(
        `SELECT
          ingress.personal_account_id,
          ingress.whatsapp_connection_id,
          ingress.account_key_version,
          ingress.account_kms_key_id,
          encode(ingress.account_key_ciphertext, 'hex')
            AS account_key_ciphertext,
          ingress.connection_key_account_version,
          ingress.connection_key_version,
          encode(ingress.connection_key_nonce, 'hex')
            AS connection_key_nonce,
          encode(ingress.connection_key_ciphertext, 'hex')
            AS connection_key_ciphertext,
          ingress.authority_ciphertext_version,
          ingress.authority_key_version,
          encode(ingress.authority_nonce, 'hex') AS authority_nonce,
          encode(ingress.authority_ciphertext, 'hex')
            AS authority_ciphertext
        FROM app_private.bootstrap_whatsapp_connection_for_ingress($1)
          AS ingress`,
        [ingressA],
      );
      const unknown = await database.query(
        "SELECT * FROM app_private.bootstrap_whatsapp_connection_for_ingress($1)",
        ["30000000-0000-4000-8000-000000000099"],
      );

      expect(resolved.rows).toEqual([
        {
          account_key_ciphertext: "0102",
          account_key_version: 1,
          account_kms_key_id: "kms-content-root",
          authority_ciphertext: "14".repeat(32),
          authority_ciphertext_version: 1,
          authority_key_version: 1,
          authority_nonce: "13".repeat(12),
          connection_key_account_version: 1,
          connection_key_ciphertext: "0405",
          connection_key_nonce: "010203",
          connection_key_version: 1,
          personal_account_id: accountA,
          whatsapp_connection_id: connectionA,
        },
      ]);
      expect(unknown.rows).toEqual([]);
      await expect(
        database.query(
          "SELECT authority_ciphertext FROM app.whatsapp_connection_provider_sessions",
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          "SELECT ciphertext FROM app.whatsapp_connection_key_envelopes",
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }

    await database.query(
      "UPDATE app.whatsapp_connections SET state = 'deleting' WHERE id = $1",
      [connectionA],
    );
    await database.exec("SET ROLE whatsapp_webhook_runtime");
    try {
      const deleting = await database.query(
        "SELECT * FROM app_private.bootstrap_whatsapp_connection_for_ingress($1)",
        [ingressA],
      );
      expect(deleting.rows).toEqual([]);
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("creates or recovers exactly one admitted Personal Account with private-beta defaults", async () => {
    await runMigrations(database);

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const attempts = await Promise.all(
        [
          [accountC, "a1b2"],
          [accountD, "c3d4"],
        ].map(([accountId, ciphertext]) =>
          database.query<{
            created: boolean;
            personal_account_id: string;
          }>(
            `SELECT *
             FROM app_private.admit_personal_account_for_clerk(
               $1, $2, 1, $3, decode($4, 'hex'), 3
             )`,
            [
              "user_bootstrap123",
              accountId,
              "arn:aws:kms:us-east-1:111122223333:key/content-root",
              ciphertext,
            ],
          ),
        ),
      );

      expect(attempts.map(({ rows }) => rows[0]?.personal_account_id)).toEqual([
        accountC,
        accountC,
      ]);
      expect(attempts.map(({ rows }) => rows[0]?.created)).toEqual([
        true,
        false,
      ]);

      const lookup = await database.query<{ account_id: string }>(
        "SELECT app_private.bootstrap_personal_account_for_clerk($1) AS account_id",
        ["user_bootstrap123"],
      );
      expect(lookup.rows).toEqual([{ account_id: accountC }]);
    } finally {
      await database.exec("RESET ROLE");
    }

    const persisted = await database.query<{
      account_count: number;
      ciphertext: string;
      envelope_count: number;
      identity_count: number;
      message_retention_days: number;
      stored_media_limit_bytes: number;
      whatsapp_connection_limit: number;
    }>(
      `SELECT
         (
           SELECT count(*)::integer
           FROM app.personal_accounts
           WHERE id IN ($1, $2)
         ) AS account_count,
         (
           SELECT encode(ciphertext, 'hex')
           FROM app.personal_account_key_envelopes
           WHERE personal_account_id IN ($1, $2)
         ) AS ciphertext,
         (
           SELECT count(*)::integer
           FROM app.personal_account_key_envelopes
           WHERE personal_account_id IN ($1, $2)
         ) AS envelope_count,
         (
           SELECT count(*)::integer
           FROM app_private.clerk_identities
           WHERE clerk_user_id = 'user_bootstrap123'
         ) AS identity_count,
         (
           SELECT message_retention_days
           FROM app.personal_accounts
           WHERE id IN ($1, $2)
         ) AS message_retention_days,
         (
           SELECT stored_media_limit_bytes
           FROM app.personal_accounts
           WHERE id IN ($1, $2)
         ) AS stored_media_limit_bytes,
         (
           SELECT whatsapp_connection_limit
           FROM app.personal_accounts
           WHERE id IN ($1, $2)
         ) AS whatsapp_connection_limit`,
      [accountC, accountD],
    );
    expect(persisted.rows).toEqual([
      {
        account_count: 1,
        ciphertext: "a1b2",
        envelope_count: 1,
        identity_count: 1,
        message_retention_days: 30,
        stored_media_limit_bytes: 5_368_709_120,
        whatsapp_connection_limit: 3,
      },
    ]);
  });

  test("serializes provider capacity, creates one idempotent waitlist entry, and promotes it when capacity grows", async () => {
    await runMigrations(database);

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const first = await database.query<{
        admission_state: string;
        created: boolean;
      }>(
        `SELECT *
         FROM app_private.admit_personal_account_for_clerk(
           'user_admitted', $1, 1, $2, decode('a1b2', 'hex'), 3
         )`,
        [accountC, "arn:aws:kms:us-east-1:111122223333:key/content-root"],
      );
      const waitlisted = await Promise.all(
        [accountD, accountA].map((accountId) =>
          database.query<{
            admission_state: string;
            personal_account_id: string | null;
          }>(
            `SELECT *
             FROM app_private.admit_personal_account_for_clerk(
               'user_waitlisted', $1, 1, $2, decode('c3d4', 'hex'), 3
             )`,
            [accountId, "arn:aws:kms:us-east-1:111122223333:key/content-root"],
          ),
        ),
      );

      expect(first.rows[0]).toMatchObject({
        admission_state: "active",
        created: true,
      });
      expect(waitlisted.map(({ rows }) => rows[0])).toEqual([
        expect.objectContaining({
          admission_state: "waitlisted",
          personal_account_id: null,
        }),
        expect.objectContaining({
          admission_state: "waitlisted",
          personal_account_id: null,
        }),
      ]);

      const promoted = await database.query<{
        admission_state: string;
        created: boolean;
        personal_account_id: string;
      }>(
        `SELECT *
         FROM app_private.admit_personal_account_for_clerk(
           'user_waitlisted', $1, 1, $2, decode('e5f6', 'hex'), 6
         )`,
        [accountD, "arn:aws:kms:us-east-1:111122223333:key/content-root"],
      );
      expect(promoted.rows[0]).toMatchObject({
        admission_state: "active",
        created: true,
        personal_account_id: accountD,
      });
    } finally {
      await database.exec("RESET ROLE");
    }

    const persisted = await database.query<{
      account_count: number;
      waitlist_count: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM app.personal_accounts) AS account_count,
        (
          SELECT count(*)::integer
          FROM app_private.private_beta_waitlist
          WHERE clerk_user_id = 'user_waitlisted'
        ) AS waitlist_count
    `);
    expect(persisted.rows).toEqual([
      {
        account_count: 2,
        waitlist_count: 0,
      },
    ]);
  });

  test("does not recover, waitlist, or replace a deleting Personal Account", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await database.query(
      "UPDATE app.personal_accounts SET state = 'deleting' WHERE id = $1",
      [accountA],
    );

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const lookup = await database.query<{ account_id: string | null }>(
        "SELECT app_private.bootstrap_personal_account_for_clerk($1) AS account_id",
        ["clerk_user_a"],
      );
      const replacement = await database.query(
        `SELECT *
         FROM app_private.admit_personal_account_for_clerk(
           $1, $2, 1, $3, decode('a1b2', 'hex'), 3
         )`,
        [
          "clerk_user_a",
          accountC,
          "arn:aws:kms:us-east-1:111122223333:key/content-root",
        ],
      );

      expect(lookup.rows).toEqual([{ account_id: null }]);
      expect(replacement.rows).toEqual([]);
    } finally {
      await database.exec("RESET ROLE");
    }

    const candidate = await database.query(
      "SELECT id FROM app.personal_accounts WHERE id = $1",
      [accountC],
    );
    expect(candidate.rows).toEqual([]);
  });

  test("denies admission and waitlist data to the webhook runtime role", async () => {
    await runMigrations(database);

    await database.exec("SET ROLE whatsapp_webhook_runtime");
    try {
      await expect(
        database.query(
          `SELECT *
           FROM app_private.admit_personal_account_for_clerk(
             $1, $2, 1, $3, decode('a1b2', 'hex'), 3
           )`,
          [
            "user_bootstrap123",
            accountC,
            "arn:aws:kms:us-east-1:111122223333:key/content-root",
          ],
        ),
      ).rejects.toThrow();
      await expect(
        database.query("SELECT * FROM app_private.private_beta_waitlist"),
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

const seedKeyEnvelopes = async (database: PGlite) => {
  await database.query(
    `INSERT INTO app.personal_account_key_envelopes
      (personal_account_id, key_version, kms_key_id, ciphertext)
     VALUES
      ($1, 1, 'kms-content-root', decode('0102', 'hex')),
      ($2, 1, 'kms-content-root', decode('0304', 'hex'))`,
    [accountA, accountB],
  );
  await database.query(
    `INSERT INTO app.whatsapp_connection_key_envelopes
      (
        personal_account_id,
        whatsapp_connection_id,
        account_key_version,
        key_version,
        nonce,
        ciphertext
      )
     VALUES
      ($1, $2, 1, 1, decode('010203', 'hex'), decode('0405', 'hex')),
      ($3, $4, 1, 1, decode('060708', 'hex'), decode('090a', 'hex'))`,
    [accountA, connectionA, accountB, connectionB],
  );
};
