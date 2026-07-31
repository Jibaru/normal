import { Config, Redacted } from "effect";

export const databaseConfig = Config.all({
  databaseUrl: Config.redacted("DATABASE_URL"),
});

export const restrictedApiRuntimeConnectionString = (
  value: Redacted.Redacted<string>,
): string => {
  const connectionString = Redacted.value(value);
  try {
    const url = new URL(connectionString);
    const sslModes = url.searchParams.getAll("sslmode");
    const hasAuthorityOverride = ["host", "password", "port", "user"].some(
      (parameter) => url.searchParams.has(parameter),
    );
    if (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname.endsWith(".neon.tech") &&
      url.username === "whatsapp_api_runtime" &&
      url.password.length > 0 &&
      !hasAuthorityOverride &&
      sslModes.length === 1 &&
      (sslModes[0] === "require" || sslModes[0] === "verify-full")
    ) {
      return connectionString;
    }
  } catch {
    // The single safe error below intentionally does not echo configuration.
  }
  throw new Error("database URL is not the restricted TLS API runtime");
};

const isDirectNeonMigrationUrl = (
  value: Redacted.Redacted<string>,
): boolean => {
  try {
    const url = new URL(Redacted.value(value));
    const endpoint = url.hostname.split(".", 1)[0];
    const sslModes = url.searchParams.getAll("sslmode");
    const hasAuthorityOverride = ["host", "password", "port", "user"].some(
      (parameter) => url.searchParams.has(parameter),
    );
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname.endsWith(".neon.tech") &&
      !endpoint?.endsWith("-pooler") &&
      url.username.length > 0 &&
      url.password.length > 0 &&
      !hasAuthorityOverride &&
      sslModes.length === 1 &&
      (sslModes[0] === "require" || sslModes[0] === "verify-full")
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
