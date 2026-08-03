import { sql } from "drizzle-orm";
import {
  makeDatabase,
  makeQueryConnection,
  type QueryConnection,
} from "./database";

export interface MessageRetentionPolicy {
  readonly days: number | null;
  readonly updatedAt: string;
}

export interface MessageRetentionConnection extends QueryConnection {}

export interface MessageRetentionConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: MessageRetentionConnection) => Promise<Value>,
  ) => Promise<Value>;
}

const decode = (
  row: Record<string, unknown> | undefined,
): MessageRetentionPolicy | null => {
  if (row === undefined) return null;
  const days = row.retention_days;
  const updated = row.retention_updated_at;
  const date = updated instanceof Date ? updated : new Date(String(updated));
  if (
    (days !== null &&
      (!Number.isSafeInteger(Number(days)) || Number(days) <= 0)) ||
    !Number.isFinite(date.valueOf())
  ) {
    throw new Error("invalid Message Retention Policy");
  }
  return {
    days: days === null ? null : Number(days),
    updatedAt: date.toISOString(),
  };
};

export const makeMessageRetentionRepository = (
  provider: MessageRetentionConnectionProvider,
) => ({
  getForUser: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
  }) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const result = await db.execute(sql`
        SELECT * FROM app_private.get_message_retention_policy(
          ${input.clerkUserId}, ${input.connectionPublicId}
        )
      `);
      return decode(result[0]);
    }),
  updateForUser: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
    readonly days: number | null;
    readonly expectedDays: number | null;
    readonly updatedAt: string;
  }) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const result = await db.execute(sql`
        SELECT * FROM app_private.update_message_retention_policy(
          ${input.clerkUserId}, ${input.connectionPublicId},
          ${input.expectedDays}, ${input.days}, ${input.updatedAt}
        )
      `);
      return decode(result[0]);
    }),
  purgeExpired: (observedAt: string, limit: number) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const result = await db.execute<{ purged_count: unknown }>(sql`
        SELECT app_private.purge_expired_message_content(
          ${observedAt}, ${limit}
        ) AS purged_count
      `);
      const count = Number(result[0]?.purged_count);
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error("invalid retention purge result");
      return count;
    }),
});

const makePgProvider = (
  connectionString: string,
): MessageRetentionConnectionProvider => ({
  withConnection: async (use) => {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 70_000,
    });
    await client.connect();
    try {
      return await use(makeQueryConnection(client));
    } finally {
      await client.end();
    }
  },
});

export const makePgMessageRetentionRepository = (connectionString: string) =>
  makeMessageRetentionRepository(makePgProvider(connectionString));
