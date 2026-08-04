import { defineConfig } from "drizzle-kit";
import { directNeonMigrationConnectionString } from "./src/config";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
if (migrationDatabaseUrl === undefined) {
  throw new Error("MIGRATION_DATABASE_URL is required");
}

export default defineConfig({
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/schema/*.ts",
  dbCredentials: {
    url: directNeonMigrationConnectionString(migrationDatabaseUrl),
  },
  migrations: {
    schema: "public",
    table: "drizzle_migrations",
  },
  schemaFilter: ["public"],
  strict: true,
  verbose: true,
});
