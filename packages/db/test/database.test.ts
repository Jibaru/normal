import { expect, mock, test } from "bun:test";
import type { Client as PgClient } from "pg";
import { makeQueryConnection, postgresErrorCode } from "../src/database";

test("raw query connections preserve native PostgreSQL array parameters", async () => {
  const query = mock(async () => ({ rows: [{ value: ["a", "b"] }] }));
  const connection = makeQueryConnection({ query } as unknown as PgClient);

  await expect(
    connection.query("SELECT $1::text[] AS value", [["a", "b"]]),
  ).resolves.toEqual({ rows: [{ value: ["a", "b"] }] });
  expect(query).toHaveBeenCalledWith("SELECT $1::text[] AS value", [
    ["a", "b"],
  ]);
});

test("extracts only a bounded PostgreSQL error code from nested causes", () => {
  expect(
    postgresErrorCode(
      new Error("query failed", {
        cause: Object.assign(new Error("sensitive database detail"), {
          code: "42501",
        }),
      }),
    ),
  ).toBe("42501");
  expect(postgresErrorCode(new Error("not a PostgreSQL error"))).toBe(
    "unknown",
  );
});
