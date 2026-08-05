import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type {
  McpAuthorizationScope,
  McpAuthorizationSummary,
} from "@whatsapp-mcp/db/mcp-authorization";
import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import { encodeBase64Url } from "./base64-url";
import { hasFailureTag } from "./failure-tag";
import { noStoreJsonResponse } from "./http-response";
import {
  OAUTH_SCOPES,
  type OAuthConfiguration,
  type OAuthKv,
  type OpenedAuthorizationRequest,
  openAuthorizationRequest,
} from "./oauth";
import { hasExactKeys } from "./record";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const INSPECT_PATH = "/v1/oauth/consent/inspect";
const DECISION_PATH = "/v1/oauth/consent/decision";
const MANAGEMENT_PATH = "/v1/mcp-authorizations";
const AUTHORIZATION_SESSION_SECONDS = 90 * 24 * 60 * 60;
const MCP_AUTHORIZATION_HANDLE_PATTERN = /^mca_[A-Za-z0-9_-]{21}$/u;

export class McpAuthorizationPersistenceError extends Data.TaggedError(
  "McpAuthorizationPersistenceError",
)<{
  readonly code?: string;
  readonly constraint?: string;
}> {}

export interface McpAuthorizationPersistenceService {
  readonly create: (input: {
    readonly authorizationId: string;
    readonly authorizedAt: Date;
    readonly clientClass: string;
    readonly clientId: string;
    readonly clientName: string;
    readonly clerkUserId: string;
    readonly connectionIds: ReadonlyArray<string>;
    readonly expiresAt: Date;
    readonly oauthSubject: string;
    readonly reverifiedAt: Date;
    readonly scopes: ReadonlyArray<McpAuthorizationScope>;
  }) => Effect.Effect<boolean, McpAuthorizationPersistenceError>;
  readonly isActive: (input: {
    readonly authorizationId: string;
    readonly clientId?: string | undefined;
    readonly observedAt: Date;
    readonly oauthSubject: string;
  }) => Effect.Effect<boolean, McpAuthorizationPersistenceError>;
  readonly listConnections: (clerkUserId: string) => Effect.Effect<
    ReadonlyArray<{
      readonly connectionId: string;
      readonly numberSuffix: string | null;
    }> | null,
    McpAuthorizationPersistenceError
  >;
  readonly list: (
    clerkUserId: string,
    observedAt: Date,
  ) => Effect.Effect<
    ReadonlyArray<McpAuthorizationSummary> | null,
    McpAuthorizationPersistenceError
  >;
  readonly registerRefreshCredential: (input: {
    readonly clientId: string;
    readonly credentialHash: Uint8Array;
    readonly oauthSubject: string;
    readonly observedAt: Date;
  }) => Effect.Effect<boolean, McpAuthorizationPersistenceError>;
  readonly rotateRefreshCredential: <Value>(
    input: {
      readonly clientId: string;
      readonly credentialHash: Uint8Array;
      readonly oauthSubject: string;
      readonly observedAt: Date;
    },
    issue: () => Promise<{
      readonly credentialHash: Uint8Array;
      readonly value: Value;
    }>,
  ) => Effect.Effect<
    | { readonly outcome: "invalid" | "reuse" }
    | { readonly outcome: "rotated"; readonly value: Value },
    McpAuthorizationPersistenceError
  >;
  readonly revoke: (input: {
    readonly authorizationId: string;
    readonly clerkUserId: string;
    readonly revokedAt: Date;
  }) => Effect.Effect<
    { readonly revokedAt: Date } | null,
    McpAuthorizationPersistenceError
  >;
}

export const McpAuthorizationPersistence =
  Context.GenericTag<McpAuthorizationPersistenceService>(
    "@whatsapp-mcp/api/McpAuthorizationPersistence",
  );

export interface McpAuthorizationClockService {
  readonly now: Effect.Effect<Date>;
}

