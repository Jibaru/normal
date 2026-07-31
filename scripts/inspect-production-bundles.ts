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

const inspectForForbiddenAuthority = async (
  path: string,
  forbiddenValues: ReadonlyArray<string>,
): Promise<void> => {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await inspectForForbiddenAuthority(entryPath, forbiddenValues);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".map")) continue;
    const contents = await Bun.file(entryPath).text();
    for (const forbiddenValue of forbiddenValues) {
      if (contents.includes(forbiddenValue)) {
        throw new Error(
          `Forbidden production authority ${forbiddenValue} found in ${entryPath}`,
        );
      }
    }
  }
};

await Promise.all([
  inspectForForbiddenAuthority("apps/api/dist", [
    "WASENDER_API_CREDENTIAL",
    "WASENDER_REFERENCE_SECRET",
  ]),
  inspectForForbiddenAuthority("apps/web/.next/server", [
    "WASENDER_API_CREDENTIAL",
    "WASENDER_REFERENCE_SECRET",
  ]),
  inspectForForbiddenAuthority("apps/provider-control/dist", [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "DATABASE_URL",
    "HYPERDRIVE",
    "KMS_CONTENT_ROOT_KEY_ARN",
    "STORED_MEDIA",
    "WEBHOOK_INGRESS",
  ]),
]);
console.info("Production outputs contain no test Layer marker.");
