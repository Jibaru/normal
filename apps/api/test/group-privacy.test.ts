import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  groupNamePrefixIndexes,
  groupSearchIndex,
  importGroupDirectoryIndexKey,
  normalizeGroupDisplayName,
} from "../src/group-privacy";

describe("group Directory privacy", () => {
  test("normalizes names and makes only connection-bound prefix tokens", async () => {
    const key = await Effect.runPromise(
      importGroupDirectoryIndexKey(new Uint8Array(32).fill(39)),
    );
    const connectionId = "20000000-0000-4000-8000-000000000039";
    const indexes = await Effect.runPromise(
      groupNamePrefixIndexes(key, connectionId, "ＦＡＭily"),
    );
    const search = await Effect.runPromise(
      groupSearchIndex(key, connectionId, "fam"),
    );
    const otherConnectionSearch = await Effect.runPromise(
      groupSearchIndex(key, "20000000-0000-4000-8000-000000000040", "fam"),
    );

    expect(normalizeGroupDisplayName("ＦＡＭily")).toBe("family");
    expect(indexes).toHaveLength(4);
    expect(indexes).toContain(search);
    expect(indexes).not.toContain(otherConnectionSearch);
    expect(
      indexes.every((index) => /^gi1_[A-Za-z0-9_-]{43}$/u.test(index)),
    ).toBe(true);
    expect(JSON.stringify(indexes)).not.toContain("fam");
  });

  test("rejects invalid index keys and prefix lengths", async () => {
    await expect(
      Effect.runPromise(importGroupDirectoryIndexKey(new Uint8Array(31))),
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        groupSearchIndex(
          await Effect.runPromise(
            importGroupDirectoryIndexKey(new Uint8Array(32).fill(39)),
          ),
          "20000000-0000-4000-8000-000000000039",
          "ab",
        ),
      ),
    ).rejects.toBeDefined();
  });
});
