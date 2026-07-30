import { readdir } from "node:fs/promises";
import { join } from "node:path";

const sentinel = "TEST_LAYER_SENTINEL_DO_NOT_INCLUDE_IN_PRODUCTION";
const roots = [
  "apps/api/dist",
  "apps/provider-control/dist",
  "apps/web/.next/server",
];

const inspect = async (path: string): Promise<void> => {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await inspect(entryPath);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".map")) {
      continue;
    }
    const contents = await Bun.file(entryPath).text();
    if (contents.includes(sentinel)) {
      throw new Error(
        `Test Layer marker found in production output: ${entryPath}`,
      );
    }
  }
};

await Promise.all(roots.map(inspect));
console.info("Production outputs contain no test Layer marker.");
