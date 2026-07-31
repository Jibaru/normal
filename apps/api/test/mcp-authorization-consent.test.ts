import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
  HumanIdentity,
  InvalidHumanIdentity,
  RecentHumanVerificationRequired,
} from "../src/auth/human-identity";
import {
  createMcpAuthorizationConsentHandler,
  McpAuthorizationClock,
  McpAuthorizationIdentifiers,
  McpAuthorizationPersistence,
  type McpAuthorizationPersistenceService,
} from "../src/mcp-authorization";
import {
  createOAuthHandler,
  type OAuthConfiguration,
  sealAuthorizationRequest,
} from "../src/oauth";

const browserOrigin = "https://app.example.test";
const configuration: OAuthConfiguration = {
  clients: [
    {
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      redirectUris: ["https://client.example.test/callback"],
    },
  ],
  consentOrigin: browserOrigin,
  issuer: "https://api.example.test",
  protocolEncryptionKey: Redacted.make(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  ),
  resource: "https://api.example.test/mcp",
};
const oauthRequest: AuthRequest = {
  clientId: "approved-client",
  codeChallenge: "A".repeat(43),
  codeChallengeMethod: "S256",
  redirectUri: "https://client.example.test/callback",
  resource: "https://api.example.test/mcp",
  responseType: "code",
  scope: ["connections:read", "messages:send"],
  state: "client-state",
};
const connectionId = "con_123456789012345678901";

const makeHarness = async (
  options: {
    readonly completionFails?: boolean;
    readonly stale?: boolean;
  } = {},
) => {
  const values = new Map<string, string>();
  const kv = {
    delete: async (key: string) => {
      values.delete(key);
    },
    get: async (key: string, options?: unknown) => {
      const value = values.get(key);
      if (value === undefined) return null;
      const wantsJson =
        options === "json" ||
        (typeof options === "object" &&
          options !== null &&
          (options as { readonly type?: unknown }).type === "json");
      return wantsJson ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const client = configuration.clients.at(0);
  if (client === undefined) throw new Error("test client unavailable");
  const handoff = await sealAuthorizationRequest(
    oauthRequest,
    client,
    configuration,
    kv,
  );
  const created: Array<
    Parameters<McpAuthorizationPersistenceService["create"]>[0]
  > = [];
  const persistence: McpAuthorizationPersistenceService = {
    create: (input) =>
      Effect.sync(() => {
        created.push(input);
        return true;
      }),
    isActive: () => Effect.succeed(true),
    list: () => Effect.succeed([]),
    listConnections: () => Effect.succeed([{ connectionId }] as const),
    registerRefreshCredential: () => Effect.succeed(true),
    rotateRefreshCredential: (_input, issue) =>
      Effect.promise(issue).pipe(
        Effect.map(({ value }) => ({ outcome: "rotated" as const, value })),
      ),
    revoke: () => Effect.succeed(null),
  };
  const completed: Array<unknown> = [];
  const helpers = {
    completeAuthorization: async (input: unknown) => {
      completed.push(input);
      if (options.completionFails) {
        throw new Error("OAuth grant unavailable");
      }
      return {
        redirectTo:
          "https://client.example.test/callback?code=issued-code&state=client-state",
      };
    },
  } as OAuthHelpers;
  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: () => Effect.succeed("user_authorization27"),
      verifyRecently: () =>
        options.stale
          ? Effect.fail(new RecentHumanVerificationRequired())
          : Effect.succeed({
              clerkUserId: "user_authorization27",
              reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
            }),
    }),
    Layer.succeed(McpAuthorizationPersistence, persistence),
    Layer.succeed(McpAuthorizationClock, {
      now: Effect.succeed(new Date("2026-07-31T12:00:00.000Z")),
    }),
    Layer.succeed(McpAuthorizationIdentifiers, {
      authorizationId: Effect.succeed("40000000-0000-4000-8000-000000000027"),
      oauthSubject: Effect.succeed("B".repeat(43)),
    }),
  );
  return {
    completed,
    created,
    handoff,
    handler: createMcpAuthorizationConsentHandler({
      browserOrigin,
      configuration,
      kv,
      layer,
    }),
    helpers,
    kv,
    layer,
    values,
  };
};

