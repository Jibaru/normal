import { describe, expect, test } from "bun:test";
import {
  assertExpectedSchemaVersion,
  EXPECTED_SCHEMA_VERSION,
  type SchemaVersionConnection,
  SchemaVersionMismatch,
} from "../src/readiness";

const connection = (
  query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
): SchemaVersionConnection => ({
  query: query as SchemaVersionConnection["query"],
});

describe("assertExpectedSchemaVersion", () => {
  test("accepts the exact production schema version", async () => {
    await expect(
      assertExpectedSchemaVersion(
        connection(async () => ({
          rows: [{ version: EXPECTED_SCHEMA_VERSION }],
        })),
      ),
    ).resolves.toBeUndefined();
  });

  test("fails closed when restore replay has not approved this Neon branch", async () => {
    await expect(
      assertExpectedSchemaVersion(
        connection(async (text) => ({
          rows: text.includes("drizzle_migrations")
            ? [{ version: EXPECTED_SCHEMA_VERSION }]
            : [{ ready: false }],
        })),
        "br-restored",
      ),
    ).rejects.toMatchObject({ name: "RestoreReplayRequired" });
  });

  test.each([0, EXPECTED_SCHEMA_VERSION + 1])(
    "fails closed for schema version %i",
    async (version) => {
      await expect(
        assertExpectedSchemaVersion(
          connection(async () => ({ rows: [{ version }] })),
        ),
      ).rejects.toBeInstanceOf(SchemaVersionMismatch);
    },
  );

  test("treats a missing migration table as an unapplied schema", async () => {
    await expect(
      assertExpectedSchemaVersion(
        connection(async () => {
          throw Object.assign(new Error("missing relation"), {
            code: "42P01",
          });
        }),
      ),
    ).rejects.toMatchObject({
      actual: 0,
      expected: EXPECTED_SCHEMA_VERSION,
    });
  });
});
