import { Config, ConfigProvider, Effect, Layer } from "effect";
import { createCanaryHandler } from "./canary";
import {
  ApplicationConfig,
  type HttpCompletedEvent,
  SafeTelemetry,
} from "./services";

export interface ProviderControlEnvironment {
  readonly DEPLOYMENT_ENVIRONMENT?: string | undefined;
}

const productionConfig = Config.all({
  environment: Config.literal(
    "development",
    "preview",
    "production",
  )("DEPLOYMENT_ENVIRONMENT"),
});

const configLayer = (environment: ProviderControlEnvironment) =>
  Layer.effect(
    ApplicationConfig,
    productionConfig.pipe(
      Effect.map((config) => ({
        ...config,
        service: "provider-control" as const,
      })),
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map(
            Object.entries(environment).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
        ),
      ),
    ),
  );

const telemetryLayer = Layer.succeed(SafeTelemetry, {
  emit: (event: HttpCompletedEvent) =>
    Effect.sync(() => console.info(JSON.stringify(event))),
});

const unavailable = (): Response =>
  new Response(
    JSON.stringify({
      service: "provider-control",
      status: "unavailable",
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
      status: 503,
    },
  );

export const createProductionHandler = (
  environment: ProviderControlEnvironment,
) => {
  const handler = createCanaryHandler(
    Layer.merge(configLayer(environment), telemetryLayer),
  );

  return async (request: Request): Promise<Response> => {
    try {
      return await handler(request);
    } catch {
      console.error(
        JSON.stringify({
          event: "configuration.invalid",
          service: "provider-control",
        }),
      );
      return unavailable();
    }
  };
};