const post = (path: string, body: unknown): Request =>
  new Request(`https://api.example.test${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: "Bearer clerk-token",
      "content-type": "application/json",
      origin: browserOrigin,
    },
    method: "POST",
  });

describe("explicit MCP Authorization consent HTTP boundary", () => {
  test("presents the allowlisted client, requested scopes, and current connections without preselecting authority", async () => {
    const harness = await makeHarness();
    const response = await harness.handler(
      post("/v1/oauth/consent/inspect", { request: harness.handoff }),
      harness.helpers,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      client: { name: "Approved MCP Client" },
      connections: [{ connection_id: connectionId }],
      requested_scopes: ["connections:read", "messages:send"],
    });
  });

  test("persists explicit send-only authority and completes the real OAuth grant", async () => {
    const harness = await makeHarness();
    const inspection = await harness.handler(
      post("/v1/oauth/consent/inspect", { request: harness.handoff }),
      harness.helpers,
    );
    const presentation = (await inspection.json()) as {
      readonly presentation: string;
    };
    const response = await harness.handler(
      post("/v1/oauth/consent/decision", {
        connection_ids: [connectionId],
        decision: "approve",
        presentation: presentation.presentation,
        read_confirmed: false,
        request: harness.handoff,
        scopes: ["messages:send"],
        send_confirmed: true,
      }),
      harness.helpers,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirect_to:
        "https://client.example.test/callback?code=issued-code&state=client-state",
    });
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]).toMatchObject({
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      connectionIds: [connectionId],
      scopes: ["messages:send"],
    });
    expect(harness.completed).toEqual([
      expect.objectContaining({
        props: {
          authorizationId: "40000000-0000-4000-8000-000000000027",
          clientId: "approved-client",
          oauthSubject: "B".repeat(43),
        },
      }),
    ]);
  });

  test("does not persist authority when OAuth grant completion fails", async () => {
    const harness = await makeHarness({ completionFails: true });
    const inspection = await harness.handler(
      post("/v1/oauth/consent/inspect", { request: harness.handoff }),
      harness.helpers,
    );
    const { presentation } = (await inspection.json()) as {
      readonly presentation: string;
    };

    const response = await harness.handler(
      post("/v1/oauth/consent/decision", {
        connection_ids: [connectionId],
        decision: "approve",
        presentation,
        read_confirmed: true,
        request: harness.handoff,
        scopes: ["connections:read"],
        send_confirmed: false,
      }),
      harness.helpers,
    );

    expect(response.status).toBe(503);
    expect(harness.completed).toHaveLength(1);
    expect(harness.created).toEqual([]);
  });

  test("denies without persisting and safely redirects only to the sealed redirect", async () => {
    const harness = await makeHarness();
    const inspection = await harness.handler(
      post("/v1/oauth/consent/inspect", { request: harness.handoff }),
      harness.helpers,
    );
    const { presentation } = (await inspection.json()) as {
      readonly presentation: string;
    };
    const response = await harness.handler(
      post("/v1/oauth/consent/decision", {
        decision: "deny",
        presentation,
        request: harness.handoff,
      }),
      harness.helpers,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirect_to:
        "https://client.example.test/callback?error=access_denied&state=client-state",
    });
    expect(harness.created).toEqual([]);
  });

  test("rejects stale reverification and a changed presented request before persisting", async () => {
    const stale = await makeHarness({ stale: true });
    const staleInspection = await stale.handler(
      post("/v1/oauth/consent/inspect", { request: stale.handoff }),
      stale.helpers,
    );
    const { presentation } = (await staleInspection.json()) as {
      readonly presentation: string;
    };
    const staleResponse = await stale.handler(
      post("/v1/oauth/consent/decision", {
        connection_ids: [connectionId],
        decision: "approve",
        presentation,
        read_confirmed: true,
        request: stale.handoff,
        scopes: ["connections:read"],
        send_confirmed: false,
      }),
      stale.helpers,
    );
    expect(staleResponse.status).toBe(403);

    const changed = await makeHarness();
    const changedResponse = await changed.handler(
      post("/v1/oauth/consent/decision", {
        connection_ids: [connectionId],
        decision: "approve",
        presentation: "changed",
        read_confirmed: true,
        request: changed.handoff,
        scopes: ["connections:read"],
        send_confirmed: false,
      }),
      changed.helpers,
    );
    expect(changedResponse.status).toBe(409);
    expect(stale.created).toEqual([]);
    expect(changed.created).toEqual([]);
  });

  test("uses one non-disclosing boundary for invalid human identity", async () => {
    const harness = await makeHarness();
    const handler = createMcpAuthorizationConsentHandler({
      browserOrigin,
      configuration,
      kv: {
        delete: async () => undefined,
        get: async () => null,
        put: async () => undefined,
      },
      layer: Layer.mergeAll(
        Layer.succeed(HumanIdentity, {
          verify: () => Effect.fail(new InvalidHumanIdentity()),
          verifyRecently: () => Effect.fail(new InvalidHumanIdentity()),
        }),
        Layer.succeed(McpAuthorizationPersistence, {
          create: () => Effect.succeed(false),
          isActive: () => Effect.succeed(false),
          list: () => Effect.succeed(null),
          listConnections: () => Effect.succeed(null),
          registerRefreshCredential: () => Effect.succeed(false),
          rotateRefreshCredential: () =>
            Effect.succeed({ outcome: "invalid" as const }),
          revoke: () => Effect.succeed(null),
        }),
        Layer.succeed(McpAuthorizationClock, {
          now: Effect.succeed(new Date()),
        }),
        Layer.succeed(McpAuthorizationIdentifiers, {
          authorizationId: Effect.succeed(crypto.randomUUID()),
          oauthSubject: Effect.succeed("C".repeat(43)),
        }),
      ),
    });
    const response = await handler(
      post("/v1/oauth/consent/inspect", { request: harness.handoff }),
      harness.helpers,
    );
    expect(response.status).toBe(404);
  });

  test("exchanges the approved code over real OAuth HTTP for a resource-bound ten-minute token and refresh credential", async () => {
    const harness = await makeHarness();
    const verifier = "v".repeat(64);
    const challengeBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const challenge = btoa(String.fromCharCode(...challengeBytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    const consent = createMcpAuthorizationConsentHandler({
      browserOrigin,
      configuration,
      kv: harness.kv,
      layer: harness.layer,
    });
    let authorizationActive = true;
    let currentCredentialHash: string | undefined;
    let familyRevoked = false;
    const consumedCredentialHashes = new Set<string>();
    let rotationQueue = Promise.resolve();
    const hashKey = (value: Uint8Array): string =>
      Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const refreshCredentials = {
      register: async (input: { readonly credentialHash: Uint8Array }) => {
        currentCredentialHash = hashKey(input.credentialHash);
        return true;
      },
      rotate: async <Value>(
        input: { readonly credentialHash: Uint8Array },
        issue: () => Promise<{
          readonly credentialHash: Uint8Array;
          readonly value: Value;
        }>,
      ) => {
        const previous = rotationQueue;
        let release: () => void = () => undefined;
        rotationQueue = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          const presented = hashKey(input.credentialHash);
          if (consumedCredentialHashes.has(presented)) {
            familyRevoked = true;
            return { outcome: "reuse" as const };
          }
          if (familyRevoked || currentCredentialHash !== presented) {
            return { outcome: "invalid" as const };
          }
          const issued = await issue();
          consumedCredentialHashes.add(presented);
          currentCredentialHash = hashKey(issued.credentialHash);
          return { outcome: "rotated" as const, value: issued.value };
        } finally {
          release();
        }
      },
    };
    const makeOAuth = () =>
      createOAuthHandler({
        applicationHandler: (request, environment) => {
          if (new URL(request.url).pathname.startsWith("/mcp")) {
            return Promise.resolve(
              new Response(JSON.stringify({ outcome: "called" }), {
                headers: { "content-type": "application/json" },
              }),
            );
          }
          if (!environment.OAUTH_PROVIDER) {
            return Promise.resolve(new Response(null, { status: 503 }));
          }
          const legacyHelpers = {
            completeAuthorization: (
              input: Parameters<OAuthHelpers["completeAuthorization"]>[0],
            ) => {
              const props = input.props as Record<string, unknown>;
              const { clientId: _clientId, ...legacyProps } = props;
              return environment.OAUTH_PROVIDER?.completeAuthorization({
                ...input,
                props: legacyProps,
              }) as ReturnType<OAuthHelpers["completeAuthorization"]>;
            },
          } as OAuthHelpers;
          return consent(request, legacyHelpers);
        },
        configuration,
        environment: {
          OAUTH_KV: harness.kv,
        },
        isAuthorizationActive: async () => authorizationActive,
        refreshCredentials,
        telemetry: () => undefined,
      });
    let oauth = makeOAuth();
    const context = {
      passThroughOnException: () => undefined,
      waitUntil: () => undefined,
    } as unknown as ExecutionContext;
    const authorize = new URL("https://api.example.test/oauth/authorize");
    authorize.search = new URLSearchParams({
      client_id: "approved-client",
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: "https://client.example.test/callback",
      resource: "https://api.example.test/mcp",
      response_type: "code",
      scope: "connections:read messages:send",
      state: "client-state",
    }).toString();
    const authorizationResponse = await oauth(
      new Request(authorize, { redirect: "manual" }),
      context,
    );
    const handoff = new URL(
      authorizationResponse.headers.get("location") ?? "",
    ).searchParams.get("request");
    expect(handoff).not.toBeNull();

    oauth = makeOAuth();
    const inspectionResponse = await oauth(
      post("/v1/oauth/consent/inspect", { request: handoff }),
      context,
    );
    const inspection = (await inspectionResponse.json()) as {
      readonly presentation: string;
    };
    const decisionResponse = await oauth(
      post("/v1/oauth/consent/decision", {
        connection_ids: [connectionId],
        decision: "approve",
        presentation: inspection.presentation,
        read_confirmed: true,
        request: handoff,
        scopes: ["connections:read"],
        send_confirmed: false,
      }),
      context,
    );
    const decision = (await decisionResponse.json()) as {
      readonly redirect_to: string;
    };
    const code = new URL(decision.redirect_to).searchParams.get("code");
    expect(code).not.toBeNull();

    const tokenResponse = await oauth(
      new Request("https://api.example.test/oauth/token", {
        body: new URLSearchParams({
          code: code ?? "",
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: "https://client.example.test/callback",
          resource: "https://api.example.test/mcp",
        }),
        headers: {
          authorization: `Basic ${btoa("approved-client:")}`,
          "content-type": "Application/X-Www-Form-Urlencoded; Charset=UTF-8",
        },
        method: "POST",
      }),
      context,
    );
    const token = (await tokenResponse.json()) as Record<string, unknown>;
    expect(tokenResponse.status, JSON.stringify(token)).toBe(200);
    expect(token).toMatchObject({
      expires_in: 600,
      resource: "https://api.example.test/mcp",
      scope: "connections:read",
      token_type: "bearer",
    });
    expect(token.access_token).toEqual(expect.any(String));
    expect(token.refresh_token).toEqual(expect.any(String));
    expect(JSON.stringify(token)).not.toContain("clerk");
    expect(currentCredentialHash).toBeDefined();

    const accessRequest = () =>
      new Request("https://api.example.test/mcp", {
        headers: {
          authorization: `Bearer ${String(token.access_token)}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
    const activeAccess = await oauth(accessRequest(), context);
    expect(activeAccess.status).toBe(200);
    const protectedAccessRequest = () =>
      new Request("https://api.example.test/mcp/resources/protected", {
        headers: {
          authorization: `Bearer ${String(token.access_token)}`,
        },
      });
    const activeProtectedAccess = await oauth(
      protectedAccessRequest(),
      context,
    );
    expect(activeProtectedAccess.status).toBe(200);

    const refreshRequest = (
      clientAuthentication: "basic" | "body" = "body",
    ) => {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: String(token.refresh_token),
        resource: "https://api.example.test/mcp",
      });
      if (clientAuthentication === "body") {
        body.set("client_id", "approved-client");
      }
      return new Request("https://api.example.test/oauth/token", {
        body,
        headers: {
          ...(clientAuthentication === "basic"
            ? { authorization: `Basic ${btoa("approved-client:")}` }
            : {}),
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      });
    };
    const concurrent = await Promise.all([
      oauth(refreshRequest(), context),
      oauth(refreshRequest("basic"), context),
    ]);
    const rotatedResponse = concurrent.find(
      (response) => response.status === 200,
    );
    const reusedResponse = concurrent.find(
      (response) => response.status === 400,
    );
    expect(rotatedResponse).toBeDefined();
    expect(reusedResponse).toBeDefined();
    expect(await reusedResponse?.json()).toMatchObject({
      error: "invalid_grant",
    });
    const rotated = (await rotatedResponse?.json()) as Record<string, unknown>;
    expect(rotated).toMatchObject({
      access_token: expect.any(String),
      expires_in: 600,
      resource: "https://api.example.test/mcp",
      scope: "connections:read",
    });
    expect(rotated.refresh_token).toEqual(expect.any(String));
    expect(rotated.refresh_token).not.toBe(token.refresh_token);
    const rotatedAccess = await oauth(
      new Request("https://api.example.test/mcp", {
        headers: {
          authorization: `Bearer ${String(rotated.access_token)}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
      context,
    );
    expect(rotatedAccess.status).toBe(200);
    expect(familyRevoked).toBe(true);

    const replayResponse = await oauth(refreshRequest(), context);
    expect(replayResponse.status).toBe(400);
    expect(await replayResponse.json()).toMatchObject({
      error: "invalid_grant",
    });

    const refreshResponse = await oauth(
      new Request("https://api.example.test/oauth/token", {
        body: new URLSearchParams({
          client_id: "approved-client",
          grant_type: "refresh_token",
          refresh_token: String(rotated.refresh_token),
          resource: "https://api.example.test/mcp",
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
      context,
    );
    expect(refreshResponse.status).toBe(400);
    expect(await refreshResponse.json()).toMatchObject({
      error: "invalid_grant",
    });

    authorizationActive = false;
    const revokedAccess = await oauth(accessRequest(), context);
    expect(revokedAccess.status).toBe(401);
    expect(revokedAccess.headers.get("cache-control")).toBe("no-store");
    expect(revokedAccess.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
    expect(await revokedAccess.json()).toEqual({ error: "invalid_token" });
    const revokedProtectedAccess = await oauth(
      protectedAccessRequest(),
      context,
    );
    expect(revokedProtectedAccess.status).toBe(401);
  });
});
