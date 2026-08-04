import { expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Client as PgClient } from "pg";
import {
  makeDatabase,
  makeQueryConnection,
  type QueryConnection,
} from "../src/database";
import { whatsappConnectionsInApp } from "../src/schema/connections";

test("Drizzle builds and maps application queries", async () => {
  const query = mock(async () => ({
    rows: [{ public_id: "con_example", number_suffix: "3456" }],
  }));
  const database = makeDatabase({
    query: query as unknown as QueryConnection["query"],
  });

  const result = await database
    .select({
      connectionId: whatsappConnectionsInApp.publicId,
      numberSuffix: whatsappConnectionsInApp.numberSuffix,
    })
    .from(whatsappConnectionsInApp)
    .where(eq(whatsappConnectionsInApp.publicId, "con_example"));

  expect(result).toEqual([
    { connectionId: "con_example", numberSuffix: "3456" },
  ]);
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('from "whatsapp_connections"'),
    ["con_example"],
  );
});

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
