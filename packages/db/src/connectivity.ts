import { sql } from "drizzle-orm";
import {
  makeDatabase,
  makeQueryConnection,
  type QueryConnection,
} from "./database";
import { assertExpectedSchemaVersion } from "./readiness";

const withClient = async <Value>(
  connectionString: string,
  use: (client: QueryConnection) => Promise<Value>,
): Promise<Value> => {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });

  await client.connect();
  try {
    return await use(makeQueryConnection(client));
  } finally {
    await client.end();
  }
};

export const checkDatabaseReadiness = (
  connectionString: string,
  branchId?: string,
): Promise<void> =>
  withClient(connectionString, async (client) => {
    await assertExpectedSchemaVersion(client, branchId);
  });

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
