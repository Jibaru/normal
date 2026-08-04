import { describe, expect, test } from "bun:test";
import type { QueryConnection } from "../src/database";
import { withTransaction } from "../src/transaction";

const recordingConnection = (
  failOn?: "BEGIN" | "COMMIT" | "ROLLBACK",
): { readonly connection: QueryConnection; readonly queries: Array<string> } => {
  const queries: Array<string> = [];
  return {
    connection: {
      query: async (text) => {
        queries.push(text);
        if (failOn !== undefined && text === failOn) {
          throw new Error(`${failOn} failed`);
        }
        return { rows: [] };
      },
    },
    queries,
  };
};

describe("withTransaction", () => {
  test("commits a successful operation", async () => {
    const { connection, queries } = recordingConnection();

    const result = await withTransaction(connection, async () => "done");

    expect(result).toBe("done");
    expect(queries).toEqual(["BEGIN", "COMMIT"]);
  });

  test("rolls back a failed operation", async () => {
    const { connection, queries } = recordingConnection();
    const failure = new Error("operation failed");

    await expect(
      withTransaction(connection, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
  });

  test("preserves the operation failure when rollback also fails", async () => {
    const { connection, queries } = recordingConnection("ROLLBACK");
    const failure = new Error("operation failed");

    await expect(
      withTransaction(connection, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
  });
});
