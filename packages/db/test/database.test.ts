import { expect, mock, test } from "bun:test";
import type { Client as PgClient } from "pg";
import { makeQueryConnection } from "../src/database";

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
