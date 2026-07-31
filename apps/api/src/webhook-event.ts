import type {
  ProjectConnectionStateInput,
  QuarantineWebhookItemInput,
  WebhookEventProcessingMaterial,
  WebhookItemProjectionOutcome,
  WebhookVersionComparison,
} from "@whatsapp-mcp/db/webhook-event";
import {
  type ConvergenceVersion,
  importWebhookIdentityKey,
  makeWasenderWebhookNormalization,
  type NormalizedWebhookItem,
  type WebhookNormalization,
} from "@whatsapp-mcp/wasender/webhook";
import { Context, Data, Effect, Layer } from "effect";
import {
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";
import type { WebhookIngressQueueMessage } from "./webhook-ingress";

export type WebhookEventQueueMessage = WebhookIngressQueueMessage;

export class WebhookEventPersistenceError extends Data.TaggedError(
  "WebhookEventPersistenceError",
) {}

export class WebhookEventObjectStoreError extends Data.TaggedError(
  "WebhookEventObjectStoreError",
) {}

export class WebhookEventNormalizationError extends Data.TaggedError(
  "WebhookEventNormalizationError",
) {}

export interface WebhookEventPersistenceService {
  readonly complete: (input: {
    readonly completedAt: string;
    readonly eventId: string;
    readonly personalAccountId: string;
    readonly whatsappConnectionId: string;
  }) => Effect.Effect<void, WebhookEventPersistenceError>;
  readonly prepare: (input: {
    readonly ciphertextSha256: string;
    readonly eventId: string;
    readonly payloadBytes: number;
    readonly personalAccountId: string;
    readonly receivedAt: string;
    readonly whatsappConnectionId: string;
  }) => Effect.Effect<
    WebhookEventProcessingMaterial | null,
    WebhookEventPersistenceError
  >;
  readonly projectConnectionState: (
    input: ProjectConnectionStateInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Effect.Effect<
    WebhookItemProjectionOutcome,
    WebhookEventPersistenceError
  >;
  readonly quarantine: (
    input: QuarantineWebhookItemInput,
  ) => Effect.Effect<void, WebhookEventPersistenceError>;
}

export const WebhookEventPersistence =
  Context.GenericTag<WebhookEventPersistenceService>(
    "@whatsapp-mcp/api/WebhookEventPersistence",
  );

export interface WebhookEventStoredObject {
  readonly body: Uint8Array;
  readonly customMetadata: Readonly<Record<string, string>>;
}

export interface WebhookEventObjectStoreService {
  readonly load: (
    objectId: string,
  ) => Effect.Effect<
    WebhookEventStoredObject | null,
    WebhookEventObjectStoreError
  >;
}

export const WebhookEventObjectStore =
  Context.GenericTag<WebhookEventObjectStoreService>(
    "@whatsapp-mcp/api/WebhookEventObjectStore",
  );

export interface WebhookEventClockService {
  readonly now: Effect.Effect<string>;
}

export const WebhookEventClock = Context.GenericTag<WebhookEventClockService>(
  "@whatsapp-mcp/api/WebhookEventClock",
);

export interface WebhookEventNormalizationService {
  readonly make: (
    identityKey: Uint8Array,
  ) => Effect.Effect<WebhookNormalization, WebhookEventNormalizationError>;
}

export const WebhookEventNormalization =
  Context.GenericTag<WebhookEventNormalizationService>(
    "@whatsapp-mcp/api/WebhookEventNormalization",
  );

export const wasenderWebhookEventNormalizationLayer = Layer.succeed(
  WebhookEventNormalization,
  {
    make: (identityKey) =>
      importWebhookIdentityKey(identityKey).pipe(
        Effect.map(makeWasenderWebhookNormalization),
        Effect.mapError(() => new WebhookEventNormalizationError()),
      ),
  },
);

export type WebhookEventRequirements =
  | EnvelopeEncryption
  | SafeTelemetryService
  | WebhookEventClockService
  | WebhookEventNormalizationService
  | WebhookEventObjectStoreService
  | WebhookEventPersistenceService;

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );

const utcTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isWebhookEventQueueMessage = (
  value: unknown,
): value is WebhookEventQueueMessage =>
  isRecord(value) &&
  value.version === 1 &&
  uuid(value.object_id) &&
  uuid(value.personal_account_id) &&
  uuid(value.whatsapp_connection_id) &&
  typeof value.ciphertext_sha256 === "string" &&
  /^[a-f0-9]{64}$/u.test(value.ciphertext_sha256) &&
  typeof value.payload_bytes === "number" &&
  Number.isSafeInteger(value.payload_bytes) &&
  value.payload_bytes >= 1 &&
  value.payload_bytes <= 1_048_576 &&
  utcTimestamp(value.received_at) &&
  Object.keys(value).length === 7;

const sha256Hex = (value: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );

const decodeBase64 = (value: unknown): Uint8Array | null => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    return null;
  }
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const parseCiphertext = (
  value: Uint8Array,
): {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
} | null => {
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(value),
    ) as unknown;
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).sort().join(",") !==
        "ciphertext,key_version,nonce,version" ||
      parsed.version !== 1 ||
      typeof parsed.key_version !== "number" ||
      !Number.isSafeInteger(parsed.key_version) ||
      parsed.key_version < 1 ||
      typeof parsed.ciphertext !== "string" ||
      typeof parsed.nonce !== "string" ||
      decodeBase64(parsed.ciphertext) === null ||
      decodeBase64(parsed.nonce)?.byteLength !== 12
    ) {
      return null;
    }
    return {
      ciphertext: parsed.ciphertext,
      keyVersion: parsed.key_version,
      nonce: parsed.nonce,
      version: 1,
    };
  } catch {
    return null;
  }
};

