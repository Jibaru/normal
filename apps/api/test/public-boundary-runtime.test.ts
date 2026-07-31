import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { connectionSetupProvisioningMessage } from "../src/connection-setup-provisioning";
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
        message_retention_days: 30,
        state: "active",
        stored_media_limit_bytes: 5_368_709_120,
        whatsapp_connection_limit: 3,
      },
    });
  });

  test("starts and replays a Connection Setup through the signed-in HTTP boundary", async () => {
    const request = () =>
      new Request("https://api.example.test/v1/connection-setups", {
        body: JSON.stringify({
          idempotency_key: "123456789012345678901",
          whatsapp_number: "+1 (555) 012-3456",
        }),
        headers: {
          authorization: "Bearer signed-test-user",
          "content-type": "application/json",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      });

    const first = await exports.default.fetch(request());
    const replay = await exports.default.fetch(request());
    const firstBody = (await first.json()) as {
      readonly connection_setup: Record<string, unknown>;
    };
    const replayBody = (await replay.json()) as {
      readonly connection_setup: Record<string, unknown>;
    };

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(firstBody.connection_setup).toMatchObject({
      expires_at: "2026-01-02T03:19:05.000Z",
      idempotent_replay: false,
      state: "pending",
    });
    expect(replayBody.connection_setup).toEqual({
      ...firstBody.connection_setup,
      idempotent_replay: true,
    });

    const cancelRequest = () =>
      new Request(
        `https://api.example.test/v1/connection-setups/${String(
          firstBody.connection_setup.id,
        )}`,
        {
          headers: {
            authorization: "Bearer signed-test-user",
            origin: "http://127.0.0.1:3000",
          },
          method: "DELETE",
        },
      );
    const cancelled = await exports.default.fetch(cancelRequest());
    const cancelReplay = await exports.default.fetch(cancelRequest());

    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({
      connection_setup: {
        cleanup_state: "pending",
        id: firstBody.connection_setup.id,
        idempotent_replay: false,
        state: "cancelled",
      },
    });
    expect(await cancelReplay.json()).toEqual({
      connection_setup: {
        cleanup_state: "pending",
        id: firstBody.connection_setup.id,
        idempotent_replay: true,
        state: "cancelled",
      },
    });
  });

  test("provisions a Connection Setup through the actual Queue boundary", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/connection-setups", {
        body: JSON.stringify({
          idempotency_key: "223456789012345678901",
          whatsapp_number: "+1 (555) 012-3457",
        }),
        headers: {
          authorization: "Bearer signed-test-user",
          "content-type": "application/json",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );
    const body = (await response.json()) as {
      readonly connection_setup: { readonly id: string };
    };
    const batch = createMessageBatch(
      "whatsapp-mcp-connection-setup-provisioning",
      [
        {
          attempts: 1,
          body: connectionSetupProvisioningMessage(body.connection_setup.id),
          id: "connection-setup-provisioning-1",
          timestamp: new Date("2026-01-02T03:05:00.000Z"),
        },
      ],
    );
    const context = createExecutionContext();

    await worker.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);

    expect(response.status).toBe(201);
    expect(result).toMatchObject({
      ackAll: false,
      explicitAcks: ["connection-setup-provisioning-1"],
      outcome: "ok",
    });
  });

  test("returns the waitlist outcome through the signed-in public boundary", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/personal-account/bootstrap", {
        headers: {
          authorization: "Bearer signed-waitlisted-user",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      admission: { state: "waitlisted" },
    });
  });

  test("lists and revokes an MCP Authorization through the signed-in product boundary", async () => {
    const list = await exports.default.fetch(
      new Request("https://api.example.test/v1/mcp-authorizations", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
      }),
    );
    const body = (await list.json()) as {
      readonly mcp_authorizations: ReadonlyArray<{
        readonly id: string;
      }>;
    };
    const authorizationId = body.mcp_authorizations[0]?.id;
    if (authorizationId === undefined) {
      throw new Error("test authorization was not listed");
    }
    const revoked = await exports.default.fetch(
      new Request(
        `https://api.example.test/v1/mcp-authorizations/${authorizationId}`,
        {
          headers: {
            authorization: "Bearer signed-test-user",
            origin: "http://127.0.0.1:3000",
          },
          method: "DELETE",
        },
      ),
    );

    expect(list.status).toBe(200);
    expect(body.mcp_authorizations[0]).toMatchObject({
      client: {
        id: "approved-client",
        name: "Approved MCP Client",
      },
      connection_ids: ["con_123456789012345678901"],
      expiry_state: "active",
      revocation_state: "active",
      scopes: ["connections:read", "messages:send"],
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({
      mcp_authorization: {
        id: authorizationId,
        revocation_state: "revoked",
        revoked_at: "2026-01-02T03:05:00.000Z",
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
