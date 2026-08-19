import { sql } from "drizzle-orm";
import { makeDatabase, withPgQueryConnection } from "./database";

export const recordRecoverySourcePoint = (
  connectionString: string,
): Promise<string> =>
  withPgQueryConnection(
    connectionString,
    async (connection) => {
      const result = await makeDatabase(connection).execute<{
        observed_at: Date | string;
      }>(sql`
        SELECT public.record_recovery_source_point() AS observed_at
      `);
      const observedAt = result[0]?.observed_at;
      const timestamp =
        observedAt instanceof Date ? observedAt.toISOString() : observedAt;
      if (
        typeof timestamp !== "string" ||
        !Number.isFinite(Date.parse(timestamp))
      )
        throw new Error("recovery source point returned no timestamp");
      return new Date(timestamp).toISOString();
    },
    30_000,
    10_000,
  );