const withZeroedBytes = <Value, Error, Requirements>(
  bytes: Uint8Array,
  use: (value: Uint8Array) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.acquireUseRelease(Effect.succeed(bytes), use, (value) =>
    Effect.sync(() => {
      value.fill(0);
    }),
  );

const validateSource = (
  message: WebhookEventQueueMessage,
  source: WebhookEventStoredObject,
) =>
  Effect.gen(function* () {
    const metadata = source.customMetadata;
    const sourceHash = yield* sha256Hex(source.body);
    if (
      metadata.ciphertextSha256 !== message.ciphertext_sha256 ||
      metadata.payloadBytes !== String(message.payload_bytes) ||
      metadata.personalAccountId !== message.personal_account_id ||
      metadata.receivedAt !== message.received_at ||
      metadata.version !== "1" ||
      metadata.whatsappConnectionId !== message.whatsapp_connection_id ||
      Object.keys(metadata).length !== 6 ||
      sourceHash !== message.ciphertext_sha256
    ) {
      return yield* Effect.fail(new WebhookEventObjectStoreError());
    }
    const ciphertext = parseCiphertext(source.body);
    if (ciphertext === null) {
      return yield* Effect.fail(new WebhookEventObjectStoreError());
    }
    return ciphertext;
  });

const quarantine = (
  message: WebhookEventQueueMessage,
  item: NormalizedWebhookItem,
  classification:
    | QuarantineWebhookItemInput["classification"]
    | "unsupported_projection",
) =>
  Effect.gen(function* () {
    const persistence = yield* WebhookEventPersistence;
    yield* persistence.quarantine({
      classification,
      eventId: message.object_id,
      itemIdentity:
        item.kind === "malformed" || item.kind === "unsupported"
          ? null
          : item.itemIdentity,
      itemIndex: item.itemIndex ?? -1,
      itemKind: item.kind,
      personalAccountId: message.personal_account_id,
      receivedAt: message.received_at,
      whatsappConnectionId: message.whatsapp_connection_id,
    });
  });

interface ProcessingCounts {
  readonly appliedCount: number;
  readonly duplicateCount: number;
  readonly quarantinedCount: number;
  readonly supersededCount: number;
}

const emptyCounts = (): ProcessingCounts => ({
  appliedCount: 0,
  duplicateCount: 0,
  quarantinedCount: 0,
  supersededCount: 0,
});

const increment = (
  counts: ProcessingCounts,
  field: keyof ProcessingCounts,
): ProcessingCounts => ({ ...counts, [field]: counts[field] + 1 });

const processItems = (
  message: WebhookEventQueueMessage,
  normalizer: WebhookNormalization,
  items: ReadonlyArray<NormalizedWebhookItem>,
) =>
  Effect.gen(function* () {
    const persistence = yield* WebhookEventPersistence;
    let counts = emptyCounts();
    for (const item of items) {
      if (item.kind === "malformed" || item.kind === "unsupported") {
        yield* quarantine(message, item, item.classification);
        counts = increment(counts, "quarantinedCount");
        continue;
      }
      if (item.kind !== "connection_state") {
        yield* quarantine(message, item, "unsupported_projection");
        counts = increment(counts, "quarantinedCount");
        continue;
      }
      const outcome = yield* persistence.projectConnectionState(
        {
          eventId: message.object_id,
          evidence: {
            occurredAt: item.evidence.occurredAt,
            version: item.evidence.version,
          },
          itemIdentity: item.itemIdentity,
          itemIndex: item.itemIndex,
          personalAccountId: message.personal_account_id,
          receivedAt: message.received_at,
          state: item.state,
          whatsappConnectionId: message.whatsapp_connection_id,
        },
        (left, right) =>
          Effect.runPromise(
            normalizer.compareVersions({
              left: left as ConvergenceVersion,
              right: right as ConvergenceVersion,
            }),
          ),
      );
      counts = increment(
        counts,
        outcome === "applied"
          ? "appliedCount"
          : outcome === "duplicate"
            ? "duplicateCount"
            : "supersededCount",
      );
    }
    return counts;
  });

const processMessage = (message: WebhookEventQueueMessage) =>
  Effect.gen(function* () {
    const objects = yield* WebhookEventObjectStore;
    const source = yield* objects.load(message.object_id);
    if (source === null) {
      return yield* Effect.fail(new WebhookEventObjectStoreError());
    }
    const sourceCiphertext = yield* validateSource(message, source);
    const persistence = yield* WebhookEventPersistence;
    const material = yield* persistence.prepare({
      ciphertextSha256: message.ciphertext_sha256,
      eventId: message.object_id,
      payloadBytes: message.payload_bytes,
      personalAccountId: message.personal_account_id,
      receivedAt: message.received_at,
      whatsappConnectionId: message.whatsapp_connection_id,
    });
    if (material === null) {
      return yield* Effect.fail(new WebhookEventPersistenceError());
    }
    const encryption = yield* EnvelopeEncryptionService;
    const payload = yield* encryption.decrypt({
      accountKey: material.accountKey,
      ciphertext: sourceCiphertext,
      connectionKey: material.connectionKey,
      context: {
        accountId: message.personal_account_id,
        connectionId: message.whatsapp_connection_id,
        entity: "webhook-event",
        fieldOrObjectPurpose: "original-request",
        recordId: message.object_id,
      },
    });
    return yield* withZeroedBytes(payload, (payloadBytes) =>
      Effect.gen(function* () {
        if (payloadBytes.byteLength !== message.payload_bytes) {
          return yield* Effect.fail(new WebhookEventObjectStoreError());
        }
        const identityKey = yield* encryption.decrypt({
          accountKey: material.accountKey,
          ciphertext: material.identityKey,
          connectionKey: material.connectionKey,
          context: {
            accountId: message.personal_account_id,
            connectionId: message.whatsapp_connection_id,
            entity: "whatsapp-connection",
            fieldOrObjectPurpose: "webhook-identity-key",
            recordId: message.whatsapp_connection_id,
          },
        });
        return yield* withZeroedBytes(identityKey, (identityKeyBytes) =>
          Effect.gen(function* () {
            const normalization = yield* WebhookEventNormalization;
            const normalizer = yield* normalization.make(identityKeyBytes);
            const delivery = yield* normalizer.normalize({
              payload: payloadBytes,
              receivedAt: message.received_at,
            });
            const counts = yield* processItems(
              message,
              normalizer,
              delivery.items,
            );
            const clock = yield* WebhookEventClock;
            yield* persistence.complete({
              completedAt: yield* clock.now,
              eventId: message.object_id,
              personalAccountId: message.personal_account_id,
              whatsappConnectionId: message.whatsapp_connection_id,
            });
            return counts;
          }),
        );
      }),
    );
  });

const emit = (
  counts: ProcessingCounts,
  outcome: "completed" | "invalid_message" | "retry",
) =>
  Effect.gen(function* () {
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      ...counts,
      event: "webhook_event.processing.completed",
      outcome,
      service: "api",
    });
  });

export const handleWebhookEventBatch = (
  batch: MessageBatch,
  layer: Layer.Layer<WebhookEventRequirements, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.forEach(
      batch.messages,
      (queued) => {
        if (!isWebhookEventQueueMessage(queued.body)) {
          return emit(emptyCounts(), "invalid_message").pipe(
            Effect.tap(() => Effect.sync(() => queued.ack())),
          );
        }
        return processMessage(queued.body).pipe(
          Effect.flatMap((counts) => emit(counts, "completed")),
          Effect.tap(() => Effect.sync(() => queued.ack())),
          Effect.catchAll(() =>
            emit(emptyCounts(), "retry").pipe(
              Effect.tap(() =>
                Effect.sync(() => queued.retry({ delaySeconds: 10_800 })),
              ),
            ),
          ),
        );
      },
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.provide(layer)),
  );
