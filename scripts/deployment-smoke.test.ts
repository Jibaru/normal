import { describe, expect, test } from "bun:test";
import { runDeploymentSmoke } from "./deployment-smoke";

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("deployed production smoke command", () => {
  test("validates public discovery and waits for the private canary", async () => {
    const requests: Array<{
      authorization: string | null;
      method: string;
      path: string;
    }> = [];
    let polls = 0;
    const fetch = async (input: string, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        authorization: request.headers.get("authorization"),
        method: request.method,
        path: url.pathname,
      });
      if (url.origin === "https://web.example.test")
        return json({ service: "web", status: "ok" });
      if (url.pathname === "/health")
        return json({ service: "api", status: "ok" });
      if (url.pathname === "/ready")
        return json({ service: "api", status: "ready" });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json({
          authorization_endpoint: `${url.origin}/oauth/authorize`,
          code_challenge_methods_supported: ["S256"],
          issuer: url.origin,
          scopes_supported: [
            "connections:read",
            "directory:read",
            "messages:read",
            "messages:send",
          ],
          token_endpoint: `${url.origin}/oauth/token`,
        });
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return json({
          authorization_servers: [url.origin],
          bearer_methods_supported: ["header"],
          resource: `${url.origin}/mcp`,
          scopes_supported: [
            "connections:read",
            "directory:read",
            "messages:read",
            "messages:send",
          ],
        });
      if (url.pathname === "/mcp") {
        const payload = (await request.json()) as { id: string };
        return new Response(
          `event: message\ndata: ${JSON.stringify({ id: payload.id, jsonrpc: "2.0", result: {} })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (request.method === "POST")
        return json({ canary_id: `smk_${"a".repeat(43)}` }, 202);
      polls += 1;
      return json({
        status: polls === 1 ? "pending" : "complete",
        subsystems:
          polls === 1
            ? []
            : ["database", "provider-control", "queue", "r2-kms"],
      });
    };

    const result = await runDeploymentSmoke(
      {
        apiOrigin: "https://api.example.test",
        mcpAccessToken: "mcp-secret",
        smokeSecret: "smoke-secret",
        webOrigin: "https://web.example.test",
      },
      { fetch, pollDelayMs: 0 },
    );

    expect(result).toEqual({
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
      status: "ok",
    });
    expect(
      requests.find((request) => request.path === "/mcp")?.authorization,
    ).toBe("Bearer mcp-secret");
    expect(
      requests
        .filter((request) => request.path === "/_internal/deployment-smoke")
        .every((request) => request.authorization === "Bearer smoke-secret"),
    ).toBe(true);
  });

  test("reports only the safe subsystem and remediation command", async () => {
    const fetch = async (input: string) => {
      const url = new URL(input);
      if (
        url.origin === "https://api.example.test" &&
        url.pathname === "/health"
      )
        return json({ service: "api", status: "unavailable" }, 503);
      return json({ service: "web", status: "ok" });
    };

    await expect(
      runDeploymentSmoke(
        {
          apiOrigin: "https://api.example.test",
          mcpAccessToken: "must-not-leak",
          smokeSecret: "must-not-leak-either",
          webOrigin: "https://web.example.test",
        },
        { fetch, pollDelayMs: 0 },
      ),
    ).rejects.toThrow("api failed; remediate with: bun run deploy:smoke");
  });

  test("rejects a successful response whose health body is unavailable", async () => {
    const fetch = async (input: string) => {
      const url = new URL(input);
      if (url.origin === "https://web.example.test")
        return json({ service: "web", status: "ok" });
      return json({ service: "api", status: "unavailable" });
    };

    await expect(
      runDeploymentSmoke(
        {
          apiOrigin: "https://api.example.test",
          mcpAccessToken: "must-not-leak",
          smokeSecret: "must-not-leak-either",
          webOrigin: "https://web.example.test",
        },
        { fetch, pollDelayMs: 0 },
      ),
    ).rejects.toThrow("api failed; remediate with: bun run deploy:smoke");
  });

  test("reports an asynchronous R2/KMS failure without canary data", async () => {
    const fetch = async (input: string, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(input);
      if (url.origin === "https://web.example.test")
        return json({ service: "web", status: "ok" });
      if (url.pathname === "/health")
        return json({ service: "api", status: "ok" });
      if (url.pathname === "/ready")
        return json({ service: "api", status: "ready" });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json({
          authorization_endpoint: `${url.origin}/oauth/authorize`,
          code_challenge_methods_supported: ["S256"],
          issuer: url.origin,
          scopes_supported: [
            "connections:read",
            "directory:read",
            "messages:read",
            "messages:send",
          ],
          token_endpoint: `${url.origin}/oauth/token`,
        });
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return json({
          authorization_servers: [url.origin],
          bearer_methods_supported: ["header"],
          resource: `${url.origin}/mcp`,
          scopes_supported: [
            "connections:read",
            "directory:read",
            "messages:read",
            "messages:send",
          ],
        });
      if (url.pathname === "/mcp") {
        const payload = (await request.json()) as { id: string };
        return json({ id: payload.id, jsonrpc: "2.0", result: {} });
      }
      if (request.method === "POST")
        return json({ canary_id: `smk_${"a".repeat(43)}` }, 202);
      return json({ status: "failed", subsystems: ["r2-kms"] });
    };
    await expect(
      runDeploymentSmoke(
        {
          apiOrigin: "https://api.example.test",
          mcpAccessToken: "hidden",
          smokeSecret: "hidden",
          webOrigin: "https://web.example.test",
        },
        { fetch, pollDelayMs: 0 },
      ),
    ).rejects.toThrow("r2-kms failed; remediate with: bun run deploy:smoke");
  });
});
