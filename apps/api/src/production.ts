import { checkDatabaseReadiness } from "@whatsapp-mcp/db/connectivity";
import { Config, ConfigProvider, Data, Effect, Layer } from "effect";
import { createCanaryHandler } from "./canary";
import {
  ApplicationConfig,
  DatabaseReadiness,
  type HttpCompletedEvent,
  SafeTelemetry,
} from "./services";

export interface ApiEnvironment {
  readonly DEPLOYMENT_ENVIRONMENT?: string | undefined;
  readonly HYPERDRIVE?:
    | {
        readonly connectionString: string;
      }
    | undefined;
  readonly PROVIDER_CONTROL?:
    | {
        readonly fetch: (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => Promise<Response>;
      }
    | undefined;
}

const productionConfig = Config.all({
  environment: Config.literal(
    "development",
    "preview",
    "production",
  )("DEPLOYMENT_ENVIRONMENT"),
});

class MissingProviderControlBinding extends Data.TaggedError(
  "MissingProviderControlBinding",
) {}

const configLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    ApplicationConfig,
    productionConfig.pipe(
      Effect.flatMap((config) =>
        typeof environment.PROVIDER_CONTROL?.fetch === "function"
          ? Effect.succeed({
              ...config,
              service: "api" as const,
            })
          : Effect.fail(new MissingProviderControlBinding()),
      ),
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

class MissingHyperdriveBinding extends Data.TaggedError(
  "MissingHyperdriveBinding",
) {}

const databaseLayer = (environment: ApiEnvironment) =>
  Layer.succeed(DatabaseReadiness, {
    check:
      typeof environment.HYPERDRIVE?.connectionString === "string"
        ? Effect.tryPromise({
            try: () =>
              checkDatabaseReadiness(
                environment.HYPERDRIVE?.connectionString ?? "",
              ),
            catch: (cause) => cause,
          })
        : Effect.fail(new MissingHyperdriveBinding()),
  });

const unavailable = (): Response =>
  new Response(JSON.stringify({ service: "api", status: "unavailable" }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status: 503,
  });

export const createProductionHandler = (environment: ApiEnvironment) => {
  const handler = createCanaryHandler(
    Layer.mergeAll(
      configLayer(environment),
      databaseLayer(environment),
      telemetryLayer,
    ),
  );

  return async (request: Request): Promise<Response> => {
    try {
      return await handler(request);
    } catch {
      console.error(
        JSON.stringify({
          event: "request.unavailable",
          service: "api",
        }),
      );
      return unavailable();
    }
  };
};
