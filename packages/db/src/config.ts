import { Config, Redacted } from "effect";

export const databaseConfig = Config.all({
  databaseUrl: Config.redacted("DATABASE_URL"),
});

const isDirectNeonMigrationUrl = (
  value: Redacted.Redacted<string>,
): boolean => {
  try {
    const url = new URL(Redacted.value(value));
    const endpoint = url.hostname.split(".", 1)[0];
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname.endsWith(".neon.tech") &&
      !endpoint?.endsWith("-pooler") &&
      url.username.length > 0 &&
      url.password.length > 0 &&
      (url.searchParams.get("sslmode") === "require" ||
        url.searchParams.get("sslmode") === "verify-full")
    );
  } catch {
    return false;
  }
};

export const migrationConfig = Config.all({
  migrationDatabaseUrl: Config.redacted("MIGRATION_DATABASE_URL").pipe(
    Config.validate({
      message:
        "MIGRATION_DATABASE_URL must be a direct TLS Neon PostgreSQL URL",
      validation: isDirectNeonMigrationUrl,
    }),
  ),
});
