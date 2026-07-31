import { KMSClient } from "@aws-sdk/client-kms";
import {
  makeConnectionId,
  makeConnectionSetupId,
} from "@whatsapp-mcp/contracts/handles";
import type {
  ProviderControlFailure,
  ProviderControlService,
} from "@whatsapp-mcp/contracts/provider-control";
import { makePgConnectionSetupRepository } from "@whatsapp-mcp/db/connection-setup";
import { checkDatabaseReadiness } from "@whatsapp-mcp/db/connectivity";
import { makePgMcpAuthorizationRepository } from "@whatsapp-mcp/db/mcp-authorization";
import { makePgPersonalAccountRepository } from "@whatsapp-mcp/db/personal-account";
import { makePgWebhookIngressRepository } from "@whatsapp-mcp/db/webhook-ingress";
import { makePgWhatsAppConnectionRepository } from "@whatsapp-mcp/db/whatsapp-connection";
import { Config, ConfigProvider, Data, Effect, Layer, Redacted } from "effect";
import { makeClerkHumanIdentity } from "./auth/clerk";
import { HumanIdentity } from "./auth/human-identity";
import { createCanaryHandler } from "./canary";
import {
  ConnectionSetupClock,
  ConnectionSetupIdentifiers,
  ConnectionSetupNumberTokens,
  ConnectionSetupPersistence,
  ConnectionSetupPersistenceError,
  createConnectionSetupHandler,
  isConnectionSetupRequest,
  makeConnectionSetupNumberTokens,
} from "./connection-setup";
import {
  ConnectionSetupCleanupClock,
  ConnectionSetupCleanupIdentifiers,
  ConnectionSetupCleanupPersistence,
  ConnectionSetupCleanupPersistenceError,
  ConnectionSetupCleanupProvider,
  connectionSetupCleanupMessage,
  handleConnectionSetupCleanupBatch,
  isConnectionSetupCleanupMessage,
} from "./connection-setup-cleanup";
import {
  ConnectionSetupProvisioningClock,
  ConnectionSetupProvisioningIdentifiers,
  ConnectionSetupProvisioningPersistence,
  ConnectionSetupProvisioningPersistenceError,
  ConnectionSetupProvisioningProvider,
  ConnectionSetupProvisioningQueue,
  ConnectionSetupProvisioningQueueError,
  ConnectionSetupProvisioningWebhook,
  connectionSetupProvisioningMessage,
  handleConnectionSetupProvisioningBatch,
} from "./connection-setup-provisioning";
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
  makeStoredMediaContainer,
  StoredMediaContainerService,
} from "./encryption/stored-media-container";
import {
  createMcpAuthorizationConsentHandler,
  createMcpAuthorizationManagementHandler,
  isMcpAuthorizationConsentRequest,
  isMcpAuthorizationManagementRequest,
  McpAuthorizationClock,
  McpAuthorizationIdentifiers,
  McpAuthorizationPersistence,
  McpAuthorizationPersistenceError,
} from "./mcp-authorization";
import { createOAuthHandler, loadOAuthConfiguration } from "./oauth";
import {
  createPersonalAccountHandler,
  isPersonalAccountRequest,
  PersonalAccountIdentifiers,
  PersonalAccountPersistence,
  PersonalAccountPersistenceError,
  PrivateBetaConfig,
} from "./personal-account";
import {
  ApplicationConfig,
  DatabaseReadiness,
  RestoreSafeDeletion,
  SafeTelemetry,
  type SafeTelemetryEvent,
} from "./services";
import {
  createWebhookIngressHandler,
  isWebhookIngressRequest,
  WebhookIngressClock,
  WebhookIngressIdentifiers,
  WebhookIngressObjectStore,
  WebhookIngressObjectStoreError,
  WebhookIngressPersistence,
  WebhookIngressPersistenceError,
  WebhookIngressQueue,
  WebhookIngressQueueError,
} from "./webhook-ingress";
import {
  createWhatsAppConnectionHandler,
  isWhatsAppConnectionRequest,
  WhatsAppConnectionClock,
  WhatsAppConnectionIdentifiers,
  WhatsAppConnectionPersistence,
  WhatsAppConnectionPersistenceError,
  WhatsAppConnectionProvider,
} from "./whatsapp-connection";

