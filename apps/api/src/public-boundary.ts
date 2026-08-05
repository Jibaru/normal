import { Context, Data, Effect, type Layer } from "effect";
import { noStoreJsonResponse } from "./http-response";

export class ControlledBoundaryFailure extends Data.TaggedError(
  "ControlledBoundaryFailure",
)<{ readonly target: "identity" | "provider" }> {}

export class InvalidBoundaryIdentity extends Data.TaggedError(
  "InvalidBoundaryIdentity",
) {}

export interface BoundaryIdentity {
  readonly verify: (
    authorization: string | null,
  ) => Effect.Effect<
    string,
    ControlledBoundaryFailure | InvalidBoundaryIdentity
  >;
}

export const BoundaryIdentity = Context.GenericTag<BoundaryIdentity>(
  "@whatsapp-mcp/api/BoundaryIdentity",
);

export interface BoundaryProvider {
  readonly observeConnection: Effect.Effect<
    "connected",
    ControlledBoundaryFailure
  >;
}

export const BoundaryProvider = Context.GenericTag<BoundaryProvider>(
  "@whatsapp-mcp/api/BoundaryProvider",
);

export interface BoundaryClock {
  readonly now: Effect.Effect<string>;
}

export const BoundaryClock = Context.GenericTag<BoundaryClock>(
  "@whatsapp-mcp/api/BoundaryClock",
);

export interface BoundaryIdentifiers {
  readonly authorizationCode: Effect.Effect<string>;
  readonly connection: Effect.Effect<string>;
}

export const BoundaryIdentifiers = Context.GenericTag<BoundaryIdentifiers>(
  "@whatsapp-mcp/api/BoundaryIdentifiers",
);

export interface BoundaryResource {
  readonly read: Effect.Effect<Uint8Array>;
}

export const BoundaryResource = Context.GenericTag<BoundaryResource>(
  "@whatsapp-mcp/api/BoundaryResource",
);

type BoundaryRequirements =
  | BoundaryClock
  | BoundaryIdentifiers
  | BoundaryIdentity
  | BoundaryProvider
  | BoundaryResource;

const corsHeaders = (request: Request, browserOrigin: string) =>
  request.headers.get("origin") === browserOrigin
    ? {
        "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "GET,OPTIONS,POST",
        "access-control-allow-origin": browserOrigin,
        vary: "Origin",
      }
    : {};

const jsonResponse = (
  request: Request,
  browserOrigin: string,
  body: unknown,
  status = 200,
): Response =>
  noStoreJsonResponse(body, status, corsHeaders(request, browserOrigin));

const runAuthenticated = <Value>(
  request: Request,
  layer: Layer.Layer<BoundaryRequirements>,
  effect: (
    userId: string,
  ) => Effect.Effect<Value, ControlledBoundaryFailure, BoundaryRequirements>,
) =>
  Effect.gen(function* () {
    const identity = yield* BoundaryIdentity;
    const userId = yield* identity.verify(request.headers.get("authorization"));
    return yield* effect(userId);
  }).pipe(Effect.provide(layer));

const failureResponse = (
  request: Request,
  browserOrigin: string,
  failure: ControlledBoundaryFailure | InvalidBoundaryIdentity,
) =>
  failure._tag === "InvalidBoundaryIdentity"
    ? jsonResponse(request, browserOrigin, { error: "unauthorized" }, 401)
    : jsonResponse(
        request,
        browserOrigin,
        { error: "controlled_external_failure" },
        503,
      );

const signedInResponse = (
  request: Request,
  browserOrigin: string,
  layer: Layer.Layer<BoundaryRequirements>,
): Promise<Response> =>
  Effect.runPromise(
    runAuthenticated(request, layer, (userId) =>
      Effect.gen(function* () {
        const provider = yield* BoundaryProvider;
        const clock = yield* BoundaryClock;
        const identifiers = yield* BoundaryIdentifiers;

        return {
          connection_id: yield* identifiers.connection,
          observed_at: yield* clock.now,
          provider_state: yield* provider.observeConnection,
          user_id: userId,
        };
      }),
    ).pipe(
      Effect.match({
        onFailure: (failure) =>
          failureResponse(request, browserOrigin, failure),
        onSuccess: (body) => jsonResponse(request, browserOrigin, body),
      }),
    ),
  );

