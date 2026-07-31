import { IdempotencyKey } from "@whatsapp-mcp/contracts/handles";
import type {
  PreparedConnectionSetup,
  StartConnectionSetupInput,
  StartedConnectionSetup,
} from "@whatsapp-mcp/db/connection-setup";
import {
  connectionSetupExpiresAt,
  normalizeWhatsAppNumber,
} from "@whatsapp-mcp/domain/connection-setup";
import { Context, Data, Effect, type Layer, Schema } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import {
  ConnectionSetupProvisioningQueue,
  type ConnectionSetupProvisioningQueueError,
  type ConnectionSetupProvisioningQueueService,
} from "./connection-setup-provisioning";
import {
  type EncryptionError,
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const CONNECTION_SETUP_ROUTE = "/v1/connection-setups";

export class ConnectionSetupPersistenceError extends Data.TaggedError(
  "ConnectionSetupPersistenceError",
) {}

export class ConnectionSetupNotAccessible extends Data.TaggedError(
  "ConnectionSetupNotAccessible",
) {}

export class ConnectionSetupTokenError extends Data.TaggedError(
  "ConnectionSetupTokenError",
) {}

export interface ConnectionSetupPersistenceService {
  readonly prepare: (input: {
    readonly clerkUserId: string;
    readonly idempotencyKey: string;
    readonly numberToken: Uint8Array;
  }) => Effect.Effect<
    PreparedConnectionSetup | null,
    ConnectionSetupPersistenceError
  >;
  readonly start: (
    input: StartConnectionSetupInput,
  ) => Effect.Effect<StartedConnectionSetup, ConnectionSetupPersistenceError>;
}

export const ConnectionSetupPersistence =
  Context.GenericTag<ConnectionSetupPersistenceService>(
    "@whatsapp-mcp/api/ConnectionSetupPersistence",
  );

export interface ConnectionSetupIdentifiersService {
  readonly next: Effect.Effect<string>;
}

export const ConnectionSetupIdentifiers =
  Context.GenericTag<ConnectionSetupIdentifiersService>(
    "@whatsapp-mcp/api/ConnectionSetupIdentifiers",
  );

export interface ConnectionSetupClockService {
  readonly now: Effect.Effect<string>;
}

export const ConnectionSetupClock =
  Context.GenericTag<ConnectionSetupClockService>(
    "@whatsapp-mcp/api/ConnectionSetupClock",
  );

export interface ConnectionSetupNumberTokensService {
  readonly derive: (
    normalizedWhatsAppNumber: string,
  ) => Effect.Effect<Uint8Array, ConnectionSetupTokenError>;
}

export const ConnectionSetupNumberTokens =
  Context.GenericTag<ConnectionSetupNumberTokensService>(
    "@whatsapp-mcp/api/ConnectionSetupNumberTokens",
  );

export type ConnectionSetupRequirements =
  | ConnectionSetupClockService
  | ConnectionSetupIdentifiersService
  | ConnectionSetupNumberTokensService
  | ConnectionSetupPersistenceService
  | ConnectionSetupProvisioningQueueService
  | EnvelopeEncryption
  | HumanIdentityService
  | SafeTelemetryService;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;

export const makeConnectionSetupNumberTokens = (
  secret: Uint8Array,
): ConnectionSetupNumberTokensService => {
  const importedKey = crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );

  return {
    derive: (normalizedWhatsAppNumber) =>
      Effect.tryPromise({
        try: async () =>
          new Uint8Array(
            await crypto.subtle.sign(
              "HMAC",
              await importedKey,
              new TextEncoder().encode(
                `whatsapp-number-reservation:v1\u0000${normalizedWhatsAppNumber}`,
              ),
            ),
          ),
        catch: () => new ConnectionSetupTokenError(),
      }),
  };
};

