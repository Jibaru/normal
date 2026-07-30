import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import { databaseConfig, migrationConfig } from "../src/config";

describe("databaseConfig", () => {
  test("keeps the Neon connection string redacted", async () => {
    const config = await Effect.runPromise(
      databaseConfig.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([["DATABASE_URL", "postgresql://user:secret@example/db"]]),
          ),
        ),
      ),
    );

    expect(Redacted.value(config.databaseUrl)).toBe(
      "postgresql://user:secret@example/db",
    );
    expect(String(config.databaseUrl)).not.toContain("secret");
  });

  test("fails closed when DATABASE_URL is absent", async () => {
    await expect(
      Effect.runPromise(
        databaseConfig.pipe(
          Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
        ),
      ),
    ).rejects.toBeDefined();
  });
});

describe("migrationConfig", () => {
  test("requires a direct TLS PostgreSQL connection", async () => {
    const config = await Effect.runPromise(
      migrationConfig.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              [
                "MIGRATION_DATABASE_URL",
                "postgresql://owner:secret@example.neon.tech/database?sslmode=require",
              ],
            ]),
          ),
        ),
      ),
    );

    expect(Redacted.value(config.migrationDatabaseUrl)).toContain(
      "sslmode=require",
    );
    expect(String(config.migrationDatabaseUrl)).not.toContain("secret");
  });

  test.each([
    "http://example.test/database",
    "postgresql://owner:secret@example.neon.tech/database",
    "postgresql://owner:secret@localhost/database?sslmode=require",
    "postgresql://owner:secret@ep-example-pooler.us-east-1.aws.neon.tech/database?sslmode=require",
    "postgresql://owner@example.neon.tech/database?sslmode=require",
  ])("rejects unsafe production migration URL %s", async (url) => {
    await expect(
      Effect.runPromise(
        migrationConfig.pipe(
          Effect.withConfigProvider(
            ConfigProvider.fromMap(new Map([["MIGRATION_DATABASE_URL", url]])),
          ),
        ),
      ),
    ).rejects.toBeDefined();
  });
});