export interface ApiEnvironment {
  readonly AWS_ACCESS_KEY_ID?: string | undefined;
  readonly AWS_KMS_REGION?: string | undefined;
  readonly AWS_SECRET_ACCESS_KEY?: string | undefined;
  readonly AWS_SESSION_TOKEN?: string | undefined;
  readonly CLERK_API_AUDIENCE?: string | undefined;
  readonly CLERK_AUTHORIZED_PARTY?: string | undefined;
  readonly CLERK_ISSUER?: string | undefined;
  readonly CLERK_JWT_KEY?: string | undefined;
  readonly DELETION_CAPSULES?: unknown;
  readonly DELETION_MARKER_HMAC_SECRET?: string | undefined;
  readonly DELETION_MARKERS?: unknown;
  readonly DEPLOYMENT_ENVIRONMENT?: string | undefined;
  readonly HYPERDRIVE?:
    | {
        readonly connectionString: string;
      }
    | undefined;
  readonly CONNECTION_SETUP_PROVISIONING_QUEUE?: unknown;
  readonly KMS_CONTENT_ROOT_KEY_ARN?: string | undefined;
  readonly KMS_DELETION_COORDINATOR_KEY_ARN?: string | undefined;
  readonly INGESTION_QUEUE?: unknown;
  readonly OAUTH_CLIENT_REGISTRY?: string | undefined;
  readonly OAUTH_ISSUER?: string | undefined;
  readonly OAUTH_KV?: unknown;
  readonly OAUTH_PROTOCOL_ENCRYPTION_KEY?: string | undefined;
  readonly OAUTH_RESOURCE?: string | undefined;
  readonly PROVIDER_APPROVED_SESSION_CAPACITY?: string | undefined;
  readonly PROVIDER_CONTROL?: unknown;
  readonly STORED_MEDIA?: unknown;
  readonly WEBHOOK_INGRESS?: unknown;
  readonly WEBHOOK_HYPERDRIVE?:
    | {
        readonly connectionString: string;
      }
    | undefined;
  readonly WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET?: string | undefined;
}

const productionConfig = Config.all({
  environment: Config.literal(
    "development",
    "preview",
    "production",
  )("DEPLOYMENT_ENVIRONMENT"),
});

const providerApprovedSessionCapacity = Config.integer(
  "PROVIDER_APPROVED_SESSION_CAPACITY",
).pipe(
  Config.validate({
    message:
      "PROVIDER_APPROVED_SESSION_CAPACITY must reserve at least one Personal Account entitlement",
    validation: (value) => Number.isSafeInteger(value) && value >= 3,
  }),
);

const isExactHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
};

const httpsOriginConfig = (name: string) =>
  Config.string(name).pipe(
    Config.validate({
      message: `${name} must be an exact HTTPS origin`,
      validation: isExactHttpsOrigin,
    }),
  );

const CLERK_RSA_SPKI_PREFIX = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA";
const CLERK_RSA_SPKI_SUFFIX = "IDAQAB";

class InvalidClerkJwtKey extends Data.TaggedError("InvalidClerkJwtKey") {}

const validateClerkJwtKey = (
  jwtKey: string,
): Effect.Effect<string, InvalidClerkJwtKey> =>
  Effect.tryPromise({
    try: async () => {
      const encoded = jwtKey
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace(/\s/g, "");
      if (
        !encoded.startsWith(CLERK_RSA_SPKI_PREFIX) ||
        !encoded.endsWith(CLERK_RSA_SPKI_SUFFIX)
      ) {
        throw new Error("invalid Clerk public key");
      }
      const decoded = Uint8Array.from(atob(encoded), (character) =>
        character.charCodeAt(0),
      );
      const key = await crypto.subtle.importKey(
        "spki",
        decoded,
        {
          hash: "SHA-256",
          name: "RSASSA-PKCS1-v1_5",
        },
        false,
        ["verify"],
      );
      if (
        key.algorithm.name !== "RSASSA-PKCS1-v1_5" ||
        !("modulusLength" in key.algorithm) ||
        key.algorithm.modulusLength !== 2_048
      ) {
        throw new Error("unsupported Clerk public key");
      }
      return jwtKey;
    },
    catch: () => new InvalidClerkJwtKey(),
  });