const decodeBase64 = (value: string): Uint8Array => {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

type ConnectionSetupOutcome =
  | {
      readonly outcome: "created" | "replay";
      readonly setup: {
        readonly createdAt: string;
        readonly expiresAt: string;
        readonly setupId: string;
        readonly state:
          | "provisioned"
          | "provisioning_failed"
          | "provisioning_pending"
          | "provisioning_quarantined";
      };
    }
  | {
      readonly outcome:
        | "connection_limit_reached"
        | "idempotency_conflict"
        | "number_unavailable";
    };

export const startConnectionSetup = (
  clerkUserId: string,
  idempotencyKey: string,
  normalizedWhatsAppNumber: string,
): Effect.Effect<
  ConnectionSetupOutcome,
  | ConnectionSetupNotAccessible
  | ConnectionSetupPersistenceError
  | ConnectionSetupTokenError
  | ConnectionSetupProvisioningQueueError
  | EncryptionError,
  | ConnectionSetupClockService
  | ConnectionSetupIdentifiersService
  | ConnectionSetupNumberTokensService
  | ConnectionSetupPersistenceService
  | ConnectionSetupProvisioningQueueService
  | EnvelopeEncryption
> =>
  Effect.gen(function* () {
    const tokenService = yield* ConnectionSetupNumberTokens;
    const numberToken = yield* tokenService.derive(normalizedWhatsAppNumber);
    const persistence = yield* ConnectionSetupPersistence;
    const prepared = yield* persistence.prepare({
      clerkUserId,
      idempotencyKey,
      numberToken,
    });
    if (prepared === null) {
      return yield* Effect.fail(new ConnectionSetupNotAccessible());
    }
    const result =
      prepared.outcome !== "unbound"
        ? prepared
        : yield* Effect.gen(function* () {
            const identifiers = yield* ConnectionSetupIdentifiers;
            const setupId = yield* identifiers.next;
            const clock = yield* ConnectionSetupClock;
            const createdAt = yield* clock.now;
            if (connectionSetupExpiresAt(createdAt) === null) {
              return yield* Effect.fail(new ConnectionSetupPersistenceError());
            }

            const encryption = yield* EnvelopeEncryptionService;
            const connectionKey = yield* encryption.createConnectionKey({
              accountId: prepared.accountKey.personalAccountId,
              accountKey: prepared.accountKey,
              connectionId: setupId,
              keyVersion: 1,
            });
            const numberCiphertext = yield* encryption.encrypt({
              accountKey: prepared.accountKey,
              connectionKey,
              context: {
                accountId: prepared.accountKey.personalAccountId,
                connectionId: setupId,
                entity: "connection-setup",
                fieldOrObjectPurpose: "whatsapp-number",
                recordId: setupId,
              },
              plaintext: new TextEncoder().encode(normalizedWhatsAppNumber),
            });

            return yield* persistence.start({
              accountKeyVersion: connectionKey.accountKeyVersion,
              connectionKeyCiphertext: decodeBase64(connectionKey.ciphertext),
              connectionKeyNonce: decodeBase64(connectionKey.nonce),
              connectionKeyVersion: connectionKey.keyVersion,
              createdAt,
              idempotencyKey,
              numberCiphertext: decodeBase64(numberCiphertext.ciphertext),
              numberCiphertextNonce: decodeBase64(numberCiphertext.nonce),
              numberCiphertextVersion: numberCiphertext.version,
              numberKeyVersion: numberCiphertext.keyVersion,
              numberToken,
              personalAccountId: prepared.accountKey.personalAccountId,
              setupId,
            });
          });
    if ("setup" in result) {
      const queue = yield* ConnectionSetupProvisioningQueue;
      yield* queue.enqueue(result.setup.setupId);
    }
    return result;
  });

const corsHeaders = (browserOrigin: string): HeadersInit => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "OPTIONS,POST",
  "access-control-allow-origin": browserOrigin,
  vary: "Origin",
});

const jsonResponse = (
  body: unknown,
  status: number,
  browserOrigin?: string,
): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      ...(browserOrigin === undefined ? {} : corsHeaders(browserOrigin)),
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });

const notFound = (browserOrigin?: string): Response =>
  jsonResponse({ error: "not_found" }, 404, browserOrigin);

const decodeRequest = async (
  request: Request,
): Promise<{
  readonly idempotencyKey: string;
  readonly normalizedWhatsAppNumber: string;
} | null> => {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  ) {
    return null;
  }
  const body = value as Record<string, unknown>;
  const normalizedWhatsAppNumber = normalizeWhatsAppNumber(
    body.whatsapp_number,
  );
  if (
    typeof body.idempotency_key !== "string" ||
    normalizedWhatsAppNumber === null
  ) {
    return null;
  }
  try {
    Schema.decodeUnknownSync(IdempotencyKey)(body.idempotency_key);
  } catch {
    return null;
  }
  return {
    idempotencyKey: body.idempotency_key,
    normalizedWhatsAppNumber,
  };
};

const successResponse = (
  result: Extract<ConnectionSetupOutcome, { readonly setup: unknown }>,
  browserOrigin: string,
): Response =>
  jsonResponse(
    {
      connection_setup: {
        created_at: result.setup.createdAt,
        expires_at: result.setup.expiresAt,
        id: result.setup.setupId,
        idempotent_replay: result.outcome === "replay",
        state:
          result.setup.state === "provisioning_pending"
            ? "pending"
            : result.setup.state,
      },
    },
    result.outcome === "created" ? 201 : 200,
    browserOrigin,
  );

export const createConnectionSetupHandler =
  (
    layer: Layer.Layer<ConnectionSetupRequirements, unknown>,
    browserOrigin: string,
  ) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.pathname !== CONNECTION_SETUP_ROUTE ||
      request.headers.get("origin") !== browserOrigin
    ) {
      return notFound();
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(browserOrigin),
        status: 204,
      });
    }
    if (request.method !== "POST") {
      return notFound(browserOrigin);
    }

    const input = await decodeRequest(request);
    if (input === null) {
      return jsonResponse({ error: "invalid_request" }, 400, browserOrigin);
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* HumanIdentity;
        const clerkUserId = yield* identity.verify(request);
        const result = yield* startConnectionSetup(
          clerkUserId,
          input.idempotencyKey,
          input.normalizedWhatsAppNumber,
        );
        const telemetry = yield* SafeTelemetry;
        yield* telemetry.emit({
          event: "connection_setup.start.completed",
          outcome: result.outcome,
          service: "api",
        });
        return result;
      }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            typeof failure === "object" &&
            failure !== null &&
            "_tag" in failure &&
            (failure._tag === "InvalidHumanIdentity" ||
              failure._tag === "ConnectionSetupNotAccessible")
              ? notFound(browserOrigin)
              : jsonResponse({ error: "unavailable" }, 503, browserOrigin),
          onSuccess: (result) => {
            if ("setup" in result) {
              return successResponse(result, browserOrigin);
            }
            const error =
              result.outcome === "number_unavailable"
                ? "whatsapp_number_unavailable"
                : result.outcome;
            return jsonResponse({ error }, 409, browserOrigin);
          },
        }),
      ),
    );
  };

export const isConnectionSetupRequest = (request: Request): boolean =>
  new URL(request.url).pathname === CONNECTION_SETUP_ROUTE;
