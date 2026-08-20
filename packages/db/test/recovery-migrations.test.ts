import { describe, expect, test } from "bun:test";
import type { QueryConnection } from "../src/database";
import {
  applyRecoveryMigrationsWithClient,
  hardenRecoveryVerifierRoleWithClient,
  recoveryMigrationCreatedAts,
  recoveryMigrationRequiresVerifierHardeningWithClient,
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
    expect(queries.filter(({ text }) => text === "BEGIN")).toHaveLength(3);
    expect(queries.filter(({ text }) => text === "COMMIT")).toHaveLength(3);
    expect(queries.filter(({ text }) => text === "ROLLBACK")).toHaveLength(0);
    expect(
      queries
        .filter(({ text }) => text.startsWith("INSERT INTO public"))
        .map(({ values }) => values?.[1]),
    ).toEqual([1787126400000, 1787130000000, 1787166960000]);
  });

  test("requires verifier hardening only before its migration", async () => {
    const client = (createdAt: number): QueryConnection => ({
      query: async <Row extends Record<string, unknown>>() => ({
        rows: [{ created_at: String(createdAt) }] as unknown as Array<Row>,
      }),
    });
    await expect(
      recoveryMigrationRequiresVerifierHardeningWithClient(
        client(1787122800000),
      ),
    ).resolves.toBe(true);
    await expect(
      recoveryMigrationRequiresVerifierHardeningWithClient(
        client(1787126400000),
      ),
    ).resolves.toBe(false);
  });

  test("hardens the verifier role atomically before its migration", async () => {
    const queries: string[] = [];
    const client: QueryConnection = {
      query: async <Row extends Record<string, unknown>>(text: string) => {
        queries.push(text);
        if (text.includes("AS eligible"))
          return { rows: [{ eligible: true }] as unknown as Array<Row> };
        if (text.includes("AS hardened"))
          return { rows: [{ hardened: true }] as unknown as Array<Row> };
        return { rows: [] as Array<Row> };
      },
    };

    await hardenRecoveryVerifierRoleWithClient(client);

    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toContain("pg_has_role");
    expect(queries[2]).toBe("SET LOCAL ROLE neon_superuser");
    expect(queries[3]).toContain("REVOKE %I FROM whatsapp_recovery_verifier");
    expect(queries[3]).toContain("NOREPLICATION NOBYPASSRLS");
    expect(queries[4]).toBe("RESET ROLE");
    expect(queries.at(-1)).toBe("COMMIT");
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
        if (text !== "BEGIN" && text !== "ROLLBACK")
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