const clerkConfig = Config.all({
  audience: httpsOriginConfig("CLERK_API_AUDIENCE"),
  authorizedParty: httpsOriginConfig("CLERK_AUTHORIZED_PARTY"),
  issuer: httpsOriginConfig("CLERK_ISSUER"),
  jwtKey: Config.redacted("CLERK_JWT_KEY").pipe(
    Config.validate({
      message: "CLERK_JWT_KEY must be a PEM public key",
      validation: (value) =>
        Redacted.value(value).length <= 10_000 &&
        /^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----$/.test(
          Redacted.value(value),
        ),
    }),
  ),
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

const whatsappNumberReservationHmacSecret = Config.redacted(
  "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
).pipe(
  Config.validate({
    message:
      "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET must be a 32-byte hex secret",
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
    [
      "CONNECTION_SETUP_PROVISIONING_QUEUE",
      environment.CONNECTION_SETUP_PROVISIONING_QUEUE,
      ["send", "sendBatch"],
    ],
    ["DELETION_CAPSULES", environment.DELETION_CAPSULES, ["get", "put"]],
    ["DELETION_MARKERS", environment.DELETION_MARKERS, ["get", "list", "put"]],
    ["INGESTION_QUEUE", environment.INGESTION_QUEUE, ["send"]],
    ["OAUTH_KV", environment.OAUTH_KV, ["delete", "get", "put"]],
    [
      "STORED_MEDIA",
      environment.STORED_MEDIA,
      ["createMultipartUpload", "delete", "get", "put"],
    ],
    ["WEBHOOK_INGRESS", environment.WEBHOOK_INGRESS, ["delete", "get", "put"]],
  ] as const;

  for (const [binding, value, methods] of bindings) {
    if (!hasMethods(value, methods)) {
      return Effect.fail(new MissingCloudflareBinding({ binding }));
    }
  }
  if (typeof environment.WEBHOOK_HYPERDRIVE?.connectionString !== "string") {
    return Effect.fail(
      new MissingCloudflareBinding({ binding: "WEBHOOK_HYPERDRIVE" }),
    );
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
          if (
            !hasMethods(environment.PROVIDER_CONTROL, [
              "connectSession",
              "createSession",
              "deleteSession",
              "disconnectSession",
              "fetch",
              "getQrCode",
              "listSessions",
              "reconcileSession",
            ])
          ) {
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

const humanIdentityLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    HumanIdentity,
    clerkConfig.pipe(
      Effect.flatMap((config) =>
        validateClerkJwtKey(Redacted.value(config.jwtKey)).pipe(
          Effect.map((jwtKey) =>
            makeClerkHumanIdentity({
              ...config,
              jwtKey,
            }),
          ),
        ),
      ),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

const personalAccountPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.succeed(PersonalAccountPersistence, {
    create: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgPersonalAccountRepository(connectionString).create(
            input,
          );
        },
        catch: () => new PersonalAccountPersistenceError(),
      }),
    resolve: (clerkUserId) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgPersonalAccountRepository(connectionString).resolve(
            clerkUserId,
          );
        },
        catch: () => new PersonalAccountPersistenceError(),
      }),
  });

const personalAccountIdentifiersLayer = Layer.succeed(
  PersonalAccountIdentifiers,
  {
    next: Effect.sync(() => crypto.randomUUID()),
  },
);

const connectionSetupPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.succeed(ConnectionSetupPersistence, {
    cancel: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(connectionString).cancel(
            input,
          );
        },
        catch: () => new ConnectionSetupPersistenceError(),
      }),
    prepare: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(connectionString).prepare(
            input,
          );
        },
        catch: () => new ConnectionSetupPersistenceError(),
      }),
    start: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(connectionString).start(input);
        },
        catch: () => new ConnectionSetupPersistenceError(),
      }),
  });

const connectionSetupProvisioningPersistenceLayer = (
  environment: ApiEnvironment,
) =>
  Layer.succeed(ConnectionSetupProvisioningPersistence, {
    claim: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(
            connectionString,
          ).claimProvisioning(input);
        },
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
    finish: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(
            connectionString,
          ).finishProvisioning(input);
        },
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
    fail: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(
            connectionString,
          ).failProvisioning(input);
        },
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
    listCandidates: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(
            connectionString,
          ).listProvisioningCandidates(input);
        },
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
    release: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(
            connectionString,
          ).releaseProvisioningLease(input);
        },
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
    renew: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(
            connectionString,
          ).renewProvisioningLease(input);
        },
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
  });

const connectionSetupCleanupPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.succeed(ConnectionSetupCleanupPersistence, {
    claim: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(connectionString).claimCleanup(
            input,
          );
        },
        catch: () => new ConnectionSetupCleanupPersistenceError(),
      }),
    finish: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(
            connectionString,
          ).finishCleanup(input);
        },
        catch: () => new ConnectionSetupCleanupPersistenceError(),
      }),
    listCandidates: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(
            connectionString,
          ).listCleanupCandidates(input);
        },
        catch: () => new ConnectionSetupCleanupPersistenceError(),
      }),
    release: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(
            connectionString,
          ).releaseCleanupLease(input);
        },
        catch: () => new ConnectionSetupCleanupPersistenceError(),
      }),
    renew: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgConnectionSetupRepository(
            connectionString,
          ).renewCleanupLease(input);
        },
        catch: () => new ConnectionSetupCleanupPersistenceError(),
      }),
  });

