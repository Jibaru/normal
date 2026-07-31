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
