import type { MessageRetentionPolicy } from "@whatsapp-mcp/db/message-retention";
import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const routePattern =
  /^\/v1\/whatsapp-connections\/(con_[A-Za-z0-9_-]{21})\/retention-policy$/u;

export class MessageRetentionPersistenceError extends Data.TaggedError(
  "MessageRetentionPersistenceError",
) {}

export interface MessageRetentionPersistenceService {
  readonly get: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
  }) => Effect.Effect<
    MessageRetentionPolicy | null,
    MessageRetentionPersistenceError
  >;
  readonly update: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
    readonly days: number | null;
    readonly expectedDays: number | null;
    readonly updatedAt: string;
  }) => Effect.Effect<
    MessageRetentionPolicy | null,
    MessageRetentionPersistenceError
  >;
}

export const MessageRetentionPersistence =
  Context.GenericTag<MessageRetentionPersistenceService>(
    "@whatsapp-mcp/api/MessageRetentionPersistence",
  );

export interface MessageRetentionClockService {
  readonly now: Effect.Effect<string>;
}
export const MessageRetentionClock =
  Context.GenericTag<MessageRetentionClockService>(
    "@whatsapp-mcp/api/MessageRetentionClock",
  );

type Requirements =
  | HumanIdentityService
  | MessageRetentionClockService
  | MessageRetentionPersistenceService
  | SafeTelemetryService;

const headers = (origin: string): HeadersInit => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,OPTIONS,PUT",
  "access-control-allow-origin": origin,
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  vary: "Origin",
});
const json = (body: unknown, status: number, origin: string) =>
  new Response(JSON.stringify(body), { headers: headers(origin), status });
const policyJson = (policy: MessageRetentionPolicy) => ({
  days: policy.days,
  updated_at: policy.updatedAt,
});

export const createMessageRetentionHandler =
  (
    layer: Layer.Layer<Requirements, unknown>,
    browserOrigin: string,
    allowedDays: ReadonlyArray<number>,
  ) =>
  async (request: Request): Promise<Response> => {
    const match = routePattern.exec(new URL(request.url).pathname);
    if (match === null || request.headers.get("origin") !== browserOrigin) {
      return json({ error: "not_found" }, 404, browserOrigin);
    }
    if (request.method === "OPTIONS")
      return new Response(null, {
        headers: headers(browserOrigin),
        status: 204,
      });
    if (request.method !== "GET" && request.method !== "PUT")
      return json({ error: "not_found" }, 404, browserOrigin);
    const connectionPublicId = match[1];
    if (connectionPublicId === undefined)
      return json({ error: "not_found" }, 404, browserOrigin);

    let update: {
      days: number | null;
      expectedDays: number | null;
    } | null = null;
    if (request.method === "PUT") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_request" }, 400, browserOrigin);
      }
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        !("days" in body) ||
        !("expected_days" in body)
      ) {
        return json({ error: "invalid_request" }, 400, browserOrigin);
      }
      const candidate = body as Record<string, unknown>;
      const days = candidate.days;
      const expectedDays = candidate.expected_days;
      if (
        (days !== null &&
          (typeof days !== "number" || !allowedDays.includes(days))) ||
        (expectedDays !== null &&
          (typeof expectedDays !== "number" ||
            !allowedDays.includes(expectedDays)))
      ) {
        return json({ error: "invalid_request" }, 400, browserOrigin);
      }
      const broadens =
        days === null || (expectedDays !== null && days > expectedDays);
      if (broadens && candidate.acknowledge_extension !== true) {
        return json(
          { error: "extension_not_acknowledged" },
          400,
          browserOrigin,
        );
      }
      update = {
        days,
        expectedDays,
      };
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* HumanIdentity;
        const clerkUserId = yield* identity.verify(request);
        const persistence = yield* MessageRetentionPersistence;
        if (update === null) {
          const policy = yield* persistence.get({
            clerkUserId,
            connectionPublicId,
          });
          return policy === null ? null : { policy, operation: "get" as const };
        }
        const clock = yield* MessageRetentionClock;
        const policy = yield* persistence.update({
          clerkUserId,
          connectionPublicId,
          days: update.days,
          expectedDays: update.expectedDays,
          updatedAt: yield* clock.now,
        });
        const telemetry = yield* SafeTelemetry;
        yield* telemetry.emit({
          event: "message_retention.policy_update.completed",
          outcome: policy === null ? "conflict_or_not_found" : "success",
          service: "api",
        });
        return policy === null
          ? null
          : { policy, operation: "update" as const };
      }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            typeof failure === "object" &&
            failure !== null &&
            "_tag" in failure &&
            failure._tag === "InvalidHumanIdentity"
              ? json({ error: "not_found" }, 404, browserOrigin)
              : json({ error: "unavailable" }, 503, browserOrigin),
          onSuccess: (result) =>
            result === null
              ? json(
                  {
                    error:
                      request.method === "PUT"
                        ? "policy_conflict"
                        : "not_found",
                  },
                  request.method === "PUT" ? 409 : 404,
                  browserOrigin,
                )
              : json(
                  {
                    allowed_days: allowedDays,
                    policy: policyJson(result.policy),
                  },
                  200,
                  browserOrigin,
                ),
        }),
      ),
    );
  };

export const isMessageRetentionRequest = (request: Request): boolean =>
  routePattern.test(new URL(request.url).pathname);
