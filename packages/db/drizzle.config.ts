import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/schema/*.ts",
  dbCredentials: {
    url:
      process.env.MIGRATION_DATABASE_URL ??
      "postgresql://localhost/whatsapp_mcp",
  },
  migrations: {
    schema: "app_private",
    table: "schema_migrations",
  },
  schemaFilter: ["app", "app_private"],
  strict: true,
  verbose: true,
});
