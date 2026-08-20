import migration0000 from "../drizzle/0000_baseline.sql";
import migration0001 from "../drizzle/0001_allow_null_mcp_client_id.sql";
import migration0002 from "../drizzle/0002_delegate_waitlist_to_clerk.sql";
import migration0003 from "../drizzle/0003_admit_clerk_users_without_provider_reservation.sql";
import migration0004 from "../drizzle/0004_name_whatsapp_connections.sql";
import migration0005 from "../drizzle/0005_add_message_search_foundation.sql";
import migration0006 from "../drizzle/0006_add_whatsapp_recipient_exclusions.sql";
import migration0007 from "../drizzle/0007_add_personal_account_onboarding_profiles.sql";
import migration0008 from "../drizzle/0008_expand_activity_log_channels.sql";
import migration0009 from "../drizzle/0009_add_api_keys.sql";
import migration0010 from "../drizzle/0010_distinguish_send_grant_identities.sql";
import migration0011 from "../drizzle/0011_revoke_api_keys_on_personal_account_deletion.sql";
import migration0012 from "../drizzle/0012_expire_and_purge_api_key_metadata.sql";
import migration0013 from "../drizzle/0013_revoke_api_keys_on_connection_deletion.sql";
import migration0014 from "../drizzle/0014_load_protected_stored_media_for_api_keys.sql";
import migration0015 from "../drizzle/0015_record_health_check_failures.sql";
import migration0016 from "../drizzle/0016_invalidate_restored_api_keys.sql";
import migration0017 from "../drizzle/0017_record_connection_setup_provisioning_start.sql";
import migration0018 from "../drizzle/0018_reject_mismatched_qr_activation.sql";
import migration0019 from "../drizzle/0019_allow_api_keys_on_mcp.sql";
import migration0020 from "../drizzle/0020_persist_onboarding_security_completion.sql";
import migration0021 from "../drizzle/0021_add_recovery_verifier.sql";
import migration0022 from "../drizzle/0022_gate_recovery_drill_verification.sql";
import migration0023 from "../drizzle/0023_record_recovery_source_points.sql";
import { type QueryConnection, withPgQueryConnection } from "./database";
import { restrictedRecoveryVerifierConnectionString } from "./restricted-runtime-config";

const migrations = [
  [1785787776687, migration0000],
  [1785959583000, migration0001],
  [1786134619000, migration0002],
  [1786143600000, migration0003],
  [1786464000000, migration0004],
  [1786467600000, migration0005],
  [1786471200000, migration0006],
  [1786474800000, migration0007],
  [1786478400000, migration0008],
  [1786482000000, migration0009],
  [1786485600000, migration0010],
  [1786489200000, migration0011],
  [1786492800000, migration0012],
  [1786496400000, migration0013],
  [1786500000000, migration0014],
  [1787022000000, migration0015],
  [1787112000000, migration0016],
  [1787115600000, migration0017],
  [1787119200000, migration0018],
  [1787119201000, migration0019],
  [1787122800000, migration0020],
  [1787126400000, migration0021],
  [1787130000000, migration0022],
  [1787166960000, migration0023],
] as const;
const RECOVERY_VERIFIER_MIGRATION_CREATED_AT = 1787126400000;

export const recoveryMigrationCreatedAts: ReadonlyArray<number> =
  migrations.map(([createdAt]) => createdAt);

const readLastAppliedMigration = async (client: QueryConnection) => {
  const ledger = await client.query<{ created_at: string }>(
    "SELECT created_at FROM public.drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  );
  const lastApplied = Number(ledger.rows[0]?.created_at ?? 0);
  if (!Number.isFinite(lastApplied) || lastApplied < 0)
    throw new Error("Recovery migration ledger is invalid");
  return lastApplied;
};

export const recoveryMigrationRequiresVerifierHardeningWithClient = async (
  client: QueryConnection,
) =>
  (await readLastAppliedMigration(client)) <
  RECOVERY_VERIFIER_MIGRATION_CREATED_AT;

export const recoveryMigrationRequiresVerifierHardening = (
  connectionString: string,
) =>
  withPgQueryConnection(
    connectionString,
    recoveryMigrationRequiresVerifierHardeningWithClient,
    30_000,
    10_000,
  );

const hardenRecoveryVerifierRoleSql = `
DO $role$
DECLARE
  granted_role name;
BEGIN
  IF session_user <> 'whatsapp_recovery_verifier' THEN
    RAISE EXCEPTION 'recovery verifier hardening role mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = session_user AND rolsuper
  ) THEN
    RAISE EXCEPTION 'recovery verifier has prohibited superuser authority';
  END IF;
  FOR granted_role IN
    SELECT parent.rolname
    FROM pg_catalog.pg_auth_members AS memberships
    JOIN pg_catalog.pg_roles AS parent
      ON parent.oid = memberships.roleid
    JOIN pg_catalog.pg_roles AS member
      ON member.oid = memberships.member
    WHERE member.rolname = session_user
  LOOP
    EXECUTE format('REVOKE %I FROM whatsapp_recovery_verifier', granted_role);
  END LOOP;
  ALTER ROLE whatsapp_recovery_verifier
    NOREPLICATION NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT LOGIN;
END
$role$`;

export const hardenRecoveryVerifierRoleWithClient = async (
  client: QueryConnection,
) => {
  await client.query("BEGIN");
  try {
    const eligibility = await client.query<{ eligible: boolean }>(
      `SELECT current_user = 'whatsapp_recovery_verifier'
        AND pg_catalog.pg_has_role(current_user, 'neon_superuser', 'MEMBER')
        AS eligible`,
    );
    if (eligibility.rows[0]?.eligible !== true)
      throw new Error("Recovery verifier hardening authority is unavailable");
    await client.query("SET LOCAL ROLE neon_superuser");
    await client.query(hardenRecoveryVerifierRoleSql);
    await client.query("RESET ROLE");
    const verification = await client.query<{ hardened: boolean }>(
      `SELECT current_user = 'whatsapp_recovery_verifier'
        AND NOT rolsuper AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit
        AND rolcanlogin
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_auth_members AS memberships
          WHERE memberships.member = roles.oid
        ) AS hardened
      FROM pg_catalog.pg_roles AS roles
      WHERE rolname = current_user`,
    );
    if (verification.rows[0]?.hardened !== true)
      throw new Error("Recovery verifier hardening failed");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

export const hardenRecoveryVerifierRole = (connectionString: string) =>
  withPgQueryConnection(
    restrictedRecoveryVerifierConnectionString(connectionString),
    hardenRecoveryVerifierRoleWithClient,
    30_000,
    10_000,
  );

const toHex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const applyRecoveryMigrationsWithClient = async (
  client: QueryConnection,
) => {
  const lastApplied = await readLastAppliedMigration(client);

  let applied = 0;
  for (const [createdAt, source] of migrations) {
    if (createdAt <= lastApplied) continue;
    const hash = toHex(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
    );
    await client.query("BEGIN");
    try {
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim().length > 0) await client.query(statement);
      }
      await client.query(
        "INSERT INTO public.drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [hash, createdAt],
      );
      await client.query("COMMIT");
      applied += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  return applied;
};

export const applyRecoveryMigrations = (connectionString: string) =>
  withPgQueryConnection(
    connectionString,
    applyRecoveryMigrationsWithClient,
    120_000,
    10_000,
  );
