import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import { databaseConfig } from "../src/config";

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
