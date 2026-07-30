import type { QueryResult } from "./migrations";

export { EXPECTED_SCHEMA_VERSION } from "./schema-version";

import { EXPECTED_SCHEMA_VERSION } from "./schema-version";

export interface SchemaVersionConnection {
  readonly query: (
    text: string,
    values?: Array<unknown>,
  ) => Promise<QueryResult<{ version: number }>>;
}

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

export const assertExpectedSchemaVersion = async (
  connection: SchemaVersionConnection,
): Promise<void> => {
  let actual = 0;

  try {
    const result = await connection.query(
      `SELECT COALESCE(max(version), 0)::integer AS version
       FROM app_private.schema_migrations`,
    );
    actual = result.rows[0]?.version ?? 0;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "42P01"
    ) {
      throw new SchemaVersionMismatch(0, EXPECTED_SCHEMA_VERSION);
    }
    throw error;
  }

  if (actual !== EXPECTED_SCHEMA_VERSION) {
    throw new SchemaVersionMismatch(actual, EXPECTED_SCHEMA_VERSION);
  }
};
