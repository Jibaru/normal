import type { HealthResponse } from "@whatsapp-mcp/contracts/health";
import { Effect, type Layer } from "effect";
import {
  ApplicationConfig,
  type HttpCompletedEvent,
  SafeTelemetry,
} from "./services";

const canaryProgram = Effect.gen(function* () {
  const config = yield* ApplicationConfig;
  const telemetry = yield* SafeTelemetry;
  const body = {
    service: "web",
    status: "ok",
  } satisfies HealthResponse;
  const response = new Response(JSON.stringify(body), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status: 200,
  });
  const event: HttpCompletedEvent = {
    event: "http.request.completed",
    method: "GET",
    route: "health",
    service: config.service,
    status: response.status,
  };
  yield* telemetry.emit(event);
  return response;
});

export const createHealthRoute =
  (layer: Layer.Layer<ApplicationConfig | SafeTelemetry, unknown>) =>
  (): Promise<Response> =>
    Effect.runPromise(canaryProgram.pipe(Effect.provide(layer)));
