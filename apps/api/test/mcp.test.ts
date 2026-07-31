import type { BeginToolCallResult } from "@whatsapp-mcp/db/mcp-tool";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  createMcpRequestHandler,
  McpToolClock,
  McpToolIdentifiers,
  McpToolPersistence,
  McpToolPersistenceError,
} from "../src/mcp";
import type { SafeTelemetryEvent } from "../src/services";
import { SafeTelemetry } from "../src/services";

const authorization = {
  authorizationId: "40000000-0000-4000-8000-000000000030",
  clientId: "approved-client",
  oauthSubject: "A".repeat(43),
} as const;

const jsonRpcRequest = (
  method: string,
  params?: unknown,
  protocolVersion = "2026-07-28",
) => {
  const parameters =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)
      : {};
  const name = parameters.name;
  return new Request("https://api.example.test/mcp", {
    body: JSON.stringify({
      id: "request-1",
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        ...(protocolVersion === "2026-07-28"
          ? {
              _meta: {
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/protocolVersion": protocolVersion,
              },
            }
          : {}),
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "api.example.test",
      "mcp-method": method,
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
      "mcp-protocol-version": protocolVersion,
    },
    method: "POST",
  });
};

const executionContext = {
  passThroughOnException: () => undefined,
  waitUntil: () => undefined,
} as unknown as ExecutionContext;

const responseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(data ?? "");
};

const responseMessages = async (
  response: Response,
): Promise<Array<Record<string, unknown>>> => {
  const text = await response.text();
  const payloads = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as unknown)
    : [JSON.parse(text) as unknown];
  return payloads
    .flatMap((payload) => (Array.isArray(payload) ? payload : [payload]))
    .filter(
      (payload): payload is Record<string, unknown> =>
        typeof payload === "object" && payload !== null,
    );
};

const makeHarness = (
  overrides: {
    readonly beginResult?: BeginToolCallResult;
    readonly failBegin?: boolean;
    readonly failComplete?: boolean;
    readonly failInspect?: boolean;
    readonly scopes?: ReadonlyArray<
      "connections:read" | "directory:read" | "messages:read" | "messages:send"
    >;
  } = {},
) => {
  const observations: Array<string> = [];
  const telemetry: Array<SafeTelemetryEvent> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(McpToolClock, {
      now: Effect.succeed(new Date("2026-07-31T12:00:00.000Z")),
    }),
    Layer.succeed(McpToolIdentifiers, {
      nextAuditLogId: Effect.succeed("50000000-0000-4000-8000-000000000030"),
    }),
    Layer.succeed(McpToolPersistence, {
      beginToolCall: () => {
        observations.push("begin");
        if (overrides.failBegin) {
          return Effect.fail(new McpToolPersistenceError());
        }
        if (overrides.beginResult !== undefined) {
          return Effect.succeed(overrides.beginResult);
        }
        if (
          overrides.scopes !== undefined &&
          !overrides.scopes.includes("connections:read")
        ) {
          return Effect.succeed({
            auditLogId: "50000000-0000-4000-8000-000000000030",
            outcome: "authorization_denied" as const,
          });
        }
        return Effect.succeed({
          auditLogId: "50000000-0000-4000-8000-000000000030",
          outcome: "started" as const,
        });
      },
      completeToolCall: () => {
        observations.push("complete");
        return overrides.failComplete
          ? Effect.fail(new McpToolPersistenceError())
          : Effect.void;
      },
      inspectAuthorization: () =>
        overrides.failInspect
          ? Effect.fail(new McpToolPersistenceError())
          : Effect.succeed({
              scopes: overrides.scopes ?? ["connections:read"],
            }),
      listConnections: () => {
        observations.push("list");
        return Effect.succeed([
          {
            displayName: null,
            numberLastFour: "1234",
            publicId: "con_123456789012345678901",
            state: "connected" as const,
            stateChangedAt: "2026-07-30T12:00:00.000Z",
          },
        ]);
      },
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          telemetry.push(event);
        }),
    }),
  );

  return {
    handler: createMcpRequestHandler({
      browserOrigin: "https://app.example.test",
      hourLimit: 10,
      layer,
      minuteLimit: 2,
      resourceUrl: "https://api.example.test/mcp",
    }),
    observations,
    telemetry,
  };
};

