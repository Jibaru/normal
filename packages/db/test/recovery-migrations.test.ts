import { describe, expect, test } from "bun:test";
import type { QueryConnection } from "../src/database";
import {
  applyRecoveryMigrationsWithClient,
  recoveryMigrationCreatedAts,
} from "../src/recovery-migrations";

describe("recovery migrations", () => {
  test("embeds every production migration in journal order", async () => {
    const journal = (await Bun.file(
      new URL("../drizzle/meta/_journal.json", import.meta.url),
    ).json()) as { entries: Array<{ when: number }> };
    expect(recoveryMigrationCreatedAts).toEqual(
      journal.entries.map(({ when }) => when),
    );
  });

  test("applies every pending migration in its own transaction", async () => {
    const queries: Array<{ text: string; values?: Array<unknown> }> = [];
    const client: QueryConnection = {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: Array<unknown>,
      ) => {
        queries.push(values === undefined ? { text } : { text, values });
        if (text.startsWith("SELECT created_at"))
          return {
            rows: [{ created_at: "1787122800000" }] as unknown as Array<Row>,
          };
        return { rows: [] };
      },
    };

    await expect(applyRecoveryMigrationsWithClient(client)).resolves.toBe(3);
    expect(queries.filter(({ text }) => text === "BEGIN")).toHaveLength(4);
    expect(queries.filter(({ text }) => text === "COMMIT")).toHaveLength(4);
    expect(queries.filter(({ text }) => text === "ROLLBACK")).toHaveLength(0);
    expect(
      queries.some(({ text }) =>
        text.includes("ALTER ROLE whatsapp_recovery_verifier"),
      ),
    ).toBe(true);
    expect(
      queries
        .filter(({ text }) => text.startsWith("INSERT INTO public"))
        .map(({ values }) => values?.[1]),
    ).toEqual([1787126400000, 1787130000000, 1787166960000]);
  });

  test("rolls back a failed migration without advancing the ledger", async () => {
    const queries: string[] = [];
    const client: QueryConnection = {
      query: async <Row extends Record<string, unknown>>(text: string) => {
        queries.push(text);
        if (text.startsWith("SELECT created_at"))
          return {
            rows: [{ created_at: "1787122800000" }] as unknown as Array<Row>,
          };
        if (
          text !== "BEGIN" &&
          text !== "COMMIT" &&
          text !== "ROLLBACK" &&
          text.includes("ALTER ROLE whatsapp_recovery_verifier") === false
        )
          throw new Error("migration statement failed");
        return { rows: [] };
      },
    };

    await expect(applyRecoveryMigrationsWithClient(client)).rejects.toThrow(
      "migration statement failed",
    );
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries.some((text) => text.startsWith("INSERT INTO public"))).toBe(
      false,
    );
  });
});