const oauthResponse = (
  request: Request,
  browserOrigin: string,
  layer: Layer.Layer<BoundaryRequirements>,
): Promise<Response> => {
  const url = new URL(request.url);
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  if (
    redirectUri !== "https://client.example.test/callback" ||
    state === null
  ) {
    return Promise.resolve(
      jsonResponse(request, browserOrigin, { error: "invalid_request" }, 400),
    );
  }

  return Effect.runPromise(
    runAuthenticated(request, layer, () =>
      Effect.gen(function* () {
        const identifiers = yield* BoundaryIdentifiers;
        return yield* identifiers.authorizationCode;
      }),
    ).pipe(
      Effect.match({
        onFailure: (failure) =>
          failureResponse(request, browserOrigin, failure),
        onSuccess: (code) => {
          const location = new URL(redirectUri);
          location.searchParams.set("code", code);
          location.searchParams.set("state", state);
          return new Response(null, {
            headers: {
              ...corsHeaders(request, browserOrigin),
              "cache-control": "no-store",
              location: location.toString(),
            },
            status: 302,
          });
        },
      }),
    ),
  );
};

const mcpResponse = async (
  request: Request,
  browserOrigin: string,
  layer: Layer.Layer<BoundaryRequirements>,
): Promise<Response> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, browserOrigin, { error: "invalid_json" }, 400);
  }
  if (
    typeof body !== "object" ||
    body === null ||
    (body as Record<string, unknown>).jsonrpc !== "2.0" ||
    (body as Record<string, unknown>).method !== "tools/list"
  ) {
    return jsonResponse(
      request,
      browserOrigin,
      { error: "invalid_json_rpc" },
      400,
    );
  }
  const id = (body as Record<string, unknown>).id;

  return Effect.runPromise(
    runAuthenticated(request, layer, () =>
      Effect.succeed({
        id,
        jsonrpc: "2.0" as const,
        result: { tools: [] },
      }),
    ).pipe(
      Effect.match({
        onFailure: (failure) =>
          failureResponse(request, browserOrigin, failure),
        onSuccess: (responseBody) =>
          jsonResponse(request, browserOrigin, responseBody),
      }),
    ),
  );
};

const resourceResponse = (
  request: Request,
  browserOrigin: string,
  layer: Layer.Layer<BoundaryRequirements>,
): Promise<Response> =>
  Effect.runPromise(
    runAuthenticated(request, layer, () =>
      Effect.gen(function* () {
        const resource = yield* BoundaryResource;
        return yield* resource.read;
      }),
    ).pipe(
      Effect.match({
        onFailure: (failure) =>
          failureResponse(request, browserOrigin, failure),
        onSuccess: (bytes) =>
          new Response(bytes, {
            headers: {
              ...corsHeaders(request, browserOrigin),
              "cache-control": "no-store",
              "content-type": "application/octet-stream",
            },
          }),
      }),
    ),
  );

export const createPublicBoundaryHandler =
  (layer: Layer.Layer<BoundaryRequirements>, browserOrigin: string) =>
  (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;

    if (request.method === "OPTIONS") {
      return Promise.resolve(
        new Response(null, {
          headers: corsHeaders(request, browserOrigin),
          status: 204,
        }),
      );
    }
    if (request.method === "GET" && path === "/test/ready") {
      return Promise.resolve(
        jsonResponse(request, browserOrigin, { status: "ready" }),
      );
    }
    if (request.method === "GET" && path === "/v1/personal-account") {
      return signedInResponse(request, browserOrigin, layer);
    }
    if (request.method === "GET" && path === "/oauth/authorize") {
      return oauthResponse(request, browserOrigin, layer);
    }
    if (request.method === "POST" && path === "/mcp") {
      return mcpResponse(request, browserOrigin, layer);
    }
    if (request.method === "GET" && path === "/mcp/resources/protected") {
      return resourceResponse(request, browserOrigin, layer);
    }
    return Promise.resolve(
      jsonResponse(request, browserOrigin, { error: "not_found" }, 404),
    );
  };
