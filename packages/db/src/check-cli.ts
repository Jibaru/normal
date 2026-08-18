import { ConfigProvider, Effect, Redacted } from "effect";
import { migrationConfig } from "./config";
import { checkDatabaseReadiness } from "./connectivity";
import { SchemaVersionMismatch } from "./readiness";

const program = migrationConfig.pipe(
  Effect.flatMap((config) =>
    Effect.tryPromise({
      try: () =>
        checkDatabaseReadiness(Redacted.value(config.migrationDatabaseUrl)),
      catch: (cause) => cause,
    }),
  ),
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
);

try {
  await Effect.runPromise(program);
  console.info(JSON.stringify({ event: "database.schema.ready" }));
} catch (error) {
  const detail =
    error instanceof SchemaVersionMismatch
      ? { actual: error.actual, expected: error.expected }
      : typeof error === "object" && error !== null && "code" in error
        ? { code: String(error.code) }
        : {};
  console.error(
    JSON.stringify({ event: "database.schema.unavailable", ...detail }),
  );
  process.exitCode = 1;
}
