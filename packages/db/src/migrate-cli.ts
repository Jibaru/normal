import { ConfigProvider, Effect, Redacted } from "effect";
import { Client } from "pg";
import { migrationConfig } from "./config";
import { runMigrations } from "./migrations";

const program = migrationConfig.pipe(
  Effect.flatMap((config) =>
    Effect.tryPromise({
      try: async () => {
        const client = new Client({
          connectionString: Redacted.value(config.migrationDatabaseUrl),
          connectionTimeoutMillis: 10_000,
          query_timeout: 30_000,
        });
        await client.connect();
        try {
          await runMigrations({
            query: async (text, values) => {
              const result = await client.query(text, values as Array<unknown>);
              return { rows: result.rows };
            },
          });
        } finally {
          await client.end();
        }
      },
      catch: (cause) => cause,
    }),
  ),
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
);

try {
  await Effect.runPromise(program);
  console.info(JSON.stringify({ event: "database.migration.completed" }));
} catch {
  console.error(JSON.stringify({ event: "database.migration.failed" }));
  process.exitCode = 1;
}
