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
  "apps/deletion-coordinator/dist",
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
    "MCP_CURSOR_HMAC_SECRET",
    "SEND_FINGERPRINT_HMAC_SECRET",
    "WASENDER_API_CREDENTIAL",
    "WASENDER_REFERENCE_SECRET",
    "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
  ]),
  inspectForForbiddenAuthority("apps/provider-control/dist", [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "DATABASE_URL",
    "HYPERDRIVE",
    "KMS_CONTENT_ROOT_KEY_ARN",
    "MCP_CURSOR_HMAC_SECRET",
    "STORED_MEDIA",
    "WEBHOOK_INGRESS",
    "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
    "MCP_CURSOR_HMAC_SECRET",
  ]),
  inspectForForbiddenAuthority("apps/deletion-coordinator/dist", [
    "KMS_CONTENT_ROOT_KEY_ARN",
    "MCP_CURSOR_HMAC_SECRET",
    "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
    "STORED_MEDIA",
    "WEBHOOK_INGRESS",
  ]),
]);
console.info(
  "Production outputs contain no test Layers, fakes, or fault injectors.",
);
