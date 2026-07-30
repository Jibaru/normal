import { describe, expect, test } from "bun:test";
import { type MigrationConnection, runMigrations } from "../src/migrations";

describe("migration advisory lock", () => {
  test("serializes concurrent runners before executing migration SQL", async () => {
    const applied = new Map<number, string>();
    let releaseLock: (() => void) | undefined;
    let lockHeld = false;
    let maxConcurrentScripts = 0;
    let concurrentScripts = 0;

    const acquire = async () => {
      while (lockHeld) {
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      }
      lockHeld = true;
    };

    const release = () => {
      lockHeld = false;
      releaseLock?.();
      releaseLock = undefined;
    };

    const connection = (): MigrationConnection => ({
      exec: async () => {
        concurrentScripts += 1;
        maxConcurrentScripts = Math.max(
          maxConcurrentScripts,
          concurrentScripts,
        );
        await Promise.resolve();
        concurrentScripts -= 1;
      },
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: Array<unknown>,
      ) => {
        if (text.includes("pg_advisory_lock(")) {
          await acquire();
        } else if (text.includes("pg_advisory_unlock(")) {
          release();
        } else if (text.startsWith("SELECT version, checksum")) {
          return {
            rows: Array.from(applied, ([version, checksum]) => ({
              checksum,
              version,
            })) as unknown as Array<Row>,
          };
        } else if (text.includes("INSERT INTO app_private.schema_migrations")) {
          applied.set(values?.[0] as number, values?.[2] as string);
        }
        return { rows: [] };
      },
    });

    await Promise.all([
      runMigrations(connection()),
      runMigrations(connection()),
    ]);

    expect(maxConcurrentScripts).toBe(1);
    expect(applied.size).toBe(1);
    expect(lockHeld).toBe(false);
  });
});
