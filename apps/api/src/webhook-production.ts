import {
  makeContactId,
  makeConversationId,
  makeMessageId,
} from "@whatsapp-mcp/contracts/handles";
import { makePgWebhookEventRepository } from "@whatsapp-mcp/db/webhook-event";
import { makePgWebhookIngressRepository } from "@whatsapp-mcp/db/webhook-ingress";
import { makePgWebhookReplayRepository } from "@whatsapp-mcp/db/webhook-replay";
import { Effect, Layer } from "effect";
import {
  jitteredWebhookRetryDelaySeconds,
  WebhookEventClock,
  WebhookEventIdentifiers,
  WebhookEventObjectStore,
  WebhookEventObjectStoreError,
  WebhookEventPersistence,
  WebhookEventPersistenceError,
  WebhookEventRetrySchedule,
  wasenderWebhookEventNormalizationLayer,
} from "./webhook-event";
import {
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
  WebhookRecoveryCheckpoint,
  WebhookRecoveryCheckpointError,
  WebhookRecoveryObjectStore,
  WebhookRecoveryObjectStoreError,
  WebhookRecoveryPersistence,
  WebhookRecoveryPersistenceError,
} from "./webhook-recovery";
import {
  WebhookReplayClock,
  WebhookReplayPersistence,
  WebhookReplayPersistenceError,
  WebhookReplayQueue,
  WebhookReplayQueueError,
  WebhookSourceObjectStore,
  WebhookSourceObjectStoreError,
} from "./webhook-replay";

export interface WebhookProductionEnvironment {
  readonly INGESTION_QUEUE?: unknown;
  readonly OAUTH_KV?: unknown;
  readonly WEBHOOK_HYPERDRIVE?:
    | { readonly connectionString: string }
    | undefined;
  readonly WEBHOOK_INGRESS?: unknown;
}

const hasMethods = (
  value: unknown,
  methods: ReadonlyArray<string>,
): value is Record<string, (...args: never[]) => unknown> =>
  typeof value === "object" &&
  value !== null &&
  methods.every(
    (method) =>
      typeof (value as Record<string, unknown>)[method] === "function",
  );

const webhookIngressPersistenceLayer = (
  environment: WebhookProductionEnvironment,
) => {
  const connectionString = environment.WEBHOOK_HYPERDRIVE?.connectionString;
  const repository =
    typeof connectionString === "string"
      ? makePgWebhookIngressRepository(connectionString)
      : null;
  const getRepository = () => {
    if (repository === null) throw new Error("Webhook Hyperdrive unavailable");
    return repository;
  };
  return Layer.succeed(WebhookIngressPersistence, {
    resolve: (webhookIngressId) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("Webhook Hyperdrive unavailable");
          }
          return getRepository().resolve(webhookIngressId);
        },
        catch: () => new WebhookIngressPersistenceError(),
      }),
  });
};

const webhookIngressCloudflareLayer = (
  environment: WebhookProductionEnvironment,
) =>
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

const webhookEventPersistenceLayer = (
  environment: WebhookProductionEnvironment,
) => {
  const connectionString = environment.WEBHOOK_HYPERDRIVE?.connectionString;
  const repository =
    typeof connectionString === "string"
      ? makePgWebhookEventRepository(connectionString)
      : null;
  const getRepository = () => {
    if (repository === null) throw new Error("Webhook Hyperdrive unavailable");
    return repository;
  };
  return Layer.succeed(WebhookEventPersistence, {
    complete: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("Webhook Hyperdrive unavailable");
          }
          return getRepository().complete(input);
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
    deadLetter: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("Webhook Hyperdrive unavailable");
          }
          return getRepository().deadLetter(input);
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
    prepare: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("Webhook Hyperdrive unavailable");
          }
          return getRepository().prepare(input);
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
    projectConnectionState: (input, compareVersions) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("Webhook Hyperdrive unavailable");
          }
          return getRepository().projectConnectionState(input, compareVersions);
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
    projectGroup: (input, protect, compareVersions) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return getRepository().projectGroup(input, protect, compareVersions);
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
    projectDirectoryContact: (input, compareVersions) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("Webhook Hyperdrive unavailable");
          }
          return getRepository().projectDirectoryContact(
            input,
            compareVersions,
          );
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
    projectStoredMessage: (input, compareVersions) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("Webhook Hyperdrive unavailable");
          return getRepository().projectStoredMessage(input, compareVersions);
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
    projectSendEvidence: (input, materialize) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("Webhook Hyperdrive unavailable");
          return getRepository().projectSendEvidence(input, materialize);
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
    projectStoredMessageEdit: (input, compareVersions) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("Webhook Hyperdrive unavailable");
          return getRepository().projectStoredMessageEdit(
            input,
            compareVersions,
          );
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
    projectStoredMessageDeletion: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("Webhook Hyperdrive unavailable");
          return getRepository().projectStoredMessageDeletion(input);
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
    quarantine: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString =
            environment.WEBHOOK_HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("Webhook Hyperdrive unavailable");
          }
          return getRepository().quarantine(input);
        },
        catch: () => new WebhookEventPersistenceError(),
      }),
  });
};

