import { drizzle, type PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import type { Client as PgClient } from "pg";
import * as schema from "./schema";

export type Database = PgRemoteDatabase<typeof schema>;

export interface QueryConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export const makeDatabase = (client: QueryConnection): Database =>
  drizzle(
    async (text, values, method) => {
      const result = await client.query(text, values);
      return {
        rows:
          method === "all"
            ? result.rows.map((row) => Object.values(row))
            : result.rows,
      };
    },
    { schema },
  );

export const makeQueryConnection = (client: PgClient): QueryConnection => ({
  query: async (text, values) => {
    const result = await client.query(text, values);
    return { rows: result.rows };
  },
});

export const withPgQueryConnection = async <Value>(
  connectionString: string,
  use: (connection: QueryConnection) => Promise<Value>,
  queryTimeoutMillis = 5_000,
  connectionTimeoutMillis = 5_000,
): Promise<Value> => {
  const { Client } = await import("pg");
  const client: PgClient = new Client({
    connectionString,
    connectionTimeoutMillis,
    query_timeout: queryTimeoutMillis,
  });
  await client.connect();
  try {
    return await use(makeQueryConnection(client));
  } finally {
    await client.end();
  }
};
