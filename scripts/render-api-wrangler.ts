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

const requireOAuthClientRegistry = (): string => {
  const serialized = process.env.OAUTH_CLIENT_REGISTRY;
  try {
    const clients = JSON.parse(serialized ?? "") as unknown;
    if (
      serialized &&
      serialized.length <= 32_768 &&
      Array.isArray(clients) &&
      clients.length >= 1 &&
      clients.length <= 32 &&
      clients.every(
        (client) =>
          typeof client === "object" &&
          client !== null &&
          !Array.isArray(client) &&
          typeof (client as Record<string, unknown>).clientClass === "string" &&
          typeof (client as Record<string, unknown>).clientId === "string" &&
          typeof (client as Record<string, unknown>).clientName === "string" &&
          Array.isArray((client as Record<string, unknown>).redirectUris),
      )
    ) {
      return serialized;
    }
  } catch {
    // The single safe error below intentionally does not echo configuration.
  }
  throw new Error(
    "OAUTH_CLIENT_REGISTRY must contain at least one allowlisted MCP Client",
  );
};

const requireMcpResource = (issuer: string): string => {
  const resource = process.env.OAUTH_RESOURCE;
  if (resource === `${issuer}/mcp`) {
    return resource;
  }
  throw new Error("OAUTH_RESOURCE must be the issuer's exact /mcp resource");
};

const requireProviderApprovedSessionCapacity = (): string => {
  const value = process.env.PROVIDER_APPROVED_SESSION_CAPACITY;
  if (!value || !/^[0-9]+$/.test(value)) {
    throw new Error(
      "PROVIDER_APPROVED_SESSION_CAPACITY must be a positive integer",
    );
  }
  const capacity = Number(value);
  if (!Number.isSafeInteger(capacity) || capacity < 3) {
    throw new Error(
      "PROVIDER_APPROVED_SESSION_CAPACITY must reserve at least three sessions",
    );
  }
  return String(capacity);
};

const requirePositiveInteger = (name: string): number => {
  const value = process.env[name];
  if (!value || !/^[0-9]+$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
};

const sourcePath = resolve(import.meta.dir, "../apps/api/wrangler.jsonc");
const outputPath = resolve(process.cwd(), outputArgument);
const config = JSON.parse(await readFile(sourcePath, "utf8")) as Record<
  string,
  unknown
>;
const oauthKvNamespaceId = requireIdentifier("CLOUDFLARE_OAUTH_KV_ID");
const oauthKvPlaceholder = "replace-with-rendered-oauth-kv-id";
const oauthIssuer = requireHttpsOrigin("OAUTH_ISSUER");
const mcpRequestsPerMinute = requirePositiveInteger("MCP_REQUESTS_PER_MINUTE");
const mcpRequestsPerHour = requirePositiveInteger("MCP_REQUESTS_PER_HOUR");
const readMessageRecordsPerDay = requirePositiveInteger(
  "READ_MESSAGE_RECORDS_PER_DAY",
);
const decryptedMediaBytesPerDay = requirePositiveInteger(
  "DECRYPTED_MEDIA_BYTES_PER_DAY",
);
const sendsPerDay = requirePositiveInteger("SENDS_PER_DAY");
const sendsPerMinute = requirePositiveInteger("SENDS_PER_MINUTE");
if (mcpRequestsPerHour < mcpRequestsPerMinute) {
  throw new Error(
    "MCP_REQUESTS_PER_HOUR must be at least MCP_REQUESTS_PER_MINUTE",
  );
}
const apiVariables = {
  CLERK_API_AUDIENCE: requireHttpsOrigin("CLERK_API_AUDIENCE"),
  CLERK_AUTHORIZED_PARTY: requireHttpsOrigin("CLERK_AUTHORIZED_PARTY"),
  CLERK_ISSUER: requireHttpsOrigin("CLERK_ISSUER"),
  DECRYPTED_MEDIA_BYTES_PER_DAY: String(decryptedMediaBytesPerDay),
  MCP_REQUESTS_PER_HOUR: String(mcpRequestsPerHour),
  MCP_REQUESTS_PER_MINUTE: String(mcpRequestsPerMinute),
  READ_MESSAGE_RECORDS_PER_DAY: String(readMessageRecordsPerDay),
  SENDS_PER_DAY: String(sendsPerDay),
  SENDS_PER_MINUTE: String(sendsPerMinute),
  OAUTH_CLIENT_REGISTRY: requireOAuthClientRegistry(),
  OAUTH_ISSUER: oauthIssuer,
  OAUTH_RESOURCE: requireMcpResource(oauthIssuer),
  PROVIDER_APPROVED_SESSION_CAPACITY: requireProviderApprovedSessionCapacity(),
};
if (apiVariables.CLERK_API_AUDIENCE !== oauthIssuer) {
  throw new Error(
    "OAUTH_ISSUER must equal the same-environment CLERK_API_AUDIENCE",
  );
}
const renderApiVariables = (target: Record<string, unknown>): void => {
  const variables = target.vars;
  if (typeof variables !== "object" || variables === null) {
    throw new Error("API Wrangler source config must declare variables");
  }
  Object.assign(variables, apiVariables);
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
renderApiVariables(config);
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
renderApiVariables(selectedEnvironment as Record<string, unknown>);

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
