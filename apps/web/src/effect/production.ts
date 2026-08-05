import { Config, ConfigProvider, Data, Effect, Layer } from "effect";
import { parseApiOrigin } from "./api-origin";
import { createHealthRoute } from "./canary";
import { CLERK_JWT_TEMPLATE, isClerkPublishableKey } from "./clerk-config";
import {
  ApplicationConfig,
  type HttpCompletedEvent,
  SafeTelemetry,
} from "./services";

export interface WebEnvironment {
  readonly DEPLOYMENT_ENVIRONMENT?: string | undefined;
  readonly NEXT_PUBLIC_API_ORIGIN?: string | undefined;
  readonly NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?: string | undefined;
  readonly NEXT_PUBLIC_WEB_ORIGIN?: string | undefined;
}

const productionConfig = Config.all({
  apiOrigin: Config.string("NEXT_PUBLIC_API_ORIGIN"),
  clerkPublishableKey: Config.string("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY").pipe(
    Config.validate({
      message: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is invalid",
      validation: isClerkPublishableKey,
    }),
  ),
  environment: Config.literal(
    "development",
    "preview",
    "production",
  )("DEPLOYMENT_ENVIRONMENT"),
  webOrigin: Config.string("NEXT_PUBLIC_WEB_ORIGIN"),
});

class InvalidApiOrigin extends Data.TaggedError("InvalidApiOrigin") {}

const validatedApiOrigin = (
  value: string,
): Effect.Effect<URL, InvalidApiOrigin> => {
  const url = parseApiOrigin(value);
  return url === null
    ? Effect.fail(new InvalidApiOrigin())
    : Effect.succeed(url);
};

const configLayer = (environment: WebEnvironment) =>
  Layer.effect(
    ApplicationConfig,
    productionConfig.pipe(
      Effect.flatMap(
        ({ apiOrigin, clerkPublishableKey, environment, webOrigin }) =>
          Effect.all([
            validatedApiOrigin(apiOrigin),
            validatedApiOrigin(webOrigin),
          ]).pipe(
            Effect.map(([validatedApiOrigin]) => ({
              apiOrigin: validatedApiOrigin,
              clerkJwtTemplate: CLERK_JWT_TEMPLATE,
              clerkPublishableKey,
              environment,
              service: "web" as const,
            })),
          ),
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
    Effect.sync(() => console.info(JSON.stringify(event))).pipe(
      Effect.withSpan("telemetry.emit"),
    ),
});

const unavailable = (): Response =>
  new Response(JSON.stringify({ service: "web", status: "unavailable" }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status: 503,
  });

export const createProductionHealthRoute = (environment: WebEnvironment) => {
  const route = createHealthRoute(
    Layer.merge(configLayer(environment), telemetryLayer),
  );

  return async (): Promise<Response> => {
    try {
      return await route();
    } catch {
      console.error(
        JSON.stringify({
          event: "configuration.invalid",
          service: "web",
        }),
      );
      return unavailable();
    }
  };
};