export const makeWebhookEventProductionLayer = (
  environment: WebhookProductionEnvironment,
) =>
  Layer.mergeAll(
    webhookEventPersistenceLayer(environment),
    wasenderWebhookEventNormalizationLayer,
    Layer.succeed(WebhookEventClock, {
      now: Effect.sync(() => new Date().toISOString()),
    }),
    Layer.succeed(WebhookEventIdentifiers, {
      nextContactId: Effect.sync(() => makeContactId()),
      nextConversationId: Effect.sync(() => makeConversationId()),
      nextMessageId: Effect.sync(() => makeMessageId()),
    }),
    Layer.succeed(WebhookEventRetrySchedule, {
      delaySeconds: () =>
        Effect.sync(() => {
          const random = new Uint32Array(1);
          crypto.getRandomValues(random);
          return jitteredWebhookRetryDelaySeconds(
            (random[0] ?? 0) / 4_294_967_296,
          );
        }),
    }),
    Layer.succeed(WebhookEventObjectStore, {
      load: (objectId) =>
        Effect.tryPromise({
          try: async () => {
            const bucket = environment.WEBHOOK_INGRESS;
            if (!hasMethods(bucket, ["get"])) {
              throw new Error("Webhook ingress bucket unavailable");
            }
            const object = await (bucket as Pick<R2Bucket, "get">).get(
              `webhook-events/${objectId}`,
            );
            if (object === null) return null;
            if (object.size > 1_400_000) {
              throw new Error("Webhook Event ciphertext exceeds its bound");
            }
            return {
              body: new Uint8Array(await object.arrayBuffer()),
              customMetadata: { ...(object.customMetadata ?? {}) },
            };
          },
          catch: () => new WebhookEventObjectStoreError(),
        }),
    }),
  );

