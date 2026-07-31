import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  HumanIdentity,
  InvalidHumanIdentity,
} from "../src/auth/human-identity";
import {
  createMcpAuthorizationManagementHandler,
  McpAuthorizationClock,
  McpAuthorizationPersistence,
  type McpAuthorizationPersistenceService,
} from "../src/mcp-authorization";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const browserOrigin = "https://app.example.test";
const authorizationId = "mca_123456789012345678901";
const revokedAt = new Date("2026-08-01T12:05:00.000Z");

const makeHarness = () => {
  let currentRevokedAt: Date | null = null;
  const telemetry: Array<SafeTelemetryEvent> = [];
  const persistence: McpAuthorizationPersistenceService = {
    create: () => Effect.succeed(true),
    isActive: () => Effect.succeed(true),
    list: (clerkUserId) =>
      clerkUserId === "user_owner"
        ? Effect.succeed([
            {
              authorizationId,
              authorizedAt: new Date("2026-07-31T12:00:00.000Z"),
              clientClass: "approved",
              clientId: "approved-client",
              clientName: "Approved MCP Client",
              connectionIds: [
                "con_123456789012345678901",
                "con_123456789012345678902",
              ],
              expired: false,
              expiresAt: new Date("2026-10-29T12:00:00.000Z"),
              revoked: currentRevokedAt !== null,
              revokedAt: currentRevokedAt,
              scopes: ["connections:read", "messages:send"],
            },
          ])
        : Effect.succeed([]),
    listConnections: () => Effect.succeed([]),
    registerRefreshCredential: () => Effect.succeed(true),
    revoke: (input) =>
      Effect.sync(() => {
        if (
          input.clerkUserId !== "user_owner" ||
          input.authorizationId !== authorizationId
        ) {
          return null;
        }
        currentRevokedAt ??= input.revokedAt;
        return { revokedAt: currentRevokedAt };
      }),
    rotateRefreshCredential: () =>
      Effect.succeed({ outcome: "invalid" as const }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: (request) => {
        const authorization = request.headers.get("authorization");
        if (authorization === "Bearer owner") {
          return Effect.succeed("user_owner");
        }
        if (authorization === "Bearer other") {
          return Effect.succeed("user_other");
        }
        return Effect.fail(new InvalidHumanIdentity());
      },
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(McpAuthorizationClock, {
      now: Effect.succeed(revokedAt),
    }),
    Layer.succeed(McpAuthorizationPersistence, persistence),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          telemetry.push(event);
        }),
    }),
  );
  return {
    handler: createMcpAuthorizationManagementHandler(layer, browserOrigin),
    telemetry,
  };
};

const request = (
  path: string,
  options: {
    readonly authorization?: string;
    readonly method?: string;
    readonly origin?: string;
  } = {},
) =>
  new Request(`https://api.example.test${path}`, {
    headers: {
      authorization: options.authorization ?? "Bearer owner",
      origin: options.origin ?? browserOrigin,
    },
    method: options.method ?? "GET",
  });

describe("MCP Authorization management HTTP boundary", () => {
  test("lists only safe product-facing grant details", async () => {
    const harness = makeHarness();
    const response = await harness.handler(request("/v1/mcp-authorizations"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      browserOrigin,
    );
    const body = await response.json();
    expect(body).toEqual({
      mcp_authorizations: [
        {
          client: {
            id: "approved-client",
            name: "Approved MCP Client",
          },
          connection_ids: [
            "con_123456789012345678901",
            "con_123456789012345678902",
          ],
          created_at: "2026-07-31T12:00:00.000Z",
          expires_at: "2026-10-29T12:00:00.000Z",
          expiry_state: "active",
          id: authorizationId,
          revocation_state: "active",
          revoked_at: null,
          scopes: ["connections:read", "messages:send"],
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(
      /oauth_subject|credential|token|refresh/iu,
    );
    expect(harness.telemetry).toEqual([
      {
        event: "mcp_authorization.management.completed",
        operation: "list",
        outcome: "success",
        service: "api",
      },
    ]);
  });

  test("idempotently revokes an owned authorization", async () => {
    const harness = makeHarness();
    const first = await harness.handler(
      request(`/v1/mcp-authorizations/${authorizationId}`, {
        method: "DELETE",
      }),
    );
    const replay = await harness.handler(
      request(`/v1/mcp-authorizations/${authorizationId}`, {
        method: "DELETE",
      }),
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      mcp_authorization: {
        id: authorizationId,
        revocation_state: "revoked",
        revoked_at: revokedAt.toISOString(),
      },
    });
    expect(await replay.json()).toEqual({
      mcp_authorization: {
        id: authorizationId,
        revocation_state: "revoked",
        revoked_at: revokedAt.toISOString(),
      },
    });
  });

  test("makes another Personal Account and unknown handles indistinguishable", async () => {
    const harness = makeHarness();
    const crossAccount = await harness.handler(
      request(`/v1/mcp-authorizations/${authorizationId}`, {
        authorization: "Bearer other",
        method: "DELETE",
      }),
    );
    const unknown = await harness.handler(
      request("/v1/mcp-authorizations/mca_999999999999999999999", {
        method: "DELETE",
      }),
    );

    expect(crossAccount.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await crossAccount.text()).toBe(await unknown.text());
  });

  test("rejects invalid identity, origin, method, and handles without discovery", async () => {
    const harness = makeHarness();
    const invalidIdentity = await harness.handler(
      request("/v1/mcp-authorizations", {
        authorization: "Bearer invalid",
      }),
    );
    const invalidOrigin = await harness.handler(
      request("/v1/mcp-authorizations", {
        origin: "https://attacker.example.test",
      }),
    );
    const invalidMethod = await harness.handler(
      request("/v1/mcp-authorizations", { method: "POST" }),
    );
    const invalidHandle = await harness.handler(
      request("/v1/mcp-authorizations/not-an-authorization", {
        method: "DELETE",
      }),
    );

    expect(invalidIdentity.status).toBe(404);
    expect(invalidOrigin.status).toBe(404);
    expect(invalidMethod.status).toBe(404);
    expect(invalidHandle.status).toBe(404);
  });
});
