import { Effect, Layer } from "effect";
import {
  ApplicationConfig,
  DatabaseReadiness,
  type HttpCompletedEvent,
  SafeTelemetry,
} from "../../src/services";

export const TEST_LAYER_SENTINEL =
  "TEST_LAYER_SENTINEL_DO_NOT_INCLUDE_IN_PRODUCTION";

export const makeTestRoot = () => {
  const databaseChecks = { count: 0 };
  const events: Array<HttpCompletedEvent> = [];

  return {
    get databaseChecks() {
      return databaseChecks.count;
    },
    events,
    layer: Layer.mergeAll(
      Layer.succeed(ApplicationConfig, {
        environment: "test",
        service: "api",
      }),
      Layer.succeed(DatabaseReadiness, {
        check: Effect.sync(() => {
          databaseChecks.count += 1;
        }),
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
