import type { HealthResponse } from "@whatsapp-mcp/contracts/health";
import { Effect, type Layer } from "effect";
import {
  ApplicationConfig,
  type HttpCompletedEvent,
  SafeTelemetry,
} from "./services";

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });

const canaryProgram = (request: Request) =>
  Effect.gen(function* () {
    const config = yield* ApplicationConfig;
    const telemetry = yield* SafeTelemetry;
    const path = new URL(request.url).pathname;

    const response =
      request.method === "GET" && path === "/health"
        ? jsonResponse(
            {
              service: "provider-control",
              status: "ok",
            } satisfies HealthResponse,
            200,
          )
        : jsonResponse({ error: "not_found" }, 404);

    const event: HttpCompletedEvent = {
      event: "http.request.completed",
      method: request.method,
      route:
        request.method === "GET" && path === "/health" ? "health" : "unmatched",
      service: config.service,
      status: response.status,
    };
    yield* telemetry.emit(event);

    return response;
  });

export const createCanaryHandler =
  (layer: Layer.Layer<ApplicationConfig | SafeTelemetry, unknown>) =>
  (request: Request): Promise<Response> =>
    Effect.runPromise(canaryProgram(request).pipe(Effect.provide(layer)));