describe("stateless MCP list_connections boundary", () => {
  test("scope-filters discovery and publishes closed exact schemas", async () => {
    const permitted = makeHarness();
    const response = await permitted.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          inputSchema: Record<string, unknown>;
          name: string;
          outputSchema: Record<string, unknown>;
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0]).toMatchObject({
      name: "list_connections",
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      outputSchema: {
        additionalProperties: false,
        type: "object",
      },
    });

    const omitted = makeHarness({ scopes: ["messages:send"] });
    const omittedResponse = await omitted.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    expect(await omittedResponse.json()).toMatchObject({
      result: { tools: [] },
    });
  });

  test("scope-filters discovery in a legacy-stateless JSON-RPC batch", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const request = new Request("https://api.example.test/mcp", {
      body: JSON.stringify([
        {
          id: "request-1",
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        },
      ]),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "api.example.test",
        "mcp-protocol-version": "2025-06-18",
      },
      method: "POST",
    });
    const response = await harness.handler(
      request,
      {},
      executionContext,
      authorization,
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      result: { tools: [] },
    });
  });

  test("audits a direct call in a scope-filtered legacy batch", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const request = new Request("https://api.example.test/mcp", {
      body: JSON.stringify([
        {
          id: "discovery-request",
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        },
        {
          id: "call-request",
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: {}, name: "list_connections" },
        },
      ]),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "api.example.test",
        "mcp-protocol-version": "2025-06-18",
      },
      method: "POST",
    });
    const response = await harness.handler(
      request,
      {},
      executionContext,
      authorization,
    );
    const messages = await responseMessages(response);

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "discovery-request",
          result: { tools: [] },
        }),
        expect.objectContaining({
          id: "call-request",
          result: expect.objectContaining({
            isError: true,
            structuredContent: expect.objectContaining({
              error_code: "authorization_denied",
            }),
          }),
        }),
      ]),
    );
    expect(harness.observations).toEqual(["begin"]);
  });

  test("audits before reading and returns structured/text parity without provider data", async () => {
    const harness = makeHarness();
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        content: Array<{ text: string; type: string }>;
        structuredContent: unknown;
      };
    };

    expect(response.status).toBe(200);
    expect(harness.observations).toEqual(["begin", "list", "complete"]);
    expect(body.result.structuredContent).toEqual({
      connections: [
        {
          connection_id: "con_123456789012345678901",
          display_name: null,
          number_last_four: "1234",
          state: "connected",
          state_changed_at: "2026-07-30T12:00:00.000Z",
        },
      ],
    });
    expect(body.result.content).toEqual([
      {
        text: JSON.stringify(body.result.structuredContent),
        type: "text",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("provider");
    expect(harness.telemetry).toEqual([
      {
        event: "mcp.tool_call.completed",
        outcome: "success",
        resultCount: 1,
        service: "api",
        tool: "list_connections",
      },
    ]);
  });

  test("fails closed with a safe execution error when initial audit is unavailable", async () => {
    const harness = makeHarness({ failBegin: true });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error_code: "audit_unavailable",
          retryable: true,
        },
      },
    });
    expect(harness.observations).toEqual(["begin"]);
    expect(harness.telemetry).toEqual([
      {
        event: "mcp.tool_call.completed",
        outcome: "audit_unavailable",
        service: "api",
        tool: "list_connections",
      },
    ]);
  });

  test("enters the audited handler before authorization discovery on a direct call", async () => {
    const harness = makeHarness({ failBegin: true, failInspect: true });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error_code: "audit_unavailable",
          retryable: true,
        },
      },
    });
    expect(harness.observations).toEqual(["begin"]);
  });

  test("audits and rechecks scope when an omitted tool is invoked directly", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error_code: "authorization_denied",
          retryable: false,
        },
      },
    });
    expect(harness.observations).toEqual(["begin"]);
  });

  test("maps an authoritative quota rejection to stable retry and reset details", async () => {
    const harness = makeHarness({
      beginResult: {
        auditLogId: "50000000-0000-4000-8000-000000000030",
        outcome: "rate_limited",
        resetsAt: new Date("2026-07-31T12:00:30.000Z"),
        retryAfterSeconds: 30,
      },
    });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        content: Array<{ text: string; type: string }>;
        structuredContent: unknown;
      };
    };

    expect(body.result.structuredContent).toEqual({
      error_code: "rate_limited",
      message: "The request quota is exhausted.",
      resets_at: "2026-07-31T12:00:30.000Z",
      retry_after_seconds: 30,
      retryable: true,
    });
    expect(body.result.content).toEqual([
      {
        text: JSON.stringify(body.result.structuredContent),
        type: "text",
      },
    ]);
    expect(harness.observations).toEqual(["begin"]);
  });

  test("does not release Connection metadata when audit completion fails", async () => {
    const harness = makeHarness({ failComplete: true });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );
    const serialized = JSON.stringify(await response.json());

    expect(serialized).toContain("audit_unavailable");
    expect(serialized).not.toContain("con_123456789012345678901");
    expect(harness.observations).toEqual(["begin", "list", "complete"]);
  });

  test("supports the legacy-stateless 2025 protocol lane", async () => {
    const harness = makeHarness();
    const request = jsonRpcRequest("tools/list", undefined, "2025-06-18");
    const response = await harness.handler(
      request,
      {},
      executionContext,
      authorization,
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      result: {
        tools: [{ name: "list_connections" }],
      },
    });
  });
});
