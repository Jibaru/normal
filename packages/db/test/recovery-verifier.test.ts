import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/migrations";

const branchId = "br-monthly-recovery";
const observedAt = "2026-08-18T12:00:00.000Z";

describe("recovery verifier database boundary", () => {
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
  });

  afterEach(async () => database.close());

  test("is an unprivileged NOINHERIT login with no tenant table access", async () => {
    const role = await database.query(`
      SELECT rolsuper, rolinherit, rolcreaterole, rolcreatedb,
        rolcanlogin, rolreplication, rolbypassrls
      FROM pg_catalog.pg_roles
      WHERE rolname = 'whatsapp_recovery_verifier'
    `);
    expect(role.rows).toEqual([
      {
        rolbypassrls: false,
        rolcanlogin: true,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolsuper: false,
      },
    ]);

    await database.exec("SET ROLE whatsapp_recovery_verifier");
    try {
      await expect(
        database.query("SELECT id FROM public.personal_accounts"),
      ).rejects.toThrow();
      await expect(
        database.query("SELECT max(created_at) FROM public.drizzle_migrations"),
      ).resolves.toBeDefined();
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("denies a mismatched branch without disclosing readiness metadata", async () => {
    await database.query("SELECT * FROM public.begin_restore_replay($1, $2)", [
      branchId,
      observedAt,
    ]);
    await database.exec("SET ROLE whatsapp_recovery_verifier");
    try {
      await expect(
        database.query(
          "SELECT * FROM public.verify_recovery_branch('br-other', $1)",
          [observedAt],
        ),
      ).rejects.toThrow("recovery verifier branch mismatch");
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("keeps drills non-serving before and after independent verification", async () => {
    await database.query(
      "SELECT * FROM public.begin_restore_replay($1, $2, true)",
      [branchId, "2026-08-18T11:00:00.000Z"],
    );
    await database.exec("SET ROLE whatsapp_recovery_verifier");
    await expect(
      database.query("SELECT * FROM public.verify_recovery_branch($1, $2)", [
        branchId,
        observedAt,
      ]),
    ).rejects.toThrow("recovery verifier branch mismatch");
    await database.exec("RESET ROLE");

    await database.query(
      "SELECT public.complete_restore_replay($1, $2, 0, 0, 0)",
      [branchId, "2026-08-18T11:30:00.000Z"],
    );
    await database.query(
      `INSERT INTO public.whatsapp_recipient_transition_prefixes
         (journal_prefix, recorded_at) VALUES ($1, $2)`,
      ["a".repeat(64), "2026-08-18T11:31:00.000Z"],
    );

    expect(
      (
        await database.query<{ ready: boolean }>(
          "SELECT public.is_restore_ready($1) AS ready",
          [branchId],
        )
      ).rows,
    ).toEqual([{ ready: false }]);
    await database.exec("SET ROLE whatsapp_recovery_verifier");
    const after = await database.query<Record<string, boolean>>(
      "SELECT * FROM public.verify_recovery_branch($1, $2)",
      [branchId, observedAt],
    );
    await database.query(
      "SELECT public.complete_recovery_drill_verification($1, $2)",
      [branchId, observedAt],
    );
    await database.exec("RESET ROLE");
    expect(after.rows[0]).toEqual({
      api_key_ok: true,
      audit_ok: true,
      deletion_ok: true,
      expiry_ok: true,
      invariants_ok: true,
      object_intent_ok: true,
      quota_ok: true,
      recipient_content_ok: true,
      recipient_cutoff_ok: true,
      recipient_transition_ok: true,
      rls_ok: true,
      schema_ok: true,
    });
    expect(
      (
        await database.query<{ ready: boolean; state: string }>(
          `SELECT state, public.is_restore_ready($1) AS ready
           FROM public.restore_readiness`,
          [branchId],
        )
      ).rows,
    ).toEqual([{ ready: false, state: "drill_verified" }]);
  });

  test("rejects incomplete recipient cutoff and prepared-transition evidence", async () => {
    const accountId = "10000000-0000-4000-8000-000000000090";
    const connectionId = "20000000-0000-4000-8000-000000000090";
    await database.query(
      `SELECT * FROM public.admit_personal_account_for_clerk(
        'user_recovery90',$1,1,
        'arn:aws:kms:us-east-1:111122223333:key/content',decode('0102','hex'),3
      )`,
      [accountId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections(
        id,personal_account_id,webhook_ingress_id,public_id,number_suffix,
        state,state_changed_at,created_at
      ) VALUES(
        $1,$2,'30000000-0000-4000-8000-000000000090',
        'con_000000000000000000090','0090','connected',$3,$3
      )`,
      [connectionId, accountId, observedAt],
    );
    await database.query(
      "SELECT * FROM public.begin_restore_replay($1, $2, true)",
      [branchId, "2026-08-18T11:00:00.000Z"],
    );
    await database.query(
      "SELECT public.complete_restore_replay($1, $2, 1, 0, 0)",
      [branchId, "2026-08-18T11:30:00.000Z"],
    );
    await database.query(
      `INSERT INTO public.whatsapp_recipient_exclusions(
        personal_account_id,whatsapp_connection_id,recipient_kind,
        recipient_locator,recipient_public_id,excluded,effective_at,
        transition_id,transition_excluded,transition_effective_at,
        transition_idempotency_key,transition_prepared_at
      ) VALUES(
        $1,$2,'contact',$3,'ctc_000000000000000000090',true,$4,
        '40000000-0000-4000-8000-000000000090',true,$4,
        'recovery-transition-0000000090',$4
      )`,
      [accountId, connectionId, `di1_${"A".repeat(43)}`, observedAt],
    );

    await database.exec("SET ROLE whatsapp_recovery_verifier");
    const result = await database.query<Record<string, boolean>>(
      "SELECT * FROM public.verify_recovery_branch($1, $2)",
      [branchId, observedAt],
    );
    await database.exec("RESET ROLE");
    expect(result.rows[0]?.recipient_transition_ok).toBe(false);
    expect(result.rows[0]?.recipient_cutoff_ok).toBe(false);
  });
});
