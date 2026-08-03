import type { ToolCallLogSummary } from "@whatsapp-mcp/db/tool-call-log";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  HumanIdentity,
  InvalidHumanIdentity,
} from "../src/auth/human-identity";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";
import {
  createToolCallLogHandler,
  ToolCallLogClock,
  ToolCallLogPersistence,
  ToolCallLogPersistenceError,
} from "../src/tool-call-log";

const browserOrigin = "https://app.example.test";
const safeLog: ToolCallLogSummary = {
  authorizationId: "mca_123456789012345678901",
  clientId: "approved-client",
  clientName: "Approved MCP Client",
  completedAt: new Date("2026-08-01T12:00:00.120Z"),
  connectionId: "con_123456789012345678901",
  errorCode: null,
  latencyMs: 120,
  mediaBytes: 0,
  outcome: "success",
  resultCount: 2,
  sendId: null,
  startedAt: new Date("2026-08-01T12:00:00.000Z"),
  toolName: "list_connections",
};

const makeHandler = (
  options: {
    readonly nextCursor?: string;
    readonly unavailable?: boolean;
  } = {},
) => {
  const cursors: Array<string | null> = [];
  const telemetry: SafeTelemetryEvent[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: (request) =>
        request.headers.get("authorization") === "Bearer owner"
          ? Effect.succeed("user_owner")
          : Effect.fail(new InvalidHumanIdentity()),
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(ToolCallLogClock, {
      now: Effect.succeed(new Date("2026-08-01T12:01:00.000Z")),
    }),
    Layer.succeed(ToolCallLogPersistence, {
      list: (clerkUserId, _observedAt, cursor) => {
        cursors.push(cursor);
        return options.unavailable
          ? Effect.fail(new ToolCallLogPersistenceError())
          : Effect.succeed(
              clerkUserId === "user_owner"
                ? {
                    logs: [safeLog],
                    nextCursor: options.nextCursor ?? null,
                  }
                : null,
            );
      },
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) => Effect.sync(() => telemetry.push(event)),
    }),
  );
  return {
    cursors,
    handler: createToolCallLogHandler(layer, browserOrigin),
    telemetry,
  };
};

const request = (authorization = "Bearer owner", origin = browserOrigin) =>
  new Request("https://api.example.test/v1/tool-call-logs", {
    headers: { authorization, origin },
  });

describe("Tool Call Log product boundary", () => {
  test("returns only the safe metadata allowlist", async () => {
    const harness = makeHandler();
    const response = await harness.handler(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      next_cursor: null,
      tool_call_logs: [
        {
          capability: "list_connections",
          client: { id: "approved-client", name: "Approved MCP Client" },
          completed_at: "2026-08-01T12:00:00.120Z",
          counts: { media_bytes: 0, results: 2 },
          error_code: null,
          latency_ms: 120,
          outcome: "success",
          references: {
            mcp_authorization_id: "mca_123456789012345678901",
            send_id: null,
            whatsapp_connection_id: "con_123456789012345678901",
          },
          started_at: "2026-08-01T12:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(
      /message|phone|credential|token|payload|provider/iu,
    );
    expect(harness.telemetry).toEqual([
      {
        event: "tool_call_log.review.completed",
        logCount: 1,
        service: "api",
      },
    ]);
  });

  test("does not disclose invalid identities, origins, or persistence failures", async () => {
    expect((await makeHandler().handler(request("Bearer other"))).status).toBe(
      404,
    );
    expect(
      (
        await makeHandler().handler(
          request("Bearer owner", "https://evil.test"),
        )
      ).status,
    ).toBe(404);
    expect(
      (await makeHandler({ unavailable: true }).handler(request())).status,
    ).toBe(503);
    expect(
      (
        await makeHandler().handler(
          new Request(
            "https://api.example.test/v1/tool-call-logs?cursor=not-a-cursor",
            {
              headers: { authorization: "Bearer owner", origin: browserOrigin },
            },
          ),
        )
      ).status,
    ).toBe(400);
  });

  test("accepts only opaque public cursors for bounded pages", async () => {
    const cursor = "tcl_123456789012345678901";
    const harness = makeHandler({ nextCursor: cursor });
    const first = await harness.handler(request());
    const firstBody = (await first.json()) as {
      readonly next_cursor?: unknown;
    };
    expect(firstBody.next_cursor).toBe(cursor);
    const next = await harness.handler(
      new Request(
        `https://api.example.test/v1/tool-call-logs?cursor=${cursor}`,
        { headers: { authorization: "Bearer owner", origin: browserOrigin } },
      ),
    );
    expect(next.status).toBe(200);
    expect(harness.cursors).toEqual([null, cursor]);
  });
});
