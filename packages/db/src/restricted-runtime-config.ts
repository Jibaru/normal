import type { Redacted } from "effect";
import { Redacted as RedactedValue } from "effect";

const restrictedRuntimeConnectionString = (
  value: string,
  username: string,
  errorMessage: string,
  direct = false,
): string => {
  try {
    const url = new URL(value);
    const sslModes = url.searchParams.getAll("sslmode");
    const hasAuthorityOverride = ["host", "password", "port", "user"].some(
      (parameter) => url.searchParams.has(parameter),
    );
    if (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname.endsWith(".neon.tech") &&
      (!direct || !url.hostname.split(".", 1)[0]?.endsWith("-pooler")) &&
      url.username === username &&
      url.password.length > 0 &&
      !hasAuthorityOverride &&
      sslModes.length === 1 &&
      (sslModes[0] === "require" || sslModes[0] === "verify-full")
    )
      return value;
  } catch {
    // The safe error below intentionally does not echo configuration.
  }
  throw new Error(errorMessage);
};

export const restrictedApiRuntimeConnectionString = (
  value: Redacted.Redacted<string>,
): string =>
  restrictedRuntimeConnectionString(
    RedactedValue.value(value),
    "whatsapp_api_runtime",
    "database URL is not the restricted TLS API runtime",
  );

export const restrictedDeletionRuntimeConnectionString = (
  value: string,
): string =>
  restrictedRuntimeConnectionString(
    value,
    "whatsapp_deletion_runtime",
    "database URL is not the restricted TLS deletion runtime",
  );

export const restrictedRestoreRuntimeConnectionString = (
  value: string,
): string =>
  restrictedRuntimeConnectionString(
    value,
    "whatsapp_restore_runtime",
    "database URL is not the restricted TLS restore runtime",
  );

export const restrictedRecoveryVerifierConnectionString = (
  value: string,
): string =>
  restrictedRuntimeConnectionString(
    value,
    "whatsapp_recovery_auditor",
    "database URL is not the direct restricted TLS recovery verifier",
    true,
  );

export const restrictedMigrationOwnerConnectionString = (
  value: string,
): string =>
  restrictedRuntimeConnectionString(
    value,
    "whatsapp_migration_owner",
    "database URL is not the direct TLS migration owner",
    true,
  );

export const recoveryVerifierConnectionString = (
  restoreConnectionString: string,
  password: string,
): string => {
  const parsed = new URL(
    restrictedRestoreRuntimeConnectionString(restoreConnectionString),
  );
  if (!/^[a-f0-9]{64}$/.test(password))
    throw new Error("recovery verifier password is invalid");
  parsed.username = "whatsapp_recovery_auditor";
  parsed.password = password;
  return restrictedRecoveryVerifierConnectionString(parsed.toString());
};
