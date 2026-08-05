import { Context, Data, Effect, type Layer } from "effect";
import { hasExactKeys } from "./record";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";
import {
  isWebhookEventQueueMessage,
  type WebhookEventQueueMessage,
} from "./webhook-event";
import {
  WebhookIngressQueue,
  type WebhookIngressQueueService,
} from "./webhook-ingress";

const recoveryGraceMilliseconds = 60_000;

export class WebhookRecoveryObjectStoreError extends Data.TaggedError(
  "WebhookRecoveryObjectStoreError",
) {}

export class WebhookRecoveryPersistenceError extends Data.TaggedError(
  "WebhookRecoveryPersistenceError",
) {}

export class WebhookRecoveryCheckpointError extends Data.TaggedError(
  "WebhookRecoveryCheckpointError",
) {}

export interface WebhookRecoveryStoredObject {
  readonly customMetadata: Readonly<Record<string, string>>;
  readonly objectKey: string;
  readonly uploadedAt: string;
}

export interface WebhookRecoveryObjectStoreService {
  readonly list: (cursor: string | null) => Effect.Effect<
    {
      readonly cursor: string | null;
      readonly objects: ReadonlyArray<WebhookRecoveryStoredObject>;
    },
    WebhookRecoveryObjectStoreError
  >;
}

export const WebhookRecoveryObjectStore =
  Context.GenericTag<WebhookRecoveryObjectStoreService>(
    "@whatsapp-mcp/api/WebhookRecoveryObjectStore",
  );

export interface WebhookRecoveryPersistenceService {
  readonly filterUnclaimed: (
    messages: ReadonlyArray<WebhookEventQueueMessage>,
  ) => Effect.Effect<
    ReadonlyArray<WebhookEventQueueMessage>,
    WebhookRecoveryPersistenceError
  >;
}

export const WebhookRecoveryPersistence =
  Context.GenericTag<WebhookRecoveryPersistenceService>(
    "@whatsapp-mcp/api/WebhookRecoveryPersistence",
  );

export interface WebhookRecoveryCheckpointService {
  readonly load: Effect.Effect<string | null, WebhookRecoveryCheckpointError>;
  readonly save: (
    cursor: string | null,
  ) => Effect.Effect<void, WebhookRecoveryCheckpointError>;
}

export const WebhookRecoveryCheckpoint =
  Context.GenericTag<WebhookRecoveryCheckpointService>(
    "@whatsapp-mcp/api/WebhookRecoveryCheckpoint",
  );

export type WebhookRecoveryRequirements =
  | SafeTelemetryService
  | WebhookIngressQueueService
  | WebhookRecoveryCheckpointService
  | WebhookRecoveryObjectStoreService
  | WebhookRecoveryPersistenceService;

const eventObjectPattern =
  /^webhook-events\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

const parsePositiveInteger = (value: string | undefined): number | null => {
  if (value === undefined || !/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const messageFromObject = (
  object: WebhookRecoveryStoredObject,
): WebhookEventQueueMessage | null => {
  const objectId = eventObjectPattern.exec(object.objectKey)?.[1];
  const metadata = object.customMetadata;
  const payloadBytes = parsePositiveInteger(metadata.payloadBytes);
  if (
    objectId === undefined ||
    payloadBytes === null ||
    !hasExactKeys(metadata, [
      "ciphertextSha256",
      "payloadBytes",
      "personalAccountId",
      "receivedAt",
      "version",
      "whatsappConnectionId",
    ])
  ) {
    return null;
  }
  const message = {
    ciphertext_sha256: metadata.ciphertextSha256,
    object_id: objectId,
    payload_bytes: payloadBytes,
    personal_account_id: metadata.personalAccountId,
    received_at: metadata.receivedAt,
    version: metadata.version === "1" ? 1 : metadata.version,
    whatsapp_connection_id: metadata.whatsappConnectionId,
  };
  return isWebhookEventQueueMessage(message) ? message : null;
};

export const handleWebhookIngressSweep = (
  observedAt: string,
  layer: Layer.Layer<WebhookRecoveryRequirements, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observedAtMilliseconds = Date.parse(observedAt);
      if (!Number.isFinite(observedAtMilliseconds)) {
        return yield* Effect.die("invalid Webhook recovery observation time");
      }
      const checkpoint = yield* WebhookRecoveryCheckpoint;
      const cursor = yield* checkpoint.load;
      const objects = yield* WebhookRecoveryObjectStore;
      const listed = yield* objects.list(cursor);
      const candidates: WebhookEventQueueMessage[] = [];
      let invalidObjectCount = 0;
      for (const object of listed.objects) {
        const message = messageFromObject(object);
        const uploadedAtMilliseconds = Date.parse(object.uploadedAt);
        if (message === null || !Number.isFinite(uploadedAtMilliseconds)) {
          invalidObjectCount += 1;
          continue;
        }
        if (
          uploadedAtMilliseconds <=
          observedAtMilliseconds - recoveryGraceMilliseconds
        ) {
          candidates.push(message);
        }
      }

      const persistence = yield* WebhookRecoveryPersistence;
      const unclaimed = yield* persistence.filterUnclaimed(candidates);
      const queue = yield* WebhookIngressQueue;
      for (const message of unclaimed) {
        yield* queue.publish(message);
      }
      yield* checkpoint.save(listed.cursor);
      const telemetry = yield* SafeTelemetry;
      yield* telemetry.emit({
        candidateCount: candidates.length,
        enqueuedCount: unclaimed.length,
        event: "webhook_ingress.recovery.completed",
        invalidObjectCount,
        service: "api",
      });
    }).pipe(Effect.provide(layer)),
  );
