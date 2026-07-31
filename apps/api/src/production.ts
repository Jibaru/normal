import { KMSClient } from "@aws-sdk/client-kms";
import { checkDatabaseReadiness } from "@whatsapp-mcp/db/connectivity";
import { Config, ConfigProvider, Data, Effect, Layer, Redacted } from "effect";
import { createCanaryHandler } from "./canary";
import {
  type DeletionCapsuleWriteBucket,
  makeDeletionCapsuleWriter,
} from "./deletion/capsule";
import {
  type DeletionMarkerBucket,
  makeDeletionMarkerStore,
} from "./deletion/marker";
import {
  makeAwsDeletionCapsuleKmsWriter,
  makeAwsKmsKeyService,
} from "./encryption/aws-kms";
import {
  EnvelopeEncryptionService,
  makeEnvelopeEncryption,
} from "./encryption/envelope";
import {
  ApplicationConfig,
  DatabaseReadiness,
  type HttpCompletedEvent,
  RestoreSafeDeletion,
  SafeTelemetry,
} from "./services";

export interface ApiEnvironment {
  readonly AWS_ACCESS_KEY_ID?: string | undefined;
  readonly AWS_KMS_REGION?: string | undefined;
  readonly AWS_SECRET_ACCESS_KEY?: string | undefined;
  readonly AWS_SESSION_TOKEN?: string | undefined;
  readonly DELETION_CAPSULES?: unknown;
  readonly DELETION_MARKER_HMAC_SECRET?: string | undefined;
  readonly DELETION_MARKERS?: unknown;
  readonly DEPLOYMENT_ENVIRONMENT?: string | undefined;
  readonly HYPERDRIVE?:
    | {
        readonly connectionString: string;
      }
    | undefined;
  readonly KMS_CONTENT_ROOT_KEY_ARN?: string | undefined;
  readonly KMS_DELETION_COORDINATOR_KEY_ARN?: string | undefined;
  readonly INGESTION_QUEUE?: unknown;
  readonly OAUTH_KV?: unknown;
  readonly PROVIDER_CONTROL?:
    | {
        readonly fetch: (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => Promise<Response>;
      }
    | undefined;
  readonly STORED_MEDIA?: unknown;
  readonly WEBHOOK_INGRESS?: unknown;
}

const productionConfig = Config.all({
  environment: Config.literal(
    "development",
    "preview",
    "production",
  )("DEPLOYMENT_ENVIRONMENT"),
});

const contentRootKeyArn = Config.string("KMS_CONTENT_ROOT_KEY_ARN").pipe(
  Config.validate({
    message: "KMS_CONTENT_ROOT_KEY_ARN must identify a KMS key in us-east-1",
    validation: (value) =>
      /^arn:aws(?:-[a-z]+)?:kms:us-east-1:[0-9]{12}:key\/[A-Za-z0-9-]+$/.test(
        value,
      ),
  }),
);

const deletionCoordinatorKeyArn = Config.string(
  "KMS_DELETION_COORDINATOR_KEY_ARN",
).pipe(
  Config.validate({
    message:
      "KMS_DELETION_COORDINATOR_KEY_ARN must identify a KMS key in us-east-1",
    validation: (value) =>
      /^arn:aws(?:-[a-z]+)?:kms:us-east-1:[0-9]{12}:key\/[A-Za-z0-9-]+$/.test(
        value,
      ),
  }),
);

const deletionMarkerHmacSecret = Config.redacted(
  "DELETION_MARKER_HMAC_SECRET",
).pipe(
  Config.validate({
    message: "DELETION_MARKER_HMAC_SECRET must be a 32-byte hex secret",
    validation: (value) => /^[a-f0-9]{64}$/iu.test(Redacted.value(value)),
  }),
);

const kmsConfig = Config.all({
  accessKeyId: Config.redacted("AWS_ACCESS_KEY_ID"),
  contentRootKeyArn,
  deletionCoordinatorKeyArn,
  region: Config.literal("us-east-1")("AWS_KMS_REGION"),
  secretAccessKey: Config.redacted("AWS_SECRET_ACCESS_KEY"),
  sessionToken: Config.redacted("AWS_SESSION_TOKEN"),
}).pipe(
  Config.validate({
    message: "Content and Deletion Capsule KMS keys must be distinct",
    validation: (config) =>
      config.contentRootKeyArn !== config.deletionCoordinatorKeyArn,
  }),
);

class MissingProviderControlBinding extends Data.TaggedError(
  "MissingProviderControlBinding",
) {}

class MissingCloudflareBinding extends Data.TaggedError(
  "MissingCloudflareBinding",
)<{ readonly binding: string }> {}

const hasMethods = (
  value: unknown,
  methods: ReadonlyArray<string>,
): value is Record<
  string,
  (...arguments_: ReadonlyArray<unknown>) => unknown
> =>
  typeof value === "object" &&
  value !== null &&
  methods.every(
    (method) =>
      typeof (value as Record<string, unknown>)[method] === "function",
  );

const validateCloudflareBindings = (
  environment: ApiEnvironment,
): Effect.Effect<void, MissingCloudflareBinding> => {
  const bindings = [
    ["DELETION_CAPSULES", environment.DELETION_CAPSULES, ["get", "put"]],
    ["DELETION_MARKERS", environment.DELETION_MARKERS, ["get", "list", "put"]],
    ["INGESTION_QUEUE", environment.INGESTION_QUEUE, ["send"]],
    ["OAUTH_KV", environment.OAUTH_KV, ["delete", "get", "put"]],
    ["STORED_MEDIA", environment.STORED_MEDIA, ["delete", "get", "put"]],
    ["WEBHOOK_INGRESS", environment.WEBHOOK_INGRESS, ["delete", "get", "put"]],
  ] as const;

  for (const [binding, value, methods] of bindings) {
    if (!hasMethods(value, methods)) {
      return Effect.fail(new MissingCloudflareBinding({ binding }));
    }
  }

  return Effect.void;
};

const environmentConfigProvider = (environment: ApiEnvironment) =>
  ConfigProvider.fromMap(
    new Map(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );

const configLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    ApplicationConfig,
    productionConfig.pipe(
      Effect.flatMap((config) =>
        Effect.gen(function* () {
          if (typeof environment.PROVIDER_CONTROL?.fetch !== "function") {
            return yield* Effect.fail(new MissingProviderControlBinding());
          }
          yield* validateCloudflareBindings(environment);
          return {
            ...config,
            service: "api" as const,
          };
        }),
      ),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

const encryptionLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    EnvelopeEncryptionService,
    Config.all({
      application: productionConfig,
      kms: kmsConfig,
    }).pipe(
      Effect.map(({ application, kms }) => {
        const client = new KMSClient({
          credentials: {
            accessKeyId: Redacted.value(kms.accessKeyId),
            secretAccessKey: Redacted.value(kms.secretAccessKey),
            sessionToken: Redacted.value(kms.sessionToken),
          },
          region: kms.region,
        });
        return makeEnvelopeEncryption({
          contentRootKeyId: kms.contentRootKeyArn,
          environment: application.environment,
          kms: makeAwsKmsKeyService(client),
        });
      }),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

const deletionLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    RestoreSafeDeletion,
    Config.all({
      application: productionConfig,
      hmacSecret: deletionMarkerHmacSecret,
      kms: kmsConfig,
    }).pipe(
      Effect.map(({ application, hmacSecret, kms }) => {
        const client = new KMSClient({
          credentials: {
            accessKeyId: Redacted.value(kms.accessKeyId),
            secretAccessKey: Redacted.value(kms.secretAccessKey),
            sessionToken: Redacted.value(kms.sessionToken),
          },
          region: kms.region,
        });
        return {
          capsules: makeDeletionCapsuleWriter({
            bucket: environment.DELETION_CAPSULES as DeletionCapsuleWriteBucket,
            environment: application.environment,
            keyId: kms.deletionCoordinatorKeyArn,
            kmsWriter: makeAwsDeletionCapsuleKmsWriter(client),
          }),
          markers: makeDeletionMarkerStore({
            bucket: environment.DELETION_MARKERS as DeletionMarkerBucket,
            environment: application.environment,
            hmacSecret,
          }),
        };
      }),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
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
      encryptionLayer(environment),
      deletionLayer(environment),
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
