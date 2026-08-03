import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import {
  RestoreSafeDeletion,
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const PRODUCT_ROUTE = "/v1/personal-account";
const CLERK_WEBHOOK_ROUTE = "/v1/webhooks/clerk";

export class PersonalAccountDeletionPersistenceError extends Data.TaggedError(
  "PersonalAccountDeletionPersistenceError",
) {}

export interface PreparedPersonalAccountDeletion {
  readonly connectionPublicIds: ReadonlyArray<string>;
  readonly personalAccountId: string;
  readonly requestedAt: string;
  readonly state: "active" | "deleting";
}

export interface PersonalAccountDeletionPersistenceService {
  readonly finish: (input: {
    readonly clerkUserId: string;
    readonly deletionMarkerId: string;
    readonly requestedAt: string;
  }) => Effect.Effect<boolean, PersonalAccountDeletionPersistenceError>;
  readonly prepare: (input: {
    readonly clerkUserId: string;
    readonly observedAt: string;
  }) => Effect.Effect<
    PreparedPersonalAccountDeletion | null,
    PersonalAccountDeletionPersistenceError
  >;
}

export const PersonalAccountDeletionPersistence =
  Context.GenericTag<PersonalAccountDeletionPersistenceService>(
    "@whatsapp-mcp/api/PersonalAccountDeletionPersistence",
  );

export interface ClerkIdentityAdministrationService {
  readonly deleteUser: (clerkUserId: string) => Effect.Effect<void, unknown>;
}

export const ClerkIdentityAdministration =
  Context.GenericTag<ClerkIdentityAdministrationService>(
    "@whatsapp-mcp/api/ClerkIdentityAdministration",
  );

export interface ClerkDeletionEvent {
  readonly clerkUserId: string;
  readonly type: "ignored" | "user.deleted";
}

export interface ClerkWebhookVerificationService {
  readonly verify: (
    request: Request,
  ) => Effect.Effect<ClerkDeletionEvent, unknown>;
}

export const ClerkWebhookVerification =
  Context.GenericTag<ClerkWebhookVerificationService>(
    "@whatsapp-mcp/api/ClerkWebhookVerification",
  );

type Requirements =
  | ClerkIdentityAdministrationService
  | ClerkWebhookVerificationService
  | HumanIdentityService
  | PersonalAccountDeletionPersistenceService
  | RestoreSafeDeletion
  | SafeTelemetryService;

const response = (body: unknown, status: number, browserOrigin?: string) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    headers: {
      ...(browserOrigin === undefined
        ? {}
        : {
            "access-control-allow-headers": "authorization",
            "access-control-allow-methods": "DELETE,OPTIONS",
            "access-control-allow-origin": browserOrigin,
            vary: "Origin",
          }),
      "cache-control": "no-store",
      ...(status === 204
        ? {}
        : { "content-type": "application/json; charset=utf-8" }),
    },
    status,
  });

export const isPersonalAccountDeletionRequest = (request: Request): boolean => {
  const pathname = new URL(request.url).pathname;
  return pathname === PRODUCT_ROUTE || pathname === CLERK_WEBHOOK_ROUTE;
};

export const createPersonalAccountDeletionHandler = <R>({
  browserOrigin,
  deleteConnection,
  layer,
  now = () => new Date().toISOString(),
}: {
  readonly browserOrigin: string;
  readonly deleteConnection: (
    clerkUserId: string,
    publicId: string,
    requestedAt: string,
  ) => Effect.Effect<void, unknown, R>;
  readonly layer: Layer.Layer<Requirements | R, unknown>;
  readonly now?: () => string;
}) => {
  const begin = (clerkUserId: string) =>
    Effect.gen(function* () {
      const persistence = yield* PersonalAccountDeletionPersistence;
      const prepared = yield* persistence.prepare({
        clerkUserId,
        observedAt: now(),
      });
      if (prepared === null) return false;

      const requestedAt = prepared.requestedAt;
      const deletion = yield* RestoreSafeDeletion;
      const marker = yield* deletion.markers.create({
        deletionKind: "personal_account",
        keyUnavailableAt: requestedAt,
        opaqueEntityId: prepared.personalAccountId,
        requestedAt,
      });
      yield* Effect.forEach(
        prepared.connectionPublicIds,
        (publicId) => deleteConnection(clerkUserId, publicId, requestedAt),
        { concurrency: 1, discard: true },
      );
      return yield* persistence.finish({
        clerkUserId,
        deletionMarkerId: marker.markerId,
        requestedAt: marker.marker.requestedAt,
      });
    });

  const record = (
    outcome: "deleting" | "unknown_identity",
    source: "clerk_webhook" | "product",
  ) =>
    Effect.gen(function* () {
      const telemetry = yield* SafeTelemetry;
      yield* telemetry.emit({
        event: "personal_account.deletion.completed",
        outcome,
        service: "api",
        source,
      });
    });

  return (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if (pathname === PRODUCT_ROUTE && request.method === "OPTIONS") {
      return Promise.resolve(response(null, 204, browserOrigin));
    }
    if (pathname === PRODUCT_ROUTE) {
      if (
        request.method !== "DELETE" ||
        request.headers.get("origin") !== browserOrigin
      ) {
        return Promise.resolve(response({ error: "not_found" }, 404));
      }
      return Effect.runPromise(
        Effect.gen(function* () {
          const identity = yield* HumanIdentity;
          const clerkUserId = yield* identity.verify(request);
          if (!(yield* begin(clerkUserId))) {
            yield* record("unknown_identity", "product");
            return response({ error: "not_found" }, 404, browserOrigin);
          }
          yield* record("deleting", "product");
          const clerk = yield* ClerkIdentityAdministration;
          yield* clerk.deleteUser(clerkUserId);
          return response(
            { personal_account: { state: "deleting" } },
            202,
            browserOrigin,
          );
        }).pipe(
          Effect.provide(layer),
          Effect.catchAll(() =>
            Effect.succeed(
              response({ error: "unavailable" }, 503, browserOrigin),
            ),
          ),
        ),
      );
    }
    if (pathname === CLERK_WEBHOOK_ROUTE && request.method === "POST") {
      return Effect.runPromise(
        Effect.gen(function* () {
          const verifier = yield* ClerkWebhookVerification;
          const event = yield* verifier.verify(request);
          if (event.type === "user.deleted") {
            const deleting = yield* begin(event.clerkUserId);
            yield* record(
              deleting ? "deleting" : "unknown_identity",
              "clerk_webhook",
            );
          }
          return response(null, 204);
        }).pipe(
          Effect.provide(layer),
          Effect.catchAll(() =>
            Effect.succeed(response({ error: "invalid_webhook" }, 400)),
          ),
        ),
      );
    }
    return Promise.resolve(response({ error: "not_found" }, 404));
  };
};
