import { ConfigProvider, Effect, Redacted } from "effect";
import { migrationConfig } from "./config";
import { checkDatabaseReadiness } from "./connectivity";

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
} catch {
  console.error(JSON.stringify({ event: "database.schema.unavailable" }));
  process.exitCode = 1;
}
