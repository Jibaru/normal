import { sql } from "drizzle-orm";
import {
  makeDatabase,
  type Database,
  type QueryConnection,
} from "./database";

export const withTransaction = async <Value>(
  connection: QueryConnection,
  use: (database: Database) => Promise<Value>,
): Promise<Value> => {
  const db = makeDatabase(connection);
  await db.execute(sql`BEGIN`);
  try {
    const value = await use(db);
    await db.execute(sql`COMMIT`);
    return value;
  } catch (error) {
    try {
      await db.execute(sql`ROLLBACK`);
    } catch {
      // Preserve the operation failure. It is the reason the transaction rolled back.
    }
    throw error;
  }
};
