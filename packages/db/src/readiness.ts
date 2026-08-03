export { EXPECTED_SCHEMA_VERSION } from "./schema-version";

import { sql } from "drizzle-orm";
import { makeDatabase, type QueryConnection } from "./database";
import { EXPECTED_SCHEMA_VERSION } from "./schema-version";

export interface SchemaVersionConnection extends QueryConnection {}

export class SchemaVersionMismatch extends Error {
  readonly actual: number;
  readonly expected: number;

  constructor(actual: number, expected: number) {
    super(`database schema version ${actual} does not match ${expected}`);
    this.name = "SchemaVersionMismatch";
    this.actual = actual;
    this.expected = expected;
  }
}

export class RestoreReplayRequired extends Error {
  constructor() {
    super("database restore replay is not complete");
    this.name = "RestoreReplayRequired";
  }
}

const isMissingRelation = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "42P01") return true;
  return "cause" in error && isMissingRelation(error.cause);
};

export const assertExpectedSchemaVersion = async (
  connection: SchemaVersionConnection,
  branchId?: string,
): Promise<void> => {
  const db = makeDatabase(connection);
  let actual = 0;

  try {
    const result = await db.execute<{ version: number | string }>(sql`
      SELECT COALESCE(max(created_at), 0)::bigint AS version
      FROM app_private.drizzle_migrations
    `);
    actual = Number(result[0]?.version ?? 0);
  } catch (error) {
    if (isMissingRelation(error)) {
      throw new SchemaVersionMismatch(0, EXPECTED_SCHEMA_VERSION);
    }
    throw error;
  }

  if (actual !== EXPECTED_SCHEMA_VERSION) {
    throw new SchemaVersionMismatch(actual, EXPECTED_SCHEMA_VERSION);
  }

  if (branchId !== undefined) {
    const readiness = await db.execute<{ ready: boolean }>(sql`
      SELECT app_private.is_restore_ready(${branchId}) AS ready
    `);
    if (readiness[0]?.ready !== true) throw new RestoreReplayRequired();
  }
};