export const makeWebhookRecoveryProductionLayer = (
  environment: WebhookProductionEnvironment,
) => {
  const connectionString = environment.WEBHOOK_HYPERDRIVE?.connectionString;
  const repository =
    typeof connectionString === "string"
      ? makePgWebhookEventRepository(connectionString)
      : null;
  const getRepository = () => {
    if (repository === null) throw new Error("Webhook Hyperdrive unavailable");
    return repository;
  };
  return Layer.mergeAll(
    Layer.succeed(WebhookRecoveryCheckpoint, {
      load: Effect.tryPromise({
        try: async () => {
          const namespace = environment.OAUTH_KV;
          if (!hasMethods(namespace, ["get"])) {
            throw new Error("Webhook recovery checkpoint unavailable");
          }
          return await (namespace as Pick<KVNamespace, "get">).get(
            "maintenance:webhook-recovery-cursor",
          );
        },
        catch: () => new WebhookRecoveryCheckpointError(),
      }),
      save: (cursor) =>
        Effect.tryPromise({
          try: async () => {
            const namespace = environment.OAUTH_KV;
            if (!hasMethods(namespace, ["delete", "put"])) {
              throw new Error("Webhook recovery checkpoint unavailable");
            }
            if (cursor === null) {
              await (namespace as Pick<KVNamespace, "delete">).delete(
                "maintenance:webhook-recovery-cursor",
              );
            } else {
              await (namespace as Pick<KVNamespace, "put">).put(
                "maintenance:webhook-recovery-cursor",
                cursor,
              );
            }
          },
          catch: () => new WebhookRecoveryCheckpointError(),
        }),
    }),
    Layer.succeed(WebhookRecoveryObjectStore, {
      list: (cursor) =>
        Effect.tryPromise({
          try: async () => {
            const bucket = environment.WEBHOOK_INGRESS;
            if (!hasMethods(bucket, ["list"])) {
              throw new Error("Webhook ingress bucket unavailable");
            }
            const listPage = (pageCursor: string | null) =>
              (bucket as Pick<R2Bucket, "list">).list({
                ...(pageCursor === null ? {} : { cursor: pageCursor }),
                include: ["customMetadata"],
                limit: 100,
                prefix: "webhook-events/",
              });
            let listed: R2Objects;
            try {
              listed = await listPage(cursor);
            } catch (error) {
              if (cursor === null) throw error;
              listed = await listPage(null);
            }
            if (listed.truncated && listed.cursor === undefined) {
              throw new Error("Webhook ingress listing cursor unavailable");
            }
            return {
              cursor: listed.truncated ? (listed.cursor ?? null) : null,
              objects: listed.objects.map((object) => ({
                customMetadata: { ...(object.customMetadata ?? {}) },
                objectKey: object.key,
                uploadedAt: object.uploaded.toISOString(),
              })),
            };
          },
          catch: () => new WebhookRecoveryObjectStoreError(),
        }),
    }),
    Layer.succeed(WebhookRecoveryPersistence, {
      filterUnclaimed: (messages) =>
        Effect.tryPromise({
          try: async () => {
            const connectionString =
              environment.WEBHOOK_HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("Webhook Hyperdrive unavailable");
            }
            const candidates = messages.map((message) => ({
              ciphertextSha256: message.ciphertext_sha256,
              eventId: message.object_id,
              message,
              payloadBytes: message.payload_bytes,
              personalAccountId: message.personal_account_id,
              receivedAt: message.received_at,
              whatsappConnectionId: message.whatsapp_connection_id,
            }));
            const unclaimed = await getRepository().filterUnclaimed(candidates);
            return unclaimed.map(({ message }) => message);
          },
          catch: () => new WebhookRecoveryPersistenceError(),
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
  );
};

export const makeWebhookReplayProductionLayer = (
  environment: WebhookProductionEnvironment,
) => {
  const connectionString = environment.WEBHOOK_HYPERDRIVE?.connectionString;
  const repository =
    typeof connectionString === "string"
      ? makePgWebhookReplayRepository(connectionString)
      : null;
  const getRepository = () => {
    if (repository === null) throw new Error("Webhook Hyperdrive unavailable");
    return repository;
  };
  return Layer.mergeAll(
    Layer.succeed(WebhookReplayClock, {
      now: Effect.sync(() => new Date().toISOString()),
    }),
    Layer.succeed(WebhookReplayPersistence, {
      complete: (input) =>
        Effect.tryPromise({
          try: async () => {
            const connectionString =
              environment.WEBHOOK_HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("Webhook Hyperdrive unavailable");
            }
            await getRepository().complete(input);
          },
          catch: () => new WebhookReplayPersistenceError(),
        }),
      finalizeExpiredSource: (input) =>
        Effect.tryPromise({
          try: async () => {
            const connectionString =
              environment.WEBHOOK_HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("Webhook Hyperdrive unavailable");
            }
            return getRepository().finalizeExpiredSource(input);
          },
          catch: () => new WebhookReplayPersistenceError(),
        }),
      listExpiredSources: (input) =>
        Effect.tryPromise({
          try: async () => {
            const connectionString =
              environment.WEBHOOK_HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("Webhook Hyperdrive unavailable");
            }
            return getRepository().listExpiredSources(input);
          },
          catch: () => new WebhookReplayPersistenceError(),
        }),
      prepare: ({ observedAt, request: input }) =>
        Effect.tryPromise({
          try: async () => {
            const connectionString =
              environment.WEBHOOK_HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("Webhook Hyperdrive unavailable");
            }
            return getRepository().prepare({
              incidentReference: input.incident_reference,
              observedAt,
              operatorReference: input.operator_reference,
              reasonCode: input.reason_code,
              requestId: input.request_id,
              requestedAt: input.requested_at,
            });
          },
          catch: () => new WebhookReplayPersistenceError(),
        }),
    }),
    Layer.succeed(WebhookReplayQueue, {
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
          catch: () => new WebhookReplayQueueError(),
        }),
    }),
    Layer.succeed(WebhookSourceObjectStore, {
      delete: (eventId) =>
        Effect.tryPromise({
          try: async () => {
            const bucket = environment.WEBHOOK_INGRESS;
            if (!hasMethods(bucket, ["delete"])) {
              throw new Error("Webhook ingress bucket unavailable");
            }
            await (bucket as Pick<R2Bucket, "delete">).delete(
              `webhook-events/${eventId}`,
            );
          },
          catch: () => new WebhookSourceObjectStoreError(),
        }),
    }),
  );
};

export const makeWebhookIngressProductionLayer = (
  environment: WebhookProductionEnvironment,
) =>
  Layer.mergeAll(
    webhookIngressPersistenceLayer(environment),
    webhookIngressCloudflareLayer(environment),
  );