export const McpAuthorizationClock =
  Context.GenericTag<McpAuthorizationClockService>(
    "@whatsapp-mcp/api/McpAuthorizationClock",
  );

export interface McpAuthorizationIdentifiersService {
  readonly authorizationId: Effect.Effect<string>;
  readonly oauthSubject: Effect.Effect<string>;
}

export const McpAuthorizationIdentifiers =
  Context.GenericTag<McpAuthorizationIdentifiersService>(
    "@whatsapp-mcp/api/McpAuthorizationIdentifiers",
  );

type McpAuthorizationRequirements =
  | HumanIdentityService
  | McpAuthorizationClockService
  | McpAuthorizationIdentifiersService
  | McpAuthorizationPersistenceService;

interface ConsentHandlerOptions {
  readonly browserOrigin: string;
  readonly configuration: OAuthConfiguration;
  readonly kv: OAuthKv;
  readonly layer: Layer.Layer<McpAuthorizationRequirements, unknown>;
  readonly telemetry?:
    | ((event: {
        readonly clientClass: string;
        readonly code?: string;
        readonly constraint?: string;
        readonly event: "oauth.authorization.decision.completed";
        readonly outcome:
          | "approved"
          | "denied"
          | "unavailable_identifiers"
          | "unavailable_oauth"
          | "unavailable_persistence";
        readonly service: "api";
      }) => void)
    | undefined;
}

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

const parseObject = async (
  request: Request,
): Promise<Record<string, unknown> | null> => {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    return null;
  }
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const runEither = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
  layer: Layer.Layer<Requirements, unknown>,
) => Effect.runPromise(Effect.either(effect.pipe(Effect.provide(layer))));

