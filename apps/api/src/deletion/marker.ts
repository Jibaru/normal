import type { DeploymentEnvironment } from "@whatsapp-mcp/domain/deployment";
import { Data, Effect, Redacted } from "effect";

const markerKeyDomain = "whatsapp-mcp/deletion-marker-key/v1";
const markerPrefix = "markers/v1/";
const markerVersion = 1 as const;

export type DeletionKind = "personal_account" | "whatsapp_connection";

export type DeletionOperation =
  | "create-capsule"
  | "create-marker"
  | "decrypt-capsule"
  | "destroy-capsule"
  | "enumerate-markers"
  | "read-capsule"
  | "reconcile-provider";

export class DeletionPrimitiveError extends Data.TaggedError(
  "DeletionPrimitiveError",
)<{
  readonly operation: DeletionOperation;
}> {}

export interface DeletionMarker {
  readonly deletionKind: DeletionKind;
  readonly keyUnavailableAt: string;
  readonly requestedAt: string;
  readonly version: typeof markerVersion;
}

export interface DeletionMarkerReference {
  readonly marker: DeletionMarker;
  readonly markerId: string;
  readonly objectKey: string;
}

export interface DeletionMarkerBucket {
  readonly get: (
    key: string,
  ) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly list: (options: {
    readonly cursor?: string | undefined;
    readonly prefix: string;
  }) => Promise<{
    readonly cursor?: string | undefined;
    readonly objects: ReadonlyArray<{ readonly key: string }>;
    readonly truncated: boolean;
  }>;
  readonly put: (
    key: string,
    value: string,
    options?: {
      readonly onlyIf?: {
        readonly etagDoesNotMatch?: string | undefined;
      };
    },
  ) => Promise<unknown | null>;
}

export interface DeletionObjectBucket extends DeletionMarkerBucket {
  readonly delete: (key: string) => Promise<void>;
}

export interface DeletionMarkerStore {
  readonly create: (input: {
    readonly deletionKind: DeletionKind;
    readonly keyUnavailableAt: string;
    readonly opaqueEntityId: string;
    readonly requestedAt: string;
  }) => Effect.Effect<DeletionMarkerReference, DeletionPrimitiveError>;
  readonly enumerate: () => Effect.Effect<
    ReadonlyArray<DeletionMarkerReference>,
    DeletionPrimitiveError
  >;
}

const operationError = (operation: DeletionOperation) =>
  new DeletionPrimitiveError({ operation });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCanonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  new Date(value).toISOString() === value;

const isDeletionKind = (value: unknown): value is DeletionKind =>
  value === "personal_account" || value === "whatsapp_connection";

const parseMarker = (value: string): DeletionMarker => {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "deletionKind,keyUnavailableAt,requestedAt,version" ||
    parsed.version !== markerVersion ||
    !isDeletionKind(parsed.deletionKind) ||
    !isCanonicalTimestamp(parsed.requestedAt) ||
    !isCanonicalTimestamp(parsed.keyUnavailableAt) ||
    parsed.keyUnavailableAt < parsed.requestedAt
  ) {
    throw operationError("enumerate-markers");
  }
  return {
    deletionKind: parsed.deletionKind,
    keyUnavailableAt: parsed.keyUnavailableAt,
    requestedAt: parsed.requestedAt,
    version: markerVersion,
  };
};

const serializeMarker = (marker: DeletionMarker) =>
  JSON.stringify({
    deletionKind: marker.deletionKind,
    keyUnavailableAt: marker.keyUnavailableAt,
    requestedAt: marker.requestedAt,
    version: marker.version,
  });

const decodeHex = (value: string): Uint8Array => {
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw operationError("create-marker");
  }
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
};

const toHex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const markerIdFor = async (
  environment: DeploymentEnvironment,
  hmacSecret: Redacted.Redacted<string>,
  deletionKind: DeletionKind,
  opaqueEntityId: string,
) => {
  if (opaqueEntityId.length === 0 || opaqueEntityId.length > 1024) {
    throw operationError("create-marker");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    decodeHex(Redacted.value(hmacSecret)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const authenticatedIdentity = new TextEncoder().encode(
    `${markerKeyDomain}\u0000${environment}\u0000${deletionKind}\u0000${opaqueEntityId}`,
  );
  return toHex(await crypto.subtle.sign("HMAC", key, authenticatedIdentity));
};

const markerIdFromObjectKey = (objectKey: string): string => {
  const match = /^markers\/v1\/([a-f0-9]{64})\.json$/u.exec(objectKey);
  if (!match?.[1]) throw operationError("enumerate-markers");
  return match[1];
};

export const makeDeletionMarkerStore = ({
  bucket,
  environment,
  hmacSecret,
}: {
  readonly bucket: DeletionMarkerBucket;
  readonly environment: DeploymentEnvironment;
  readonly hmacSecret: Redacted.Redacted<string>;
}): DeletionMarkerStore => ({
  create: (input) =>
    Effect.tryPromise({
      try: async () => {
        const marker: DeletionMarker = parseMarker(
          JSON.stringify({
            deletionKind: input.deletionKind,
            keyUnavailableAt: input.keyUnavailableAt,
            requestedAt: input.requestedAt,
            version: markerVersion,
          }),
        );
        const markerId = await markerIdFor(
          environment,
          hmacSecret,
          input.deletionKind,
          input.opaqueEntityId,
        );
        const objectKey = `${markerPrefix}${markerId}.json`;
        const body = serializeMarker(marker);
        const stored = await bucket.put(objectKey, body, {
          onlyIf: { etagDoesNotMatch: "*" },
        });
        if (stored === null) {
          const existing = await bucket.get(objectKey);
          if (!existing) {
            throw operationError("create-marker");
          }
          const existingMarker = parseMarker(await existing.text());
          if (existingMarker.deletionKind !== input.deletionKind) {
            throw operationError("create-marker");
          }
          return { marker: existingMarker, markerId, objectKey };
        }
        return { marker, markerId, objectKey };
      },
      catch: () => operationError("create-marker"),
    }),
  enumerate: () =>
    Effect.tryPromise({
      try: async () => {
        const markers: DeletionMarkerReference[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await bucket.list({ cursor, prefix: markerPrefix });
          for (const object of page.objects) {
            const markerId = markerIdFromObjectKey(object.key);
            const stored = await bucket.get(object.key);
            if (!stored) throw operationError("enumerate-markers");
            markers.push({
              marker: parseMarker(await stored.text()),
              markerId,
              objectKey: object.key,
            });
          }
          if (page.truncated) {
            if (!page.cursor || seenCursors.has(page.cursor)) {
              throw operationError("enumerate-markers");
            }
            seenCursors.add(page.cursor);
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return markers;
      },
      catch: () => operationError("enumerate-markers"),
    }),
});
