import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectArtifactRoots } from "./inspect-production-bundles";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

const artifact = async (contents: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "production-artifact-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "index.js"), contents);
  return root;
};

describe("production artifact inspection", () => {
  it("accepts an ordinary production artifact", async () => {
    await expect(
      inspectArtifactRoots([
        await artifact("export const mode = 'production';"),
      ]),
    ).resolves.toBeUndefined();
  });

  for (const [name, contents] of [
    ["test module", 'from "./test/support/production"'],
    ["in-memory repository", "makeInMemoryMessageRepository()"],
    ["deterministic clock", "DeterministicClock"],
    ["fault injector", "faultInjector"],
    ["disabled authorization", "authorizationDisabled"],
    ["placeholder", "replace-with-production-secret"],
    [
      "hard-coded credential",
      ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_"),
    ],
  ] as const) {
    it(`rejects a reachable ${name} without disclosing the match`, async () => {
      const root = await artifact(contents);
      await expect(inspectArtifactRoots([root])).rejects.toThrow(
        `Prohibited production implementation found at production artifact ${join(root, "nested", "index.js")}`,
      );
    });
  }
});
