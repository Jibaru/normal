import { readdir } from "node:fs/promises";
import { join } from "node:path";

const forbiddenMarkers = [
  "TEST_LAYER_SENTINEL_DO_NOT_INCLUDE_IN_PRODUCTION",
  "TEST_FAULT_INJECTOR_DO_NOT_INCLUDE_IN_PRODUCTION",
  "signed-test-user",
  "x-test-failure",
] as const;
const roots = [
  "apps/api/dist",
  "apps/provider-control/dist",
  "apps/web/.next/server",
  "apps/web/.next/static",
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
    for (const marker of forbiddenMarkers) {
      if (contents.includes(marker)) {
        throw new Error(
          `Test-only marker ${JSON.stringify(marker)} found in production output: ${entryPath}`,
        );
      }
    }
  }
};

await Promise.all(roots.map(inspect));
console.info(
  "Production outputs contain no test Layers, fakes, or fault injectors.",
);
