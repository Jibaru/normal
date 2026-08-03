import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import {
  databaseConfig,
  migrationConfig,
  restrictedApiRuntimeConnectionString,
  restrictedDeletionRuntimeConnectionString,
} from "../src/config";

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

describe("restrictedDeletionRuntimeConnectionString", () => {
  test("accepts only the deletion coordinator role over TLS to Neon", () => {
    const value =
      "postgresql://whatsapp_deletion_runtime:secret@ep-example-pooler.us-east-1.aws.neon.tech/database?sslmode=verify-full";
    expect(restrictedDeletionRuntimeConnectionString(value)).toBe(value);
  });

  test.each([
    "postgresql://whatsapp_api_runtime:secret@example.neon.tech/database?sslmode=require",
    "postgresql://whatsapp_deletion_runtime:secret@localhost/database?sslmode=require",
    "postgresql://whatsapp_deletion_runtime:secret@example.neon.tech/database?sslmode=disable",
    "postgresql://whatsapp_deletion_runtime:secret@example.neon.tech/database?user=owner&sslmode=require",
  ])("rejects unsafe deletion runtime URL %s", (connectionString) => {
    expect(() =>
      restrictedDeletionRuntimeConnectionString(connectionString),
    ).toThrow("database URL is not the restricted TLS deletion runtime");
  });
});

describe("restrictedApiRuntimeConnectionString", () => {
  test("accepts only the restricted role over TLS to Neon", () => {
    const value = Redacted.make(
      "postgresql://whatsapp_api_runtime:secret@ep-example-pooler.us-east-1.aws.neon.tech/database?sslmode=require",
    );

    expect(restrictedApiRuntimeConnectionString(value)).toContain(
      "sslmode=require",
    );
  });

  test.each([
    "http://example.neon.tech/database?sslmode=require",
    "postgresql://whatsapp_api_runtime:secret@example.neon.tech/database",
    "postgresql://owner:secret@example.neon.tech/database?sslmode=require",
    "postgresql://whatsapp_api_runtime@example.neon.tech/database?sslmode=require",
    "postgresql://whatsapp_api_runtime:secret@localhost/database?sslmode=require",
    "postgresql://whatsapp_api_runtime:secret@example.neon.tech/database?sslmode=require&sslmode=disable",
    "postgresql://whatsapp_api_runtime:secret@example.neon.tech/database?host=attacker.example&sslmode=require",
  ])("rejects unsafe API runtime URL %s", (connectionString) => {
    expect(() =>
      restrictedApiRuntimeConnectionString(Redacted.make(connectionString)),
    ).toThrow("database URL is not the restricted TLS API runtime");
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
    "postgresql://owner:secret@example.neon.tech/database?sslmode=require&sslmode=disable",
    "postgresql://owner:secret@example.neon.tech/database?host=attacker.example&sslmode=require",
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
