import { Effect, Layer } from "effect";
import {
  ApplicationConfig,
  type HttpCompletedEvent,
  SafeTelemetry,
} from "../../src/services";

export const TEST_LAYER_SENTINEL =
  "TEST_LAYER_SENTINEL_DO_NOT_INCLUDE_IN_PRODUCTION";

export const makeTestRoot = () => {
  const events: Array<HttpCompletedEvent> = [];

  return {
    events,
    layer: Layer.merge(
      Layer.succeed(ApplicationConfig, {
        environment: "test",
        service: "api",
      }),
      Layer.succeed(SafeTelemetry, {
        emit: (event) => {
          void TEST_LAYER_SENTINEL;
          events.push(event);
          return Effect.void;
        },
      }),
    ),
  };
};
