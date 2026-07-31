import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import worker from "./support/public-boundary-worker";

describe("public-boundary Worker harness", () => {
  test("keeps the production Worker entrypoint under the runtime harness", async () => {
    const response = await exports.default.fetch(
      "https://api.example.test/health",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "api",
      status: "ok",
    });
  });

  test("runs deterministic external identity and provider Layers through HTTP", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/personal-account", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(await response.json()).toEqual({
      connection_id: "con_0123456789abcdefghijk",
      observed_at: "2026-01-02T03:04:05.000Z",
      provider_state: "connected",
      user_id: "user_test_public_boundary",
    });
  });

  test("bootstraps a Personal Account through the public browser/API seam", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/personal-account/bootstrap", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(await response.json()).toEqual({
      personal_account: {
        state: "active",
        stored_media_limit_bytes: 5_368_709_120,
        whatsapp_connection_limit: 3,
      },
    });
  });

  test("injects deterministic external failures only in the test root", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/personal-account", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
          "x-test-failure": "provider",
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "controlled_external_failure",
    });
  });

  test("drives OAuth authorization over signed-in HTTP without following the client redirect", async () => {
    const response = await exports.default.fetch(
      new Request(
        "https://api.example.test/oauth/authorize?redirect_uri=https%3A%2F%2Fclient.example.test%2Fcallback&state=state_123",
        {
          headers: {
            authorization: "Bearer signed-test-user",
          },
          redirect: "manual",
        },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(
      "https://client.example.test/callback?code=oauth_test_code&state=state_123",
    );
  });

  test("drives MCP discovery through HTTP JSON-RPC", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/mcp", {
        body: JSON.stringify({
          id: "request-1",
          jsonrpc: "2.0",
          method: "tools/list",
        }),
        headers: {
          authorization: "Bearer signed-test-user",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "request-1",
      jsonrpc: "2.0",
      result: { tools: [] },
    });
  });

  test("reads a protected resource through the authenticated HTTP boundary", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/mcp/resources/protected", {
        headers: {
          authorization: "Bearer signed-test-user",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "protected boundary",
    );
  });

  test("uses real KV, R2, Queue, and service bindings from an actual fetch handler", async () => {
    const response = await exports.default.fetch(
      "https://api.example.test/test/bindings",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kv: "stored",
      provider_control: "ok",
      queue: "published",
      r2: "stored",
    });
    expect(await env.OAUTH_KV.get("public-boundary:kv")).toBe("stored");
    expect(
      await (await env.WEBHOOK_INGRESS.get("public-boundary/r2"))?.text(),
    ).toBe("stored");
  });

  test("runs Queue handlers with explicit acknowledgement against real bindings", async () => {
    const batch = createMessageBatch("whatsapp-mcp-ingestion", [
      {
        attempts: 1,
        body: { object_id: "evt_public_boundary" },
        id: "queue-message-1",
        timestamp: new Date("2026-01-02T03:04:05.000Z"),
      },
    ]);
    const context = createExecutionContext();

    await worker.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);

    expect(result).toMatchObject({
      ackAll: false,
      explicitAcks: ["queue-message-1"],
      outcome: "ok",
    });
    expect(await env.OAUTH_KV.get("queue:queue-message-1")).toBe(
      '{"object_id":"evt_public_boundary"}',
    );
  });

  test("runs scheduled handlers against real KV and service bindings", async () => {
    const controller = createScheduledController({
      cron: "*/5 * * * *",
      scheduledTime: new Date("2026-01-02T03:05:00.000Z").valueOf(),
    });
    const context = createExecutionContext();

    await worker.scheduled?.(controller, env, context);
    await waitOnExecutionContext(context);

    expect(await env.OAUTH_KV.get("scheduled:last")).toBe(
      "2026-01-02T03:05:00.000Z",
    );
    expect(await env.OAUTH_KV.get("scheduled:provider-control")).toBe("ok");
  });
});
