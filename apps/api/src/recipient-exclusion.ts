import type {
  EncryptedRecipientRecord,
  PreparedRecipientTransition,
  RecipientDirectoryMaterial,
  RecipientExclusionState,
  RecipientKind,
} from "@whatsapp-mcp/db/recipient-exclusion";
import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import { hasFailureTag } from "./failure-tag";
import { noStoreJsonResponse } from "./http-response";
import { hasExactKeys } from "./record";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const listPattern =
  /^\/v1\/whatsapp-connections\/(con_[A-Za-z0-9_-]{21})\/recipients$/u;
const exclusionPattern =
  /^\/v1\/whatsapp-connections\/(con_[A-Za-z0-9_-]{21})\/recipients\/((?:ctc|grp)_[A-Za-z0-9_-]{21})\/exclusion$/u;

const maximumPageSize = 50;

export class RecipientExclusionPersistenceError extends Data.TaggedError(
  "RecipientExclusionPersistenceError",
) {}

class RecipientExclusionNotAccessible extends Data.TaggedError(
  "RecipientExclusionNotAccessible",
) {}

class RecipientExclusionConflict extends Data.TaggedError(
  "RecipientExclusionConflict",
) {}

export interface OpenRecipientRecord {
  readonly displayName: string | null;
  readonly excluded: boolean;
  readonly phoneLastFour: string | null;
  readonly publicId: string;
}

export interface RecipientExclusionPersistenceService {
  readonly finalize: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
    readonly observedAt: string;
    readonly recipientPublicId: string;
    readonly transitionId: string;
  }) => Effect.Effect<
    RecipientExclusionState | null,
    RecipientExclusionPersistenceError
  >;
  readonly list: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
    readonly cursorPublicId: string | null;
    readonly kind: RecipientKind;
    readonly limit: number;
    readonly search: string | null;
  }) => Effect.Effect<
    {
      readonly material: RecipientDirectoryMaterial;
      readonly recipients: ReadonlyArray<EncryptedRecipientRecord>;
    } | null,
    RecipientExclusionPersistenceError
  >;
  readonly open: (input: {
    readonly material: RecipientDirectoryMaterial;
    readonly kind: RecipientKind;
    readonly recipients: ReadonlyArray<EncryptedRecipientRecord>;
  }) => Effect.Effect<
    ReadonlyArray<OpenRecipientRecord>,
    RecipientExclusionPersistenceError
  >;
  readonly prepare: (input: {
    readonly clerkUserId: string;
    readonly connectionPublicId: string;
    readonly excluded: boolean;
    readonly expectedExcluded: boolean;
    readonly idempotencyKey: string;
    readonly recipientPublicId: string;
  }) => Effect.Effect<
    PreparedRecipientTransition | null,
    RecipientExclusionPersistenceError
  >;
}

export const RecipientExclusionPersistence =
  Context.GenericTag<RecipientExclusionPersistenceService>(
    "@whatsapp-mcp/api/RecipientExclusionPersistence",
  );

export interface RecipientTransitionJournalService {
  readonly append: (input: {
    readonly connectionId: string;
    readonly effectiveAt: string;
    readonly excluded: boolean;
    readonly purgeCutoffAt: string | null;
    readonly recipientKind: RecipientKind;
    readonly recipientLocator: string;
    readonly transitionId: string;
  }) => Effect.Effect<void, RecipientExclusionPersistenceError>;
}

export const RecipientTransitionJournal =
  Context.GenericTag<RecipientTransitionJournalService>(
    "@whatsapp-mcp/api/RecipientTransitionJournal",
  );

export interface RecipientExclusionClockService {
  readonly now: Effect.Effect<string>;
}

export const RecipientExclusionClock =
  Context.GenericTag<RecipientExclusionClockService>(
    "@whatsapp-mcp/api/RecipientExclusionClock",
  );

type Requirements =
  | HumanIdentityService
  | RecipientExclusionClockService
  | RecipientExclusionPersistenceService
  | RecipientTransitionJournalService
  | SafeTelemetryService;

const headers = (origin: string) => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,OPTIONS,PUT",
  "access-control-allow-origin": origin,
  vary: "Origin",
});

const json = (body: unknown, status: number, origin?: string) =>
  noStoreJsonResponse(
    body,
    status,
    origin === undefined ? {} : headers(origin),
  );

const notFound = (origin?: string) => json({ error: "not_found" }, 404, origin);

