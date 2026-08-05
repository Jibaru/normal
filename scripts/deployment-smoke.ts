export interface DeploymentSmokeConfig {
  readonly apiOrigin: string;
  readonly mcpAccessToken: string;
  readonly smokeSecret: string;
  readonly webOrigin: string;
}

interface Dependencies {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly pollDelayMs?: number;
}

const remediation = "bun run deploy:smoke";
const scopes = [
  "connections:read",
  "directory:read",
  "messages:read",
  "messages:send",
];
const canaryPattern = /^smk_[A-Za-z0-9_-]{43}$/u;

const fail = (subsystem: string): never => {
  throw new Error(`${subsystem} failed; remediate with: ${remediation}`);
};

const sameStrings = (value: unknown, expected: ReadonlyArray<string>) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  expected.every((item) => value.includes(item));

const requestJson = async (
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  subsystem: string,
  input: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    return fail(subsystem);
  }
  if (!response.ok) return fail(subsystem);
  const body = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return fail(subsystem);
  return body as Record<string, unknown>;
};

const requestMcpJson = async (
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  input: string,
  init: RequestInit,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    return fail("mcp");
  }
  if (!response.ok) return fail("mcp");
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return fail("mcp");
    return body as Record<string, unknown>;
  }
  if (!contentType.includes("text/event-stream")) return fail("mcp");
  const text = await response.text().catch(() => "");
  for (const event of text.split(/\r?\n\r?\n/u)) {
    const lines = event.split(/\r?\n/u);
    if (!lines.some((line) => line === "event: message")) continue;
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    const body = await Promise.resolve()
      .then(() => JSON.parse(data) as unknown)
      .catch(() => null);
    if (typeof body === "object" && body !== null && !Array.isArray(body))
      return body as Record<string, unknown>;
  }
  return fail("mcp");
};

const rpc = (method: string, id: string) => ({
  id,
  jsonrpc: "2.0",
  method,
  ...(method === "initialize"
    ? {
        params: {
          capabilities: {},
          clientInfo: { name: "deployment-smoke", version: "1" },
          protocolVersion: "2025-06-18",
        },
      }
    : {}),
});

export const runDeploymentSmoke = async (
  config: DeploymentSmokeConfig,
  dependencies: Dependencies = {},
) => {
  const fetch =
    dependencies.fetch ??
    ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const api = new URL(config.apiOrigin).origin;
  const web = new URL(config.webOrigin).origin;
  const webHealth = await requestJson(fetch, "web", `${web}/health`);
  if (webHealth.service !== "web" || webHealth.status !== "ok") fail("web");
  const apiHealth = await requestJson(fetch, "api", `${api}/health`);
  if (apiHealth.service !== "api" || apiHealth.status !== "ok") fail("api");
  const apiReadiness = await requestJson(fetch, "api", `${api}/ready`);
  if (apiReadiness.service !== "api" || apiReadiness.status !== "ready")
    fail("api");
  const authorization = await requestJson(
    fetch,
    "oauth",
    `${api}/.well-known/oauth-authorization-server`,
  );
  const resource = await requestJson(
    fetch,
    "oauth",
    `${api}/.well-known/oauth-protected-resource/mcp`,
  );
  if (
    authorization.issuer !== api ||
    authorization.authorization_endpoint !== `${api}/oauth/authorize` ||
    authorization.token_endpoint !== `${api}/oauth/token` ||
    !sameStrings(authorization.code_challenge_methods_supported, ["S256"]) ||
    !sameStrings(authorization.scopes_supported, scopes) ||
    "registration_endpoint" in authorization ||
    resource.resource !== `${api}/mcp` ||
    !sameStrings(resource.authorization_servers, [api]) ||
    !sameStrings(resource.bearer_methods_supported, ["header"]) ||
    !sameStrings(resource.scopes_supported, scopes)
  )
    fail("oauth");

  const mcpHeaders = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${config.mcpAccessToken}`,
    "content-type": "application/json",
  };
  for (const [method, id] of [
    ["initialize", "smoke-init"],
    ["tools/list", "smoke-discovery"],
  ] as const) {
    const body = await requestMcpJson(fetch, `${api}/mcp`, {
      body: JSON.stringify(rpc(method, id)),
      headers: mcpHeaders,
      method: "POST",
    });
    if (body.jsonrpc !== "2.0" || body.id !== id || !("result" in body))
      fail("mcp");
  }

  const smokeHeaders = { authorization: `Bearer ${config.smokeSecret}` };
  const started = await requestJson(
    fetch,
    "deployment-canary",
    `${api}/_internal/deployment-smoke`,
    {
      headers: smokeHeaders,
      method: "POST",
    },
  );
  const canaryId =
    typeof started.canary_id === "string" &&
    canaryPattern.test(started.canary_id)
      ? started.canary_id
      : fail("deployment-canary");

  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    const state = await requestJson(
      fetch,
      "deployment-canary",
      `${api}/_internal/deployment-smoke?id=${encodeURIComponent(canaryId)}`,
      { headers: smokeHeaders },
    );
    if (state.status === "complete") {
      const subsystems = Array.isArray(state.subsystems)
        ? state.subsystems
        : fail("deployment-canary");
      for (const required of [
        "database",
        "provider-control",
        "queue",
        "r2-kms",
      ])
        if (!subsystems.includes(required)) fail(required);
      return {
        checks: [
          "web",
          "api",
          "oauth",
          "mcp",
          "database",
          "provider-control",
          "queue",
          "r2-kms",
        ],
        status: "ok" as const,
      };
    }
    if (state.status === "failed") {
      const [subsystem] = Array.isArray(state.subsystems)
        ? state.subsystems
        : [];
      return fail(
        typeof subsystem === "string" ? subsystem : "deployment-canary",
      );
    }
    if (state.status !== "pending") fail("deployment-canary");
    await new Promise((resolve) =>
      setTimeout(resolve, dependencies.pollDelayMs ?? 500),
    );
  }
  return fail("queue");
};

const required = (name: string): string => {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required; remediate with: ${remediation}`);
  return value;
};

if (import.meta.main) {
  runDeploymentSmoke({
    apiOrigin: required("SMOKE_API_ORIGIN"),
    mcpAccessToken: required("SMOKE_MCP_ACCESS_TOKEN"),
    smokeSecret: required("SMOKE_CHECK_SECRET"),
    webOrigin: required("SMOKE_WEB_ORIGIN"),
  })
    .then((result) => console.info(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(
        error instanceof Error
          ? error.message
          : `smoke failed; remediate with: ${remediation}`,
      );
      process.exitCode = 1;
    });
}
