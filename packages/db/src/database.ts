import { type SQL, sql } from "drizzle-orm";
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

export const makeDatabase = (client: PgClient): Database =>
  drizzle(
    async (text, values) => {
      const result = await client.query(text, values);
      return { rows: result.rows };
    },
    { schema },
  );

const bind = (text: string, values: ReadonlyArray<unknown>): SQL => {
  const chunks: Array<SQL> = [];
  let offset = 0;

  for (const match of text.matchAll(/\$(\d+)/gu)) {
    const index = match.index;
    if (index === undefined) continue;
    chunks.push(sql.raw(text.slice(offset, index)));
    chunks.push(sql`${values[Number(match[1]) - 1]}`);
    offset = index + match[0].length;
  }

  chunks.push(sql.raw(text.slice(offset)));
  return sql.join(chunks);
};

export const execute = async <Row extends Record<string, unknown>>(
  client: PgClient,
  text: string,
  values: ReadonlyArray<unknown> = [],
): Promise<{ readonly rows: Array<Row> }> => {
  const rows = await makeDatabase(client).execute<Row>(bind(text, values));
  return { rows: rows as Array<Row> };
};

export const makeQueryConnection = (client: PgClient): QueryConnection => ({
  query: (text, values) => execute(client, text, values),
});
