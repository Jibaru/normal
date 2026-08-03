import type { Client as PgClient } from "pg";
import { assertExpectedSchemaVersion } from "./readiness";

const withClient = async <Value>(
  connectionString: string,
  use: (client: PgClient) => Promise<Value>,
): Promise<Value> => {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });

  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
};

export const checkDatabaseReadiness = (
  connectionString: string,
  branchId?: string,
): Promise<void> =>
  withClient(connectionString, async (client) => {
    await assertExpectedSchemaVersion(
      {
        query: async (text, values) => {
          const result = await client.query(text, values as Array<unknown>);
          return { rows: result.rows };
        },
      },
      branchId,
    );
  });
