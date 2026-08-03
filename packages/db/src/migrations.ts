import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";

export { EXPECTED_SCHEMA_VERSION } from "./schema-version";

const migrationConfig = {
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  migrationsSchema: "app_private",
  migrationsTable: "drizzle_migrations",
} as const;

export const runMigrations = async (client: PGlite): Promise<void> => {
  await migratePglite(drizzlePglite({ client }), migrationConfig);
};
