import { Config, Redacted } from "effect";

export {
  restrictedApiRuntimeConnectionString,
  restrictedDeletionRuntimeConnectionString,
  restrictedRecoveryVerifierConnectionString,
  restrictedRestoreRuntimeConnectionString,
} from "./restricted-runtime-config";

export const databaseConfig = Config.all({
  databaseUrl: Config.redacted("DATABASE_URL"),
});

const isDirectNeonMigrationUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
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

export const directNeonMigrationConnectionString = (value: string): string => {
  if (isDirectNeonMigrationUrl(value)) return value;
  throw new Error("database URL is not a direct TLS Neon migration connection");
};

export const migrationConfig = Config.all({
  migrationDatabaseUrl: Config.redacted("MIGRATION_DATABASE_URL").pipe(
    Config.validate({
      message:
        "MIGRATION_DATABASE_URL must be a direct TLS Neon PostgreSQL URL",
      validation: (value) => isDirectNeonMigrationUrl(Redacted.value(value)),
    }),
  ),
});