interface ListQuery {
  readonly cursorPublicId: string | null;
  readonly kind: RecipientKind;
  readonly limit: number;
  readonly search: string | null;
}

const parseListQuery = (url: URL): ListQuery | "invalid" => {
  const allowed = new Set(["cursor", "kind", "limit", "search"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length > 1) {
      return "invalid";
    }
  }
  const kind = url.searchParams.get("kind");
  if (kind !== "contact" && kind !== "group") return "invalid";
  const cursor = url.searchParams.get("cursor");
  const expectedCursorPrefix = kind === "contact" ? "ctc" : "grp";
  if (
    cursor !== null &&
    !new RegExp(`^${expectedCursorPrefix}_[A-Za-z0-9_-]{21}$`, "u").test(cursor)
  ) {
    return "invalid";
  }
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (
    rawLimit !== null &&
    (!/^[1-9][0-9]?$/u.test(rawLimit) || limit > maximumPageSize)
  ) {
    return "invalid";
  }
  const search = url.searchParams.get("search");
  if (search !== null && (search.length < 3 || search.length > 64)) {
    return "invalid";
  }
  return { cursorPublicId: cursor, kind, limit, search };
};

interface ExclusionBody {
  readonly excluded: boolean;
  readonly expectedExcluded: boolean;
  readonly idempotencyKey: string;
}

const parseExclusionBody = (value: unknown): ExclusionBody | "invalid" => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, [
      "excluded",
      "expected_excluded",
      "idempotency_key",
    ])
  ) {
    return "invalid";
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.excluded !== "boolean" ||
    typeof body.expected_excluded !== "boolean" ||
    typeof body.idempotency_key !== "string" ||
    !/^[A-Za-z0-9._~-]{16,255}$/u.test(body.idempotency_key)
  ) {
    return "invalid";
  }
  return {
    excluded: body.excluded,
    expectedExcluded: body.expected_excluded,
    idempotencyKey: body.idempotency_key,
  };
};

const listRecipients = (
  request: Request,
  browserOrigin: string,
  connectionPublicId: string,
  query: ListQuery,
) =>
  Effect.gen(function* () {
    const identity = yield* HumanIdentity;
    const clerkUserId = yield* identity.verify(request);
    const persistence = yield* RecipientExclusionPersistence;
    const loaded = yield* persistence.list({
      clerkUserId,
      connectionPublicId,
      cursorPublicId: query.cursorPublicId,
      kind: query.kind,
      // One extra row decides whether another page exists.
      limit: query.limit + 1,
      search: query.search,
    });
    if (loaded === null) return yield* new RecipientExclusionNotAccessible();
    const hasMore = loaded.recipients.length > query.limit;
    const opened = yield* persistence.open({
      kind: query.kind,
      material: loaded.material,
      recipients: loaded.recipients.slice(0, query.limit),
    });
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      event: "recipient_exclusion.list.completed",
      outcome: "success",
      recipientCount: opened.length,
      service: "api",
    });
    return json(
      {
        directory: {
          as_of: loaded.material.projection.asOf,
          partial: loaded.material.projection.partial,
          stale: loaded.material.projection.stale,
        },
        next_cursor: hasMore ? (opened.at(-1)?.publicId ?? null) : null,
        recipients: opened.map((recipient) => ({
          display_name: recipient.displayName,
          excluded: recipient.excluded,
          id: recipient.publicId,
          kind: query.kind,
          phone_last_four: recipient.phoneLastFour,
        })),
      },
      200,
      browserOrigin,
    );
  });