const unavailableProviderResult = (
  operation: "lifecycle-write" | "safe-read",
): {
  readonly error: ProviderControlFailure;
  readonly ok: false;
} => ({
  error: {
    _tag: "ProviderControlFailure",
    code: "unavailable",
    operation,
    retryAfterMs: null,
    retryDecision:
      operation === "lifecycle-write"
        ? "reconcile_before_repeat"
        : "retry_within_safe_read_budget",
  },
  ok: false,
});

const connectionSetupProvisioningProviderLayer = (
  environment: ApiEnvironment,
) =>
  Layer.succeed(ConnectionSetupProvisioningProvider, {
    create: (input) =>
      Effect.tryPromise({
        try: () =>
          (
            environment.PROVIDER_CONTROL as ProviderControlService
          ).createSession(input),
        catch: () => unavailableProviderResult("lifecycle-write"),
      }).pipe(Effect.catchAll((failure) => Effect.succeed(failure))),
    reconcile: (input) =>
      Effect.tryPromise({
        try: () =>
          (
            environment.PROVIDER_CONTROL as ProviderControlService
          ).reconcileSession(input),
        catch: () => unavailableProviderResult("safe-read"),
      }).pipe(Effect.catchAll((failure) => Effect.succeed(failure))),
  });

const connectionSetupCleanupProviderLayer = (environment: ApiEnvironment) =>
  Layer.succeed(ConnectionSetupCleanupProvider, {
    delete: (input) =>
      Effect.tryPromise({
        try: () =>
          (
            environment.PROVIDER_CONTROL as ProviderControlService
          ).deleteSession(input),
        catch: () => unavailableProviderResult("lifecycle-write"),
      }).pipe(Effect.catchAll((failure) => Effect.succeed(failure))),
    reconcile: (input) =>
      Effect.tryPromise({
        try: () =>
          (
            environment.PROVIDER_CONTROL as ProviderControlService
          ).reconcileSession(input),
        catch: () => unavailableProviderResult("safe-read"),
      }).pipe(Effect.catchAll((failure) => Effect.succeed(failure))),
  });

const whatsAppConnectionProviderLayer = (environment: ApiEnvironment) =>
  Layer.succeed(WhatsAppConnectionProvider, {
    connect: (input) =>
      Effect.tryPromise({
        try: () =>
          (
            environment.PROVIDER_CONTROL as ProviderControlService
          ).connectSession(input),
        catch: () => unavailableProviderResult("lifecycle-write"),
      }).pipe(Effect.catchAll((failure) => Effect.succeed(failure))),
    disconnect: (input) =>
      Effect.tryPromise({
        try: () =>
          (
            environment.PROVIDER_CONTROL as ProviderControlService
          ).disconnectSession(input),
        catch: () => unavailableProviderResult("lifecycle-write"),
      }).pipe(Effect.catchAll((failure) => Effect.succeed(failure))),
    getQrCode: (input) =>
      Effect.tryPromise({
        try: () =>
          (environment.PROVIDER_CONTROL as ProviderControlService).getQrCode(
            input,
          ),
        catch: () => unavailableProviderResult("safe-read"),
      }).pipe(Effect.catchAll((failure) => Effect.succeed(failure))),
    reconcile: (input) =>
      Effect.tryPromise({
        try: () =>
          (
            environment.PROVIDER_CONTROL as ProviderControlService
          ).reconcileSession(input),
        catch: () => unavailableProviderResult("safe-read"),
      }).pipe(Effect.catchAll((failure) => Effect.succeed(failure))),
  });

const whatsAppConnectionPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.succeed(WhatsAppConnectionPersistence, {
    activate: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgWhatsAppConnectionRepository(connectionString).activate(
            input,
          );
        },
        catch: () => new WhatsAppConnectionPersistenceError(),
      }),
    claimLifecycle: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgWhatsAppConnectionRepository(
            connectionString,
          ).claimLifecycle(input);
        },
        catch: () => new WhatsAppConnectionPersistenceError(),
      }),
    finishLifecycle: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgWhatsAppConnectionRepository(
            connectionString,
          ).finishLifecycle(input);
        },
        catch: () => new WhatsAppConnectionPersistenceError(),
      }),
    list: (clerkUserId) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgWhatsAppConnectionRepository(
            connectionString,
          ).listForUser(clerkUserId);
        },
        catch: () => new WhatsAppConnectionPersistenceError(),
      }),
    loadSetup: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgWhatsAppConnectionRepository(
            connectionString,
          ).loadSetupForActivation(input);
        },
        catch: () => new WhatsAppConnectionPersistenceError(),
      }),
  });

const webhookIngressPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.succeed(WebhookIngressPersistence, {
    resolve: (webhookIngressId) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("Webhook Hyperdrive unavailable");
          }
          return makePgWebhookIngressRepository(connectionString).resolve(
            webhookIngressId,
          );
        },
        catch: () => new WebhookIngressPersistenceError(),
      }),
  });

const webhookIngressCloudflareLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(WebhookIngressObjectStore, {
      put: (object) =>
        Effect.tryPromise({
          try: async () => {
            const bucket = environment.WEBHOOK_INGRESS;
            if (!hasMethods(bucket, ["put"])) {
              throw new Error("Webhook ingress bucket unavailable");
            }
            const stored = await (bucket as Pick<R2Bucket, "put">).put(
              object.objectKey,
              object.body,
              {
                customMetadata: { ...object.customMetadata },
                httpMetadata: {
                  contentType:
                    "application/vnd.whatsapp-mcp.webhook-ciphertext+json",
                },
                onlyIf: { etagDoesNotMatch: "*" },
              },
            );
            if (stored === null) {
              throw new Error("Webhook Event object already exists");
            }
          },
          catch: () => new WebhookIngressObjectStoreError(),
        }),
    }),
    Layer.succeed(WebhookIngressQueue, {
      publish: (message) =>
        Effect.tryPromise({
          try: async () => {
            const queue = environment.INGESTION_QUEUE;
            if (!hasMethods(queue, ["send"])) {
              throw new Error("ingestion Queue unavailable");
            }
            await (queue as Pick<Queue, "send">).send(message, {
              contentType: "json",
            });
          },
          catch: () => new WebhookIngressQueueError(),
        }),
    }),
    Layer.succeed(WebhookIngressClock, {
      now: Effect.sync(() => new Date().toISOString()),
    }),
    Layer.succeed(WebhookIngressIdentifiers, {
      nextObjectId: Effect.sync(() => crypto.randomUUID()),
    }),
  );

const connectionSetupProvisioningQueueLayer = (environment: ApiEnvironment) =>
  Layer.succeed(ConnectionSetupProvisioningQueue, {
    enqueue: (setupId) =>
      Effect.tryPromise({
        try: async () => {
          const queue = environment.CONNECTION_SETUP_PROVISIONING_QUEUE;
          if (!hasMethods(queue, ["send"])) {
            throw new Error("Connection Setup provisioning Queue unavailable");
          }
          await (queue as Pick<Queue, "send">).send(
            connectionSetupProvisioningMessage(setupId),
          );
        },
        catch: () => new ConnectionSetupProvisioningQueueError(),
      }),
    enqueueCleanup: (setupId) =>
      Effect.tryPromise({
        try: async () => {
          const queue = environment.CONNECTION_SETUP_PROVISIONING_QUEUE;
          if (!hasMethods(queue, ["send"])) {
            throw new Error("Connection Setup cleanup Queue unavailable");
          }
          await (queue as Pick<Queue, "send">).send(
            connectionSetupCleanupMessage(setupId),
          );
        },
        catch: () => new ConnectionSetupProvisioningQueueError(),
      }),
  });

const connectionSetupIdentifiersLayer = Layer.succeed(
  ConnectionSetupIdentifiers,
  {
    next: Effect.sync(() => makeConnectionSetupId()),
  },
);

const connectionSetupClockLayer = Layer.succeed(ConnectionSetupClock, {
  now: Effect.sync(() => new Date().toISOString()),
});

const whatsAppConnectionRuntimeLayer = Layer.mergeAll(
  Layer.succeed(WhatsAppConnectionClock, {
    now: Effect.sync(() => new Date().toISOString()),
  }),
  Layer.succeed(WhatsAppConnectionIdentifiers, {
    nextConnectionId: Effect.sync(() => crypto.randomUUID()),
    nextLifecycleClaimId: Effect.sync(() => crypto.randomUUID()),
    nextPublicId: Effect.sync(() => makeConnectionId()),
    nextWebhookIdentityKey: Effect.sync(() =>
      crypto.getRandomValues(new Uint8Array(32)),
    ),
  }),
);

const connectionSetupNumberTokensLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    ConnectionSetupNumberTokens,
    whatsappNumberReservationHmacSecret.pipe(
      Effect.map((secret) =>
        makeConnectionSetupNumberTokens(
          Uint8Array.from(
            Redacted.value(secret).match(/.{2}/gu) ?? [],
            (value) => Number.parseInt(value, 16),
          ),
        ),
      ),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

const mcpAuthorizationPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.succeed(McpAuthorizationPersistence, {
    create: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(connectionString).create(
            input,
          );
        },
        catch: () => new McpAuthorizationPersistenceError(),
      }),
    isActive: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(connectionString).isActive(
            input,
          );
        },
        catch: () => new McpAuthorizationPersistenceError(),
      }),
    listConnections: (clerkUserId) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(
            connectionString,
          ).listConnections(clerkUserId);
        },
        catch: () => new McpAuthorizationPersistenceError(),
      }),
    list: (clerkUserId, observedAt) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(connectionString).list(
            clerkUserId,
            observedAt,
          );
        },
        catch: () => new McpAuthorizationPersistenceError(),
      }),
    registerRefreshCredential: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(
            connectionString,
          ).registerRefreshCredential(input);
        },
        catch: () => new McpAuthorizationPersistenceError(),
      }),
    rotateRefreshCredential: (input, issue) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(
            connectionString,
          ).rotateRefreshCredential(input, issue);
        },
        catch: () => new McpAuthorizationPersistenceError(),
      }),
    revoke: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(connectionString).revoke(
            input,
          );
        },
        catch: () => new McpAuthorizationPersistenceError(),
      }),
  });

const randomBase64Url = (): string => {
  const value = new Uint8Array(32);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const connectionSetupProvisioningRuntimeLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(ConnectionSetupProvisioningClock, {
      now: Effect.sync(() => new Date().toISOString()),
    }),
    Layer.succeed(ConnectionSetupProvisioningIdentifiers, {
      nextWorkerId: Effect.sync(() => `cspw_${randomBase64Url()}`),
    }),
    Layer.succeed(ConnectionSetupProvisioningWebhook, {
      urlFor: (webhookIngressId) =>
        Effect.sync(() => {
          if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              webhookIngressId,
            )
          ) {
            throw new Error("invalid webhook ingress identity");
          }
          return `${environment.OAUTH_ISSUER}/webhooks/wasender/${webhookIngressId}`;
        }),
    }),
  );

const connectionSetupCleanupRuntimeLayer = Layer.mergeAll(
  Layer.succeed(ConnectionSetupCleanupClock, {
    now: Effect.sync(() => new Date().toISOString()),
  }),
  Layer.succeed(ConnectionSetupCleanupIdentifiers, {
    nextWorkerId: Effect.sync(() => `cscw_${randomBase64Url()}`),
  }),
);

const mcpAuthorizationRuntimeLayer = Layer.mergeAll(
  Layer.succeed(McpAuthorizationClock, {
    now: Effect.sync(() => new Date()),
  }),
  Layer.succeed(McpAuthorizationIdentifiers, {
    authorizationId: Effect.sync(() => crypto.randomUUID()),
    oauthSubject: Effect.sync(randomBase64Url),
  }),
);

const privateBetaConfigLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    PrivateBetaConfig,
    providerApprovedSessionCapacity.pipe(
      Effect.map((capacity) => ({
        providerApprovedSessionCapacity: capacity,
      })),
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

const safeTelemetry = {
  emit: (event: SafeTelemetryEvent) =>
    Effect.sync(() => console.info(JSON.stringify(event))),
} satisfies SafeTelemetry;

const telemetryLayer = Layer.succeed(SafeTelemetry, safeTelemetry);

const storedMediaContainerLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    StoredMediaContainerService,
    Config.all({
      application: productionConfig,
      kms: kmsConfig,
    }).pipe(
      Effect.flatMap(({ application, kms }) => {
        if (
          !hasMethods(environment.STORED_MEDIA, [
            "createMultipartUpload",
            "get",
          ])
        ) {
          return Effect.fail(
            new MissingCloudflareBinding({ binding: "STORED_MEDIA" }),
          );
        }
        const client = new KMSClient({
          credentials: {
            accessKeyId: Redacted.value(kms.accessKeyId),
            secretAccessKey: Redacted.value(kms.secretAccessKey),
            sessionToken: Redacted.value(kms.sessionToken),
          },
          region: kms.region,
        });
        return Effect.succeed(
          makeStoredMediaContainer({
            bucket: environment.STORED_MEDIA as Pick<
              R2Bucket,
              "createMultipartUpload" | "get"
            >,
            encryption: makeEnvelopeEncryption({
              contentRootKeyId: kms.contentRootKeyArn,
              environment: application.environment,
              kms: makeAwsKmsKeyService(client),
            }),
            environment: application.environment,
            telemetry: (event) => {
              Effect.runSync(safeTelemetry.emit(event));
            },
          }),
        );
      }),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

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
  const layer = Layer.mergeAll(
    configLayer(environment),
    databaseLayer(environment),
    telemetryLayer,
    encryptionLayer(environment),
    deletionLayer(environment),
    storedMediaContainerLayer(environment),
    humanIdentityLayer(environment),
    personalAccountPersistenceLayer(environment),
    personalAccountIdentifiersLayer,
    privateBetaConfigLayer(environment),
    connectionSetupPersistenceLayer(environment),
    connectionSetupProvisioningPersistenceLayer(environment),
    connectionSetupProvisioningProviderLayer(environment),
    connectionSetupProvisioningQueueLayer(environment),
    connectionSetupProvisioningRuntimeLayer(environment),
    connectionSetupIdentifiersLayer,
    connectionSetupClockLayer,
    connectionSetupNumberTokensLayer(environment),
    whatsAppConnectionPersistenceLayer(environment),
    whatsAppConnectionProviderLayer(environment),
    whatsAppConnectionRuntimeLayer,
    mcpAuthorizationPersistenceLayer(environment),
    mcpAuthorizationRuntimeLayer,
    webhookIngressPersistenceLayer(environment),
    webhookIngressCloudflareLayer(environment),
  );
  const handler = createCanaryHandler(layer);
  const personalAccountHandler = createPersonalAccountHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
  );
  const connectionSetupHandler = createConnectionSetupHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
  );
  const mcpAuthorizationManagementHandler =
    createMcpAuthorizationManagementHandler(
      layer,
      environment.CLERK_AUTHORIZED_PARTY ?? "",
    );
  const whatsAppConnectionHandler = createWhatsAppConnectionHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
  );
  const webhookIngressHandler = createWebhookIngressHandler(layer);
  const oauthConfiguration = Effect.runPromise(
    loadOAuthConfiguration(environment as unknown as Record<string, unknown>),
  );

  return async (
    request: Request,
    context?: ExecutionContext,
  ): Promise<Response> => {
    try {
      const configuration = await oauthConfiguration;
      if (isWebhookIngressRequest(request)) {
        return webhookIngressHandler(request);
      }
      const consentHandler = createMcpAuthorizationConsentHandler({
        browserOrigin: environment.CLERK_AUTHORIZED_PARTY ?? "",
        configuration,
        kv: environment.OAUTH_KV as Parameters<
          typeof createMcpAuthorizationConsentHandler
        >[0]["kv"],
        layer,
        telemetry: (event) => {
          Effect.runSync(safeTelemetry.emit(event));
        },
      });
      const applicationHandler = async (
        nextRequest: Request,
        nextEnvironment: Parameters<
          Parameters<typeof createOAuthHandler>[0]["applicationHandler"]
        >[1],
      ): Promise<Response> => {
        if (
          isMcpAuthorizationConsentRequest(nextRequest) &&
          nextEnvironment.OAUTH_PROVIDER
        ) {
          return consentHandler(nextRequest, nextEnvironment.OAUTH_PROVIDER);
        }
        if (isConnectionSetupRequest(nextRequest)) {
          return connectionSetupHandler(nextRequest);
        }
        if (isMcpAuthorizationManagementRequest(nextRequest)) {
          return mcpAuthorizationManagementHandler(nextRequest);
        }
        if (isWhatsAppConnectionRequest(nextRequest)) {
          return whatsAppConnectionHandler(nextRequest);
        }
        if (isPersonalAccountRequest(nextRequest)) {
          return personalAccountHandler(nextRequest);
        }
        return handler(nextRequest);
      };
      const oauthHandler = createOAuthHandler({
        applicationHandler,
        configuration,
        environment: environment as Parameters<
          typeof createOAuthHandler
        >[0]["environment"],
        isAuthorizationActive: async (input) => {
          try {
            return await Effect.runPromise(
              Effect.gen(function* () {
                const clock = yield* McpAuthorizationClock;
                const persistence = yield* McpAuthorizationPersistence;
                return yield* persistence.isActive({
                  ...input,
                  observedAt: yield* clock.now,
                });
              }).pipe(Effect.provide(layer)),
            );
          } catch {
            return false;
          }
        },
        refreshCredentials: {
          register: (input) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const persistence = yield* McpAuthorizationPersistence;
                return yield* persistence.registerRefreshCredential(input);
              }).pipe(Effect.provide(layer)),
            ),
          rotate: (input, issue) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const persistence = yield* McpAuthorizationPersistence;
                return yield* persistence.rotateRefreshCredential(input, issue);
              }).pipe(Effect.provide(layer)),
            ),
        },
        telemetry: (event) => {
          Effect.runSync(safeTelemetry.emit(event));
        },
      });
      return await oauthHandler(
        request,
        context ??
          ({
            passThroughOnException: () => undefined,
            waitUntil: () => undefined,
          } as unknown as ExecutionContext),
      );
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

