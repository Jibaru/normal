import type { ToolCallLogSummary } from "@whatsapp-mcp/db/tool-call-log";
import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const TOOL_CALL_LOGS_PATH = "/v1/tool-call-logs";

export class ToolCallLogPersistenceError extends Data.TaggedError(
  "ToolCallLogPersistenceError",
) {}

export interface ToolCallLogPersistenceService {
  readonly list: (
    clerkUserId: string,
    observedAt: Date,
  ) => Effect.Effect<
    ReadonlyArray<ToolCallLogSummary> | null,
    ToolCallLogPersistenceError
  >;
}

export const ToolCallLogPersistence =
  Context.GenericTag<ToolCallLogPersistenceService>(
    "@whatsapp-mcp/api/ToolCallLogPersistence",
  );

export interface ToolCallLogClockService {
  readonly now: Effect.Effect<Date>;
}

export const ToolCallLogClock = Context.GenericTag<ToolCallLogClockService>(
  "@whatsapp-mcp/api/ToolCallLogClock",
);

type ToolCallLogRequirements =
  | HumanIdentityService
  | SafeTelemetryService
  | ToolCallLogClockService
  | ToolCallLogPersistenceService;

const corsHeaders = (browserOrigin: string): HeadersInit => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-origin": browserOrigin,
  vary: "Origin",
});

const jsonResponse = (
  body: unknown,
  status: number,
  browserOrigin?: string,
): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      ...(browserOrigin === undefined ? {} : corsHeaders(browserOrigin)),
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });

const notFound = (browserOrigin?: string): Response =>
  jsonResponse({ error: "not_found" }, 404, browserOrigin);

export const createToolCallLogHandler =
  (
    layer: Layer.Layer<ToolCallLogRequirements, unknown>,
    browserOrigin: string,
  ) =>
  (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (
      path !== TOOL_CALL_LOGS_PATH ||
      request.headers.get("origin") !== browserOrigin
    ) {
      return Promise.resolve(notFound());
    }
    if (request.method === "OPTIONS") {
      return Promise.resolve(
        new Response(null, {
          headers: corsHeaders(browserOrigin),
          status: 204,
        }),
      );
    }
    if (request.method !== "GET") {
      return Promise.resolve(notFound(browserOrigin));
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* HumanIdentity;
        const clerkUserId = yield* identity.verify(request);
        const clock = yield* ToolCallLogClock;
        const persistence = yield* ToolCallLogPersistence;
        const logs = yield* persistence.list(clerkUserId, yield* clock.now);
        if (logs === null)
          return yield* Effect.fail(new InvalidToolCallLogOwner());
        const telemetry = yield* SafeTelemetry;
        yield* telemetry.emit({
          event: "tool_call_log.review.completed",
          logCount: logs.length,
          service: "api",
        });
        return logs;
      }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            typeof failure === "object" &&
            failure !== null &&
            "_tag" in failure &&
            (failure._tag === "InvalidHumanIdentity" ||
              failure._tag === "InvalidToolCallLogOwner")
              ? notFound(browserOrigin)
              : jsonResponse({ error: "unavailable" }, 503, browserOrigin),
          onSuccess: (logs) =>
            jsonResponse(
              {
                tool_call_logs: logs.map((log) => ({
                  capability: log.toolName,
                  client: { id: log.clientId, name: log.clientName },
                  completed_at: log.completedAt?.toISOString() ?? null,
                  counts: {
                    media_bytes: log.mediaBytes,
                    results: log.resultCount,
                  },
                  error_code: log.errorCode,
                  latency_ms: log.latencyMs,
                  outcome: log.outcome,
                  references: {
                    mcp_authorization_id: log.authorizationId,
                    whatsapp_connection_id: log.connectionId,
                    send_id: log.sendId,
                  },
                  started_at: log.startedAt.toISOString(),
                })),
              },
              200,
              browserOrigin,
            ),
        }),
      ),
    );
  };

class InvalidToolCallLogOwner extends Data.TaggedError(
  "InvalidToolCallLogOwner",
) {}

export const isToolCallLogRequest = (request: Request): boolean =>
  new URL(request.url).pathname === TOOL_CALL_LOGS_PATH;
