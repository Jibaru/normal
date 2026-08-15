import type { ActivityLogSummary } from "@whatsapp-mcp/db/activity-log";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  ActivityLogClock,
  ActivityLogPersistence,
  ActivityLogPersistenceError,
  createActivityLogHandler,
} from "../src/activity-log";
import {
  HumanIdentity,
  InvalidHumanIdentity,
} from "../src/auth/human-identity";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const browserOrigin = "https://app.example.test";
const safeLog: ActivityLogSummary = {
  apiKeyId: null,
  authorizationId: "mca_123456789012345678901",
  channel: "mcp",
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
    Layer.succeed(ActivityLogClock, {
      now: Effect.succeed(new Date("2026-08-01T12:01:00.000Z")),
    }),
    Layer.succeed(ActivityLogPersistence, {
      list: (clerkUserId, _observedAt, cursor) => {
        cursors.push(cursor);
        return options.unavailable
          ? Effect.fail(new ActivityLogPersistenceError())
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
    handler: createActivityLogHandler(layer, browserOrigin),
    telemetry,
  };
};

const request = (authorization = "Bearer owner", origin = browserOrigin) =>
  new Request("https://api.example.test/v1/activity-logs", {
    headers: { authorization, origin },
  });

describe("Activity Log product boundary", () => {
  test("returns only the safe metadata allowlist", async () => {
    const harness = makeHandler();
    const response = await harness.handler(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      next_cursor: null,
      activity_logs: [
        {
          capability: "list_connections",
          channel: "mcp",
          client: { id: "approved-client", name: "Approved MCP Client" },
          completed_at: "2026-08-01T12:00:00.120Z",
          counts: { media_bytes: 0, results: 2 },
          error_code: null,
          latency_ms: 120,
          outcome: "success",
          references: {
            api_key_id: null,
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
        event: "activity_log.review.completed",
        logCount: 1,
        service: "api",
      },
    ]);
  });

  test("presents API-channel Activity Logs with allowlisted key identity", async () => {
    const apiLog: ActivityLogSummary = {
      ...safeLog,
      apiKeyId: "apk_123456789012345678901",
      authorizationId: null,
      channel: "api",
      clientId: "apk_123456789012345678901",
      clientName: "Billing automation",
    };
    const layer = Layer.mergeAll(
      Layer.succeed(HumanIdentity, {
        verify: () => Effect.succeed("user_owner"),
        verifyRecently: () => Effect.die("not used"),
      }),
      Layer.succeed(ActivityLogClock, {
        now: Effect.succeed(new Date("2026-08-01T12:01:00.000Z")),
      }),
      Layer.succeed(ActivityLogPersistence, {
        list: () =>
          Effect.succeed({
            logs: [apiLog],
            nextCursor: null,
          }),
      }),
      Layer.succeed(SafeTelemetry, {
        emit: () => Effect.void,
      }),
    );
    const response = await createActivityLogHandler(
      layer,
      browserOrigin,
    )(request());
    const body = await response.json();
    expect(body).toEqual({
      next_cursor: null,
      activity_logs: [
        {
          capability: "list_connections",
          channel: "api",
          client: {
            id: "apk_123456789012345678901",
            name: "Billing automation",
          },
          completed_at: "2026-08-01T12:00:00.120Z",
          counts: { media_bytes: 0, results: 2 },
          error_code: null,
          latency_ms: 120,
          outcome: "success",
          references: {
            api_key_id: "apk_123456789012345678901",
            mcp_authorization_id: null,
            send_id: null,
            whatsapp_connection_id: "con_123456789012345678901",
          },
          started_at: "2026-08-01T12:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(
      /normal_|digest|credential|phone|payload|tenant/iu,
    );
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
            "https://api.example.test/v1/activity-logs?cursor=not-a-cursor",
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
        `https://api.example.test/v1/activity-logs?cursor=${cursor}`,
        { headers: { authorization: "Bearer owner", origin: browserOrigin } },
      ),
    );
    expect(next.status).toBe(200);
    expect(harness.cursors).toEqual([null, cursor]);
  });
});
