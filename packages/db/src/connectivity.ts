import { sql } from "drizzle-orm";
import {
  makeDatabase,
  makeQueryConnection,
  type QueryConnection,
} from "./database";
import { assertExpectedSchemaVersion } from "./readiness";
import { withPgRequestConnection } from "./request-connection";

const DEVELOPMENT_READINESS_TTL_MS = 15_000;
let recentDevelopmentReadiness:
  | { readonly branchId: string | undefined; readonly checkedAt: number }
  | undefined;

const withClient = async <Value>(
  connectionString: string,
  use: (client: QueryConnection) => Promise<Value>,
): Promise<Value> => {
  return withPgRequestConnection(connectionString, (client) =>
    use(makeQueryConnection(client)),
  );
};

export const checkDatabaseReadiness = (
  connectionString: string,
  branchId?: string,
  allowLegacyMigrationTable = false,
): Promise<void> => {
  const now = Date.now();
  const recent = recentDevelopmentReadiness;
  if (
    allowLegacyMigrationTable &&
    recent !== undefined &&
    recent.branchId === branchId &&
    now - recent.checkedAt < DEVELOPMENT_READINESS_TTL_MS
  ) {
    return Promise.resolve();
  }
  return withClient(connectionString, async (client) => {
    await assertExpectedSchemaVersion(
      client,
      branchId,
      allowLegacyMigrationTable,
    );
    if (allowLegacyMigrationTable) {
      recentDevelopmentReadiness = { branchId, checkedAt: Date.now() };
    }
  });
};

export const checkRestrictedDatabaseAccess = (
  connectionString: string,
): Promise<void> =>
  withClient(connectionString, async (client) => {
    const db = makeDatabase(client);
    const result = await db.execute<{
      bypass_rls: boolean;
      owns_tenant_table: boolean;
      superuser: boolean;
    }>(sql`SELECT
         role.rolbypassrls AS bypass_rls,
         role.rolsuper AS superuser,
         EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class relation
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = 'app'
             AND relation.relkind IN ('r', 'p')
             AND relation.relowner = role.oid
         ) AS owns_tenant_table
       FROM pg_catalog.pg_roles role
       WHERE role.rolname = current_user`);
    const role = result[0];
    if (!role || role.bypass_rls || role.superuser || role.owns_tenant_table)
      throw new Error("database runtime role is not restricted");
  });
