import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import { decodeBase64 } from "./base64-url";
import {
  type EncryptionError,
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import { hasFailureTag } from "./failure-tag";
import { noStoreJsonResponse } from "./http-response";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const PERSONAL_ACCOUNT_ROUTE = "/v1/personal-account/bootstrap";

export class PersonalAccountPersistenceError extends Data.TaggedError(
  "PersonalAccountPersistenceError",
) {}

export class PersonalAccountNotAccessible extends Data.TaggedError(
  "PersonalAccountNotAccessible",
) {}

export interface PersonalAccountPersistenceService {
  readonly create: (input: {
    readonly clerkUserId: string;
    readonly keyCiphertext: Uint8Array;
    readonly keyVersion: number;
    readonly kmsKeyId: string;
    readonly personalAccountId: string;
  }) => Effect.Effect<
    {
      readonly admissionState: "active";
      readonly created: boolean;
      readonly messageRetentionDays: number;
      readonly personalAccountId: string;
      readonly storedMediaLimitBytes: number;
      readonly whatsappConnectionLimit: number;
    } | null,
    PersonalAccountPersistenceError
  >;
  readonly resolve: (clerkUserId: string) => Effect.Effect<
    {
      readonly admissionState: "active";
      readonly keyAvailable: boolean;
      readonly messageRetentionDays: number;
      readonly personalAccountId: string;
      readonly storedMediaLimitBytes: number;
      readonly whatsappConnectionLimit: number;
    } | null,
    PersonalAccountPersistenceError
  >;
}

export const PersonalAccountPersistence =
  Context.GenericTag<PersonalAccountPersistenceService>(
    "@whatsapp-mcp/api/PersonalAccountPersistence",
  );

export interface PersonalAccountIdentifiersService {
  readonly next: Effect.Effect<string>;
}

export const PersonalAccountIdentifiers =
  Context.GenericTag<PersonalAccountIdentifiersService>(
    "@whatsapp-mcp/api/PersonalAccountIdentifiers",
  );

export type PersonalAccountRequirements =
  | EnvelopeEncryption
  | HumanIdentityService
  | PersonalAccountIdentifiersService
  | PersonalAccountPersistenceService
  | SafeTelemetryService;

interface ActiveBootstrapResult {
  readonly admissionState: "active";
  readonly messageRetentionDays: number;
  readonly outcome: "created" | "recovered";
  readonly storedMediaLimitBytes: number;
  readonly whatsappConnectionLimit: number;
}

type BootstrapResult = ActiveBootstrapResult;

export const bootstrapPersonalAccount = (
  clerkUserId: string,
): Effect.Effect<
  BootstrapResult,
  | EncryptionError
  | PersonalAccountNotAccessible
  | PersonalAccountPersistenceError,
  | EnvelopeEncryption
  | PersonalAccountIdentifiersService
  | PersonalAccountPersistenceService
> =>
  Effect.gen(function* () {
    const persistence = yield* PersonalAccountPersistence;
    const resolved = yield* persistence.resolve(clerkUserId);
    if (resolved?.admissionState === "active" && resolved.keyAvailable) {
      return {
        admissionState: "active",
        messageRetentionDays: resolved.messageRetentionDays,
        outcome: "recovered",
        storedMediaLimitBytes: resolved.storedMediaLimitBytes,
        whatsappConnectionLimit: resolved.whatsappConnectionLimit,
      } as const;
    }
    const identifiers = yield* PersonalAccountIdentifiers;
    const personalAccountId =
      resolved?.admissionState === "active"
        ? resolved.personalAccountId
        : yield* identifiers.next;
    const encryption = yield* EnvelopeEncryptionService;
    const envelope = yield* encryption.createPersonalAccountKey({
      accountId: personalAccountId,
      keyVersion: 1,
    });
    const result = yield* persistence.create({
      clerkUserId,
      keyCiphertext: decodeBase64(envelope.ciphertext),
      keyVersion: envelope.keyVersion,
      kmsKeyId: envelope.kmsKeyId,
      personalAccountId,
    });
    if (result === null) {
      return yield* Effect.fail(new PersonalAccountNotAccessible());
    }
    return {
      admissionState: "active",
      messageRetentionDays: result.messageRetentionDays,
      outcome: result.created ? ("created" as const) : ("recovered" as const),
      storedMediaLimitBytes: result.storedMediaLimitBytes,
      whatsappConnectionLimit: result.whatsappConnectionLimit,
    };
  });

const corsHeaders = (browserOrigin: string) => ({
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
  noStoreJsonResponse(
    body,
    status,
    browserOrigin === undefined ? {} : corsHeaders(browserOrigin),
  );

const notFound = (browserOrigin?: string): Response =>
  jsonResponse({ error: "not_found" }, 404, browserOrigin);

export const createPersonalAccountHandler =
  (
    layer: Layer.Layer<PersonalAccountRequirements, unknown>,
    browserOrigin: string,
  ) =>
  (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.pathname !== PERSONAL_ACCOUNT_ROUTE ||
      request.headers.get("origin") !== browserOrigin
    ) {
      return Promise.resolve(notFound());
    }
    if (request.method === "OPTIONS") {
      return Promise.resolve(
        new Response(null, {
          headers: corsHeaders(browserOrigin),
          status: 204,
        }),
      );
    }
    if (request.method !== "POST") {
      return Promise.resolve(notFound(browserOrigin));
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* HumanIdentity;
        const clerkUserId = yield* identity.verify(request);
        const result = yield* bootstrapPersonalAccount(clerkUserId);
        const telemetry = yield* SafeTelemetry;
        yield* telemetry.emit({
          event: "personal_account.bootstrap.completed",
          outcome: result.outcome,
          service: "api",
        });
        return result;
      }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            hasFailureTag(
              failure,
              "InvalidHumanIdentity",
              "PersonalAccountNotAccessible",
            )
              ? notFound(browserOrigin)
              : jsonResponse({ error: "unavailable" }, 503, browserOrigin),
          onSuccess: (result) =>
            jsonResponse(
              {
                personal_account: {
                  message_retention_days: result.messageRetentionDays,
                  state: "active",
                  stored_media_limit_bytes: result.storedMediaLimitBytes,
                  whatsapp_connection_limit: result.whatsappConnectionLimit,
                },
              },
              200,
              browserOrigin,
            ),
        }),
      ),
    );
  };

export const isPersonalAccountRequest = (request: Request): boolean =>
  new URL(request.url).pathname === PERSONAL_ACCOUNT_ROUTE;
