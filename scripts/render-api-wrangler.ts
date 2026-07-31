import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const [outputArgument, environmentArgument = "production"] =
  process.argv.slice(2);

if (!outputArgument) {
  throw new Error(
    "usage: render-api-wrangler.ts <output-path> [development|preview|production]",
  );
}

if (!["development", "preview", "production"].includes(environmentArgument)) {
  throw new Error(
    "deployment environment must be development, preview, or production",
  );
}

const requireIdentifier = (name: string): string => {
  const value = process.env[name];
  if (!value || !/^[a-f0-9]{32}$/.test(value)) {
    throw new Error(`${name} must be a 32-character Cloudflare identifier`);
  }
  return value;
};

const requireHttpsOrigin = (name: string): string => {
  const value = process.env[name];
  try {
    const url = new URL(value ?? "");
    if (
      value &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    ) {
      return value;
    }
  } catch {
    // The single safe error below intentionally does not echo configuration.
  }
  throw new Error(`${name} must be an exact HTTPS origin`);
};

const sourcePath = resolve(import.meta.dir, "../apps/api/wrangler.jsonc");
const outputPath = resolve(process.cwd(), outputArgument);
const config = JSON.parse(await readFile(sourcePath, "utf8")) as Record<
  string,
  unknown
>;
const oauthKvNamespaceId = requireIdentifier("CLOUDFLARE_OAUTH_KV_ID");
const oauthKvPlaceholder = "replace-with-rendered-oauth-kv-id";
const clerkVariables = {
  CLERK_API_AUDIENCE: requireHttpsOrigin("CLERK_API_AUDIENCE"),
  CLERK_AUTHORIZED_PARTY: requireHttpsOrigin("CLERK_AUTHORIZED_PARTY"),
  CLERK_ISSUER: requireHttpsOrigin("CLERK_ISSUER"),
};
const renderClerkVariables = (target: Record<string, unknown>): void => {
  const variables = target.vars;
  if (typeof variables !== "object" || variables === null) {
    throw new Error("API Wrangler source config must declare variables");
  }
  Object.assign(variables, clerkVariables);
};
const renderOAuthKv = (target: Record<string, unknown>): void => {
  const namespaces = target.kv_namespaces;
  if (!Array.isArray(namespaces)) {
    throw new Error("API Wrangler source config must declare OAuth KV");
  }
  const oauth = namespaces.find(
    (namespace) =>
      typeof namespace === "object" &&
      namespace !== null &&
      (namespace as Record<string, unknown>).binding === "OAUTH_KV",
  ) as Record<string, unknown> | undefined;
  if (!oauth || oauth.id !== oauthKvPlaceholder) {
    throw new Error(
      "API Wrangler source config must use the OAuth KV placeholder",
    );
  }
  oauth.id = oauthKvNamespaceId;
};
const rebasePath = (value: string): string =>
  relative(dirname(outputPath), resolve(dirname(sourcePath), value)).replaceAll(
    sep,
    "/",
  );

for (const key of ["$schema", "main"]) {
  const value = config[key];
  if (typeof value !== "string") {
    throw new Error(`API Wrangler source config must define string ${key}`);
  }
  config[key] = rebasePath(value);
}

if (environmentArgument === "production") {
  renderOAuthKv(config);
}
renderClerkVariables(config);
const environments = config.env;
if (typeof environments !== "object" || environments === null) {
  throw new Error("API Wrangler source config must declare environments");
}
const selectedEnvironment = (environments as Record<string, unknown>)[
  environmentArgument
];
if (typeof selectedEnvironment !== "object" || selectedEnvironment === null) {
  throw new Error(
    `API Wrangler source config is missing ${environmentArgument}`,
  );
}
renderOAuthKv(selectedEnvironment as Record<string, unknown>);
renderClerkVariables(selectedEnvironment as Record<string, unknown>);

const hyperdrive = [
  {
    binding: "HYPERDRIVE",
    id: requireIdentifier("CLOUDFLARE_HYPERDRIVE_ID"),
  },
  {
    binding: "WEBHOOK_HYPERDRIVE",
    id: requireIdentifier("CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID"),
  },
];
config.hyperdrive = hyperdrive;
(selectedEnvironment as Record<string, unknown>).hyperdrive = hyperdrive;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
await chmod(outputPath, 0o600);