const provisioningQueueName = (environment: ApiEnvironment): string | null => {
  const deploymentEnvironment = environment.DEPLOYMENT_ENVIRONMENT;
  if (
    deploymentEnvironment !== "development" &&
    deploymentEnvironment !== "preview" &&
    deploymentEnvironment !== "production"
  ) {
    return null;
  }
  const suffix =
    deploymentEnvironment === "production" ? "" : `-${deploymentEnvironment}`;
  return `whatsapp-mcp-connection-setup-provisioning${suffix}`;
};

export const createProductionQueueHandler =
  (environment: ApiEnvironment) =>
  async (batch: MessageBatch): Promise<void> => {
    if (batch.queue !== provisioningQueueName(environment)) {
      for (const message of batch.messages) {
        message.retry({ delaySeconds: 30 });
      }
      return;
    }
    const cleanupMessages = batch.messages.filter((message) =>
      isConnectionSetupCleanupMessage(message.body),
    );
    const provisioningMessages = batch.messages.filter(
      (message) => !isConnectionSetupCleanupMessage(message.body),
    );
    if (cleanupMessages.length > 0) {
      const cleanupLayer = Layer.mergeAll(
        telemetryLayer,
        connectionSetupCleanupPersistenceLayer(environment),
        connectionSetupCleanupProviderLayer(environment),
        connectionSetupCleanupRuntimeLayer,
      );
      await handleConnectionSetupCleanupBatch(
        { ...batch, messages: cleanupMessages },
        cleanupLayer,
      );
    }
    if (provisioningMessages.length > 0) {
      const provisioningLayer = Layer.mergeAll(
        encryptionLayer(environment),
        telemetryLayer,
        connectionSetupProvisioningPersistenceLayer(environment),
        connectionSetupProvisioningProviderLayer(environment),
        connectionSetupProvisioningRuntimeLayer(environment),
      );
      await handleConnectionSetupProvisioningBatch(
        { ...batch, messages: provisioningMessages },
        provisioningLayer,
      );
    }
  };

interface ConnectionSetupScheduledRepository {
  readonly expire: ReturnType<typeof makePgConnectionSetupRepository>["expire"];
  readonly listCleanupCandidates: ReturnType<
    typeof makePgConnectionSetupRepository
  >["listCleanupCandidates"];
  readonly listProvisioningCandidates: ReturnType<
    typeof makePgConnectionSetupRepository
  >["listProvisioningCandidates"];
}

export const createProductionScheduledHandler =
  (
    environment: ApiEnvironment,
    dependencies: {
      readonly makeRepository?: (
        connectionString: string,
      ) => ConnectionSetupScheduledRepository;
    } = {},
  ) =>
  async (controller: ScheduledController): Promise<void> => {
    if (controller.cron !== "* * * * *") return;
    const connectionString = environment.HYPERDRIVE?.connectionString;
    const queue = environment.CONNECTION_SETUP_PROVISIONING_QUEUE;
    if (
      typeof connectionString !== "string" ||
      !hasMethods(queue, ["sendBatch"])
    ) {
      throw new Error("Connection Setup provisioning recovery unavailable");
    }
    const repository = (
      dependencies.makeRepository ?? makePgConnectionSetupRepository
    )(connectionString);
    const observedAt = new Date(controller.scheduledTime).toISOString();
    const expired = await repository.expire({
      limit: 100,
      observedAt,
    });
    const cleanupCandidates = await repository.listCleanupCandidates({
      limit: 100,
      observedAt,
    });
    const provisioningCandidates = await repository.listProvisioningCandidates({
      limit: 100,
      observedAt,
    });
    if (cleanupCandidates.length > 0) {
      await (queue as Pick<Queue, "sendBatch">).sendBatch(
        cleanupCandidates.map((setupId) => ({
          body: connectionSetupCleanupMessage(setupId),
        })),
      );
    }
    if (provisioningCandidates.length > 0) {
      await (queue as Pick<Queue, "sendBatch">).sendBatch(
        provisioningCandidates.map((setupId) => ({
          body: connectionSetupProvisioningMessage(setupId),
        })),
      );
    }
    Effect.runSync(
      safeTelemetry.emit({
        candidateCount: provisioningCandidates.length,
        event: "connection_setup.provision.recovery_enqueued",
        service: "api",
      }),
    );
    Effect.runSync(
      safeTelemetry.emit({
        candidateCount: cleanupCandidates.length,
        event: "connection_setup.cleanup.recovery_enqueued",
        expiredCount: expired.length,
        service: "api",
      }),
    );
  };
