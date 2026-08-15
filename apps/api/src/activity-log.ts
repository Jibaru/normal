import type { ActivityLogPage } from "@whatsapp-mcp/db/activity-log";
import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import { hasFailureTag } from "./failure-tag";
import { noStoreJsonResponse } from "./http-response";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const ACTIVITY_LOGS_PATH = "/v1/activity-logs";

export class ActivityLogPersistenceError extends Data.TaggedError(
  "ActivityLogPersistenceError",
) {}

export interface ActivityLogPersistenceService {
  readonly list: (
    clerkUserId: string,
    observedAt: Date,
    cursor: string | null,
  ) => Effect.Effect<ActivityLogPage | null, ActivityLogPersistenceError>;
}

export const ActivityLogPersistence =
  Context.GenericTag<ActivityLogPersistenceService>(
    "@whatsapp-mcp/api/ActivityLogPersistence",
  );

export interface ActivityLogClockService {
  readonly now: Effect.Effect<Date>;
}

export const ActivityLogClock = Context.GenericTag<ActivityLogClockService>(
  "@whatsapp-mcp/api/ActivityLogClock",
);

type ActivityLogRequirements =
  | HumanIdentityService
  | SafeTelemetryService
  | ActivityLogClockService
  | ActivityLogPersistenceService;

const corsHeaders = (browserOrigin: string) => ({
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
  noStoreJsonResponse(
    body,
    status,
    browserOrigin === undefined ? {} : corsHeaders(browserOrigin),
  );

const notFound = (browserOrigin?: string): Response =>
  jsonResponse({ error: "not_found" }, 404, browserOrigin);

export const createActivityLogHandler =
  (
    layer: Layer.Layer<ActivityLogRequirements, unknown>,
    browserOrigin: string,
  ) =>
  (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      path !== ACTIVITY_LOGS_PATH ||
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
    const cursor = url.searchParams.get("cursor");
    if (
      [...url.searchParams.keys()].some((key) => key !== "cursor") ||
      url.searchParams.getAll("cursor").length > 1 ||
      (cursor !== null && !/^tcl_[A-Za-z0-9_-]{21}$/u.test(cursor))
    ) {
      return Promise.resolve(
        jsonResponse({ error: "invalid_cursor" }, 400, browserOrigin),
      );
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* HumanIdentity;
        const clerkUserId = yield* identity.verify(request);
        const clock = yield* ActivityLogClock;
        const persistence = yield* ActivityLogPersistence;
        const page = yield* persistence.list(
          clerkUserId,
          yield* clock.now,
          cursor,
        );
        if (page === null)
          return yield* Effect.fail(new InvalidActivityLogOwner());
        const telemetry = yield* SafeTelemetry;
        yield* telemetry.emit({
          event: "activity_log.review.completed",
          logCount: page.logs.length,
          service: "api",
        });
        return page;
      }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            hasFailureTag(
              failure,
              "InvalidHumanIdentity",
              "InvalidActivityLogOwner",
            )
              ? notFound(browserOrigin)
              : jsonResponse({ error: "unavailable" }, 503, browserOrigin),
          onSuccess: (page) =>
            jsonResponse(
              {
                next_cursor: page.nextCursor,
                activity_logs: page.logs.map((log) => ({
                  capability: log.toolName,
                  channel: log.channel,
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
                    api_key_id: log.apiKeyId,
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

class InvalidActivityLogOwner extends Data.TaggedError(
  "InvalidActivityLogOwner",
) {}

export const isActivityLogRequest = (request: Request): boolean =>
  new URL(request.url).pathname === ACTIVITY_LOGS_PATH;