const presentationFor = async (
  handoff: string,
  clerkUserId: string,
  opened: OpenedAuthorizationRequest,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${handoff}\0${clerkUserId}\0${JSON.stringify({
        clientClass: opened.client.clientClass,
        clientId: opened.client.clientId,
        clientName: opened.client.clientName,
        expiresAt: opened.expiresAt,
        request: opened.request,
      })}`,
    ),
  );
  return encodeBase64Url(new Uint8Array(digest));
};

const inspect = async (
  request: Request,
  options: ConsentHandlerOptions,
): Promise<Response> => {
  const body = await parseObject(request);
  if (
    body === null ||
    !hasExactKeys(body, ["request"]) ||
    typeof body.request !== "string"
  ) {
    return jsonResponse(
      { error: "invalid_request" },
      400,
      options.browserOrigin,
    );
  }
  const identity = await runEither(
    Effect.gen(function* () {
      const service = yield* HumanIdentity;
      return yield* service.verify(request);
    }),
    options.layer,
  );
  if (identity._tag === "Left") {
    return jsonResponse({ error: "not_found" }, 404, options.browserOrigin);
  }
  let opened: OpenedAuthorizationRequest;
  try {
    opened = await openAuthorizationRequest(
      body.request,
      options.configuration,
      options.kv,
    );
  } catch {
    return jsonResponse(
      { error: "invalid_request" },
      400,
      options.browserOrigin,
    );
  }
  const connections = await runEither(
    Effect.gen(function* () {
      const persistence = yield* McpAuthorizationPersistence;
      return yield* persistence.listConnections(identity.right);
    }),
    options.layer,
  );
  if (connections._tag === "Left") {
    return jsonResponse({ error: "unavailable" }, 503, options.browserOrigin);
  }
  if (connections.right === null) {
    return jsonResponse({ error: "not_found" }, 404, options.browserOrigin);
  }
  return jsonResponse(
    {
      client: { name: opened.client.clientName },
      connections: connections.right.map(({ connectionId, numberSuffix }) => ({
        connection_id: connectionId,
        label:
          numberSuffix === null
            ? `WhatsApp Connection …${connectionId.slice(-6)}`
            : "WhatsApp",
        number_suffix: numberSuffix,
      })),
      presentation: await presentationFor(body.request, identity.right, opened),
      requested_scopes: opened.request.scope,
    },
    200,
    options.browserOrigin,
  );
};

const denyRedirect = (opened: OpenedAuthorizationRequest): string => {
  const redirect = new URL(opened.request.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("state", opened.request.state);
  return redirect.toString();
};

const inspectDecisionBase = (
  body: Record<string, unknown>,
): {
  readonly decision: "approve" | "deny";
  readonly handoff: string;
  readonly presentation: string;
} | null =>
  (body.decision === "approve" || body.decision === "deny") &&
  typeof body.request === "string" &&
  typeof body.presentation === "string"
    ? {
        decision: body.decision,
        handoff: body.request,
        presentation: body.presentation,
      }
    : null;

const decide = async (
  request: Request,
  helpers: OAuthHelpers,
  options: ConsentHandlerOptions,
): Promise<Response> => {
  const body = await parseObject(request);
  if (body === null) {
    return jsonResponse(
      { error: "invalid_request" },
      400,
      options.browserOrigin,
    );
  }
  const decision = inspectDecisionBase(body);
  const expectedKeys =
    decision?.decision === "deny"
      ? ["decision", "presentation", "request"]
      : [
          "connection_ids",
          "decision",
          "presentation",
          "read_confirmed",
          "request",
          "scopes",
          "send_confirmed",
        ];
  if (decision === null || !hasExactKeys(body, expectedKeys)) {
    return jsonResponse(
      { error: "invalid_request" },
      400,
      options.browserOrigin,
    );
  }
  const verified =
    decision.decision === "approve"
      ? await runEither(
          Effect.gen(function* () {
            const identity = yield* HumanIdentity;
            return yield* identity.verifyRecently(request);
          }),
          options.layer,
        )
      : await runEither(
          Effect.gen(function* () {
            const identity = yield* HumanIdentity;
            const clerkUserId = yield* identity.verify(request);
            return { clerkUserId, reverifiedAt: null };
          }),
          options.layer,
        );
  if (verified._tag === "Left") {
    return jsonResponse(
      typeof verified.left === "object" &&
        verified.left !== null &&
        "_tag" in verified.left &&
        verified.left._tag === "RecentHumanVerificationRequired"
        ? {
            clerk_error: {
              metadata: {
                reverification: {
                  afterMinutes: 5,
                  level: "first_factor",
                },
              },
              reason: "reverification-error",
              type: "forbidden",
            },
          }
        : { error: "not_found" },
      typeof verified.left === "object" &&
        verified.left !== null &&
        "_tag" in verified.left &&
        verified.left._tag === "RecentHumanVerificationRequired"
        ? 403
        : 404,
      options.browserOrigin,
    );
  }
  let opened: OpenedAuthorizationRequest;
  try {
    opened = await openAuthorizationRequest(
      decision.handoff,
      options.configuration,
      options.kv,
    );
  } catch {
    return jsonResponse(
      { error: "invalid_request" },
      400,
      options.browserOrigin,
    );
  }
  const expectedPresentation = await presentationFor(
    decision.handoff,
    verified.right.clerkUserId,
    opened,
  );
  if (decision.presentation !== expectedPresentation) {
    return jsonResponse(
      { error: "authorization_request_changed" },
      409,
      options.browserOrigin,
    );
  }
  if (decision.decision === "deny") {
    try {
      await openAuthorizationRequest(
        decision.handoff,
        options.configuration,
        options.kv,
        true,
      );
    } catch {
      return jsonResponse(
        { error: "invalid_request" },
        400,
        options.browserOrigin,
      );
    }
    options.telemetry?.({
      clientClass: opened.client.clientClass,
      event: "oauth.authorization.decision.completed",
      outcome: "denied",
      service: "api",
    });
    return jsonResponse(
      { redirect_to: denyRedirect(opened) },
      200,
      options.browserOrigin,
    );
  }

  const selectedConnections = body.connection_ids;
  const selectedScopes = body.scopes;
  if (
    !Array.isArray(selectedConnections) ||
    selectedConnections.length === 0 ||
    selectedConnections.length > 3 ||
    selectedConnections.some(
      (connection) =>
        typeof connection !== "string" ||
        !/^con_[A-Za-z0-9_-]{21}$/.test(connection),
    ) ||
    new Set(selectedConnections).size !== selectedConnections.length ||
    !Array.isArray(selectedScopes) ||
    selectedScopes.length === 0 ||
    selectedScopes.length > OAUTH_SCOPES.length ||
    selectedScopes.some(
      (scope) =>
        typeof scope !== "string" ||
        !opened.request.scope.includes(scope) ||
        !OAUTH_SCOPES.includes(scope as (typeof OAUTH_SCOPES)[number]),
    ) ||
    new Set(selectedScopes).size !== selectedScopes.length ||
    typeof body.read_confirmed !== "boolean" ||
    typeof body.send_confirmed !== "boolean"
  ) {
    return jsonResponse(
      { error: "invalid_selection" },
      400,
      options.browserOrigin,
    );
  }
  const hasRead = selectedScopes.some((scope) => scope !== "messages:send");
  const hasSend = selectedScopes.includes("messages:send");
  if (
    (hasRead && body.read_confirmed !== true) ||
    (hasSend && body.send_confirmed !== true)
  ) {
    return jsonResponse(
      { error: "confirmation_required" },
      400,
      options.browserOrigin,
    );
  }
  try {
    await openAuthorizationRequest(
      decision.handoff,
      options.configuration,
      options.kv,
      true,
    );
  } catch {
    return jsonResponse(
      { error: "invalid_request" },
      400,
      options.browserOrigin,
    );
  }
  const generated = await runEither(
    Effect.gen(function* () {
      const clock = yield* McpAuthorizationClock;
      const identifiers = yield* McpAuthorizationIdentifiers;
      return {
        authorizationId: yield* identifiers.authorizationId,
        now: yield* clock.now,
        oauthSubject: yield* identifiers.oauthSubject,
      };
    }),
    options.layer,
  );
  if (generated._tag === "Left") {
    options.telemetry?.({
      clientClass: opened.client.clientClass,
      event: "oauth.authorization.decision.completed",
      outcome: "unavailable_identifiers",
      service: "api",
    });
    return jsonResponse({ error: "unavailable" }, 503, options.browserOrigin);
  }
  let completed: Awaited<ReturnType<OAuthHelpers["completeAuthorization"]>>;
  try {
    completed = await helpers.completeAuthorization({
      metadata: {
        clientClass: opened.client.clientClass,
      },
      props: {
        authorizationId: generated.right.authorizationId,
        clientId: opened.client.clientId,
        oauthSubject: generated.right.oauthSubject,
      },
      request: opened.request,
      revokeExistingGrants: false,
      scope: selectedScopes as Array<string>,
      userId: generated.right.oauthSubject,
    });
  } catch {
    options.telemetry?.({
      clientClass: opened.client.clientClass,
      event: "oauth.authorization.decision.completed",
      outcome: "unavailable_oauth",
      service: "api",
    });
    return jsonResponse({ error: "unavailable" }, 503, options.browserOrigin);
  }
  const persistence = await runEither(
    Effect.gen(function* () {
      const service = yield* McpAuthorizationPersistence;
      return yield* service.create({
        authorizationId: generated.right.authorizationId,
        authorizedAt: generated.right.now,
        clientClass: opened.client.clientClass,
        clientId: opened.client.clientId,
        clientName: opened.client.clientName,
        clerkUserId: verified.right.clerkUserId,
        connectionIds: selectedConnections as ReadonlyArray<string>,
        expiresAt: new Date(
          generated.right.now.getTime() + AUTHORIZATION_SESSION_SECONDS * 1_000,
        ),
        oauthSubject: generated.right.oauthSubject,
        reverifiedAt: verified.right.reverifiedAt as Date,
        scopes: selectedScopes as ReadonlyArray<McpAuthorizationScope>,
      });
    }),
    options.layer,
  );
  if (persistence._tag === "Left") {
    const failure =
      persistence.left instanceof McpAuthorizationPersistenceError
        ? persistence.left
        : undefined;
    options.telemetry?.({
      clientClass: opened.client.clientClass,
      ...(failure?.code === undefined ? {} : { code: failure.code }),
      ...(failure?.constraint === undefined
        ? {}
        : { constraint: failure.constraint }),
      event: "oauth.authorization.decision.completed",
      outcome: "unavailable_persistence",
      service: "api",
    });
    return jsonResponse({ error: "unavailable" }, 503, options.browserOrigin);
  }
  if (!persistence.right) {
    return jsonResponse(
      { error: "invalid_selection" },
      400,
      options.browserOrigin,
    );
  }
  options.telemetry?.({
    clientClass: opened.client.clientClass,
    event: "oauth.authorization.decision.completed",
    outcome: "approved",
    service: "api",
  });
  return jsonResponse(
    { redirect_to: completed.redirectTo },
    200,
    options.browserOrigin,
  );
};

export const createMcpAuthorizationConsentHandler =
  (options: ConsentHandlerOptions) =>
  (request: Request, helpers: OAuthHelpers): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (
      ![INSPECT_PATH, DECISION_PATH].includes(path) ||
      request.headers.get("origin") !== options.browserOrigin
    ) {
      return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
    }
    if (request.method === "OPTIONS") {
      return Promise.resolve(
        new Response(null, {
          headers: corsHeaders(options.browserOrigin),
          status: 204,
        }),
      );
    }
    if (request.method !== "POST") {
      return Promise.resolve(
        jsonResponse({ error: "not_found" }, 404, options.browserOrigin),
      );
    }
    return path === INSPECT_PATH
      ? inspect(request, options)
      : decide(request, helpers, options);
  };

export const isMcpAuthorizationConsentRequest = (request: Request): boolean =>
  [INSPECT_PATH, DECISION_PATH].includes(new URL(request.url).pathname);

type McpAuthorizationManagementRequirements =
  | HumanIdentityService
  | McpAuthorizationClockService
  | McpAuthorizationPersistenceService
  | SafeTelemetryService;

const managementCorsHeaders = (browserOrigin: string) => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "DELETE,GET,OPTIONS",
  "access-control-allow-origin": browserOrigin,
  vary: "Origin",
});

const managementJsonResponse = (
  body: unknown,
  status: number,
  browserOrigin?: string,
): Response =>
  noStoreJsonResponse(
    body,
    status,
    browserOrigin === undefined ? {} : managementCorsHeaders(browserOrigin),
  );

const managementNotFound = (browserOrigin?: string): Response =>
  managementJsonResponse({ error: "not_found" }, 404, browserOrigin);

const managementFailureResponse = (
  failure: unknown,
  browserOrigin: string,
): Response =>
  hasFailureTag(
    failure,
    "InvalidHumanIdentity",
    "InvalidManagementAuthorization",
  )
    ? managementNotFound(browserOrigin)
    : managementJsonResponse({ error: "unavailable" }, 503, browserOrigin);

const authorizationHandleFromPath = (path: string): string | null => {
  if (!path.startsWith(`${MANAGEMENT_PATH}/`)) return null;
  const handle = path.slice(MANAGEMENT_PATH.length + 1);
  return MCP_AUTHORIZATION_HANDLE_PATTERN.test(handle) ? handle : null;
};

const managementList = (
  request: Request,
  layer: Layer.Layer<McpAuthorizationManagementRequirements, unknown>,
  browserOrigin: string,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* HumanIdentity;
      const clerkUserId = yield* identity.verify(request);
      const clock = yield* McpAuthorizationClock;
      const observedAt = yield* clock.now;
      const persistence = yield* McpAuthorizationPersistence;
      const authorizations = yield* persistence.list(clerkUserId, observedAt);
      if (authorizations === null) {
        return yield* Effect.fail(new InvalidManagementAuthorization());
      }
      const telemetry = yield* SafeTelemetry;
      yield* telemetry.emit({
        event: "mcp_authorization.management.completed",
        operation: "list",
        outcome: "success",
        service: "api",
      });
      return authorizations;
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure: unknown) =>
          managementFailureResponse(failure, browserOrigin),
        onSuccess: (authorizations) =>
          managementJsonResponse(
            {
              mcp_authorizations: authorizations.map((authorization) => ({
                client: {
                  id: authorization.clientId,
                  name: authorization.clientName,
                },
                connection_ids: authorization.connectionIds,
                created_at: authorization.authorizedAt.toISOString(),
                expires_at: authorization.expiresAt.toISOString(),
                expiry_state: authorization.expired ? "expired" : "active",
                id: authorization.authorizationId,
                revocation_state: authorization.revoked ? "revoked" : "active",
                revoked_at: authorization.revokedAt?.toISOString() ?? null,
                scopes: authorization.scopes,
              })),
            },
            200,
            browserOrigin,
          ),
      }),
    ),
  );

class InvalidManagementAuthorization extends Data.TaggedError(
  "InvalidManagementAuthorization",
) {}

const managementRevoke = (
  request: Request,
  authorizationId: string,
  layer: Layer.Layer<McpAuthorizationManagementRequirements, unknown>,
  browserOrigin: string,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* HumanIdentity;
      const clerkUserId = yield* identity.verify(request);
      const clock = yield* McpAuthorizationClock;
      const persistence = yield* McpAuthorizationPersistence;
      const result = yield* persistence.revoke({
        authorizationId,
        clerkUserId,
        revokedAt: yield* clock.now,
      });
      const telemetry = yield* SafeTelemetry;
      yield* telemetry.emit({
        event: "mcp_authorization.management.completed",
        operation: "revoke",
        outcome: result === null ? "not_found" : "success",
        service: "api",
      });
      if (result === null) {
        return yield* Effect.fail(new InvalidManagementAuthorization());
      }
      return result;
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure: unknown) =>
          managementFailureResponse(failure, browserOrigin),
        onSuccess: (result) =>
          managementJsonResponse(
            {
              mcp_authorization: {
                id: authorizationId,
                revocation_state: "revoked",
                revoked_at: result.revokedAt.toISOString(),
              },
            },
            200,
            browserOrigin,
          ),
      }),
    ),
  );

export const createMcpAuthorizationManagementHandler =
  (
    layer: Layer.Layer<McpAuthorizationManagementRequirements, unknown>,
    browserOrigin: string,
  ) =>
  (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (
      request.headers.get("origin") !== browserOrigin ||
      (path !== MANAGEMENT_PATH && !path.startsWith(`${MANAGEMENT_PATH}/`))
    ) {
      return Promise.resolve(managementNotFound());
    }
    const authorizationId = authorizationHandleFromPath(path);
    if (request.method === "OPTIONS") {
      if (path !== MANAGEMENT_PATH && authorizationId === null) {
        return Promise.resolve(managementNotFound(browserOrigin));
      }
      return Promise.resolve(
        new Response(null, {
          headers: managementCorsHeaders(browserOrigin),
          status: 204,
        }),
      );
    }
    if (request.method === "GET" && path === MANAGEMENT_PATH) {
      return managementList(request, layer, browserOrigin);
    }
    if (request.method === "DELETE" && authorizationId !== null) {
      return managementRevoke(request, authorizationId, layer, browserOrigin);
    }
    return Promise.resolve(managementNotFound(browserOrigin));
  };

export const isMcpAuthorizationManagementRequest = (
  request: Request,
): boolean => {
  const path = new URL(request.url).pathname;
  return path === MANAGEMENT_PATH || path.startsWith(`${MANAGEMENT_PATH}/`);
};
