import type {
  HealthResponse,
  ReadinessResponse,
} from "@whatsapp-mcp/contracts/health";
import { Effect, type Layer } from "effect";
import {
  ApplicationConfig,
  DatabaseReadiness,
  type HttpCompletedEvent,
  SafeTelemetry,
} from "./services";

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    headers: jsonHeaders,
    status,
  });

const canaryProgram = (request: Request) =>
  Effect.gen(function* () {
    const config = yield* ApplicationConfig;
    const database = yield* DatabaseReadiness;
    const telemetry = yield* SafeTelemetry;
    const path = new URL(request.url).pathname;
    const isHealth = request.method === "GET" && path === "/health";
    const isReady = request.method === "GET" && path === "/ready";

    if (!isHealth) {
      yield* database.check;
    }

    const response = isHealth
      ? jsonResponse(
          {
            service: "api",
            status: "ok",
          } satisfies HealthResponse,
          200,
        )
      : isReady
        ? jsonResponse(
            {
              service: "api",
              status: "ready",
            } satisfies ReadinessResponse,
            200,
          )
        : jsonResponse({ error: "not_found" }, 404);

    const event: HttpCompletedEvent = {
      event: "http.request.completed",
      method: request.method,
      route: isHealth ? "health" : isReady ? "ready" : "unmatched",
      service: config.service,
      status: response.status,
    };
    yield* telemetry.emit(event);

    return response;
  });

export const createCanaryHandler =
  (
    layer: Layer.Layer<
      ApplicationConfig | DatabaseReadiness | SafeTelemetry,
      unknown
    >,
  ) =>
  (request: Request): Promise<Response> =>
    Effect.runPromise(canaryProgram(request).pipe(Effect.provide(layer)));