const setExclusion = (
  request: Request,
  browserOrigin: string,
  connectionPublicId: string,
  recipientPublicId: string,
  body: ExclusionBody,
) =>
  Effect.gen(function* () {
    const identity = yield* HumanIdentity;
    const clerkUserId = yield* identity.verify(request);
    const persistence = yield* RecipientExclusionPersistence;
    const journal = yield* RecipientTransitionJournal;
    const clock = yield* RecipientExclusionClock;
    const telemetry = yield* SafeTelemetry;
    const prepared = yield* persistence.prepare({
      clerkUserId,
      connectionPublicId,
      excluded: body.excluded,
      expectedExcluded: body.expectedExcluded,
      idempotencyKey: body.idempotencyKey,
      recipientPublicId,
    });
    if (prepared === null) return yield* new RecipientExclusionNotAccessible();
    if (prepared.outcome === "conflict") {
      yield* telemetry.emit({
        event: "recipient_exclusion.transition.completed",
        outcome: "conflict",
        service: "api",
        transitionKind: body.excluded ? "exclude" : "re_enable",
      });
      return yield* new RecipientExclusionConflict();
    }
    if (prepared.outcome === "unchanged" || prepared.transitionId === null) {
      yield* telemetry.emit({
        event: "recipient_exclusion.transition.completed",
        outcome: "unchanged",
        service: "api",
        transitionKind: body.excluded ? "exclude" : "re_enable",
      });
      return json(
        {
          exclusion: {
            effective_at: prepared.effectiveAt,
            excluded: prepared.excluded,
          },
          recipient: { id: recipientPublicId, kind: prepared.recipientKind },
        },
        200,
        browserOrigin,
      );
    }
    // The journal object must be durable before the transition is
    // acknowledged, so an earlier snapshot can never restore access.
    yield* journal.append({
      connectionId: prepared.whatsappConnectionId,
      effectiveAt: prepared.effectiveAt,
      excluded: prepared.excluded,
      purgeCutoffAt: prepared.purgeCutoffAt,
      recipientKind: prepared.recipientKind,
      recipientLocator: prepared.recipientLocator,
      transitionId: prepared.transitionId,
    });
    const state = yield* persistence.finalize({
      clerkUserId,
      connectionPublicId,
      observedAt: yield* clock.now,
      recipientPublicId,
      transitionId: prepared.transitionId,
    });
    if (state === null) return yield* new RecipientExclusionNotAccessible();
    yield* telemetry.emit({
      event: "recipient_exclusion.transition.completed",
      outcome: "success",
      service: "api",
      transitionKind: state.excluded ? "exclude" : "re_enable",
    });
    return json(
      {
        exclusion: {
          effective_at: state.effectiveAt,
          excluded: state.excluded,
        },
        recipient: { id: recipientPublicId, kind: prepared.recipientKind },
      },
      200,
      browserOrigin,
    );
  });

export const createRecipientExclusionHandler =
  (layer: Layer.Layer<Requirements, unknown>, browserOrigin: string) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const listMatch = listPattern.exec(url.pathname);
    const exclusionMatch = exclusionPattern.exec(url.pathname);
    if (
      (listMatch === null && exclusionMatch === null) ||
      request.headers.get("origin") !== browserOrigin
    ) {
      return notFound();
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: headers(browserOrigin),
        status: 204,
      });
    }

    let operation: Effect.Effect<Response, unknown, Requirements>;
    if (listMatch !== null) {
      const connectionPublicId = listMatch[1];
      if (request.method !== "GET" || connectionPublicId === undefined) {
        return notFound(browserOrigin);
      }
      const query = parseListQuery(url);
      if (query === "invalid") {
        return json({ error: "invalid_request" }, 400, browserOrigin);
      }
      operation = listRecipients(
        request,
        browserOrigin,
        connectionPublicId,
        query,
      );
    } else {
      const connectionPublicId = exclusionMatch?.[1];
      const recipientPublicId = exclusionMatch?.[2];
      if (
        request.method !== "PUT" ||
        connectionPublicId === undefined ||
        recipientPublicId === undefined
      ) {
        return notFound(browserOrigin);
      }
      if (
        (request.headers.get("content-type") ?? "")
          .split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      ) {
        return json({ error: "invalid_request" }, 400, browserOrigin);
      }
      let parsed: unknown;
      try {
        parsed = await request.json();
      } catch {
        return json({ error: "invalid_request" }, 400, browserOrigin);
      }
      const body = parseExclusionBody(parsed);
      if (body === "invalid") {
        return json({ error: "invalid_request" }, 400, browserOrigin);
      }
      operation = setExclusion(
        request,
        browserOrigin,
        connectionPublicId,
        recipientPublicId,
        body,
      );
    }

    return Effect.runPromise(
      operation.pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            hasFailureTag(failure, "RecipientExclusionConflict")
              ? json({ error: "exclusion_conflict" }, 409, browserOrigin)
              : hasFailureTag(
                    failure,
                    "InvalidHumanIdentity",
                    "RecipientExclusionNotAccessible",
                  )
                ? notFound(browserOrigin)
                : json({ error: "unavailable" }, 503, browserOrigin),
          onSuccess: (response: Response) => response,
        }),
      ),
    );
  };

export const isRecipientExclusionRequest = (request: Request): boolean => {
  const path = new URL(request.url).pathname;
  return listPattern.test(path) || exclusionPattern.test(path);
};
