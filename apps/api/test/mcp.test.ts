import { importCursorSigningKey } from "@whatsapp-mcp/contracts/cursor";
import type {
  BeginToolCallResult,
  McpToolGroupPage,
} from "@whatsapp-mcp/db/mcp-tool";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import {
  createMcpRequestHandler,
  McpCursorCodec,
  McpCursorSigning,
  McpToolClock,
  McpToolIdentifiers,
  McpToolPersistence,
  McpToolPersistenceError,
} from "../src/mcp";
import type { SafeTelemetryEvent } from "../src/services";
import { SafeTelemetry } from "../src/services";

const authorization = {
  authorizationId: "40000000-0000-4000-8000-000000000030",
  clientId: "approved-client",
  oauthSubject: "A".repeat(43),
} as const;

const jsonRpcRequest = (
  method: string,
  params?: unknown,
  protocolVersion = "2026-07-28",
) => {
  const parameters =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)
      : {};
  const name = parameters.name;
  return new Request("https://api.example.test/mcp", {
    body: JSON.stringify({
      id: "request-1",
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        ...(protocolVersion === "2026-07-28"
          ? {
              _meta: {
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/protocolVersion": protocolVersion,
              },
            }
          : {}),
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "api.example.test",
      "mcp-method": method,
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
      "mcp-protocol-version": protocolVersion,
    },
    method: "POST",
  });
};

const executionContext = {
  passThroughOnException: () => undefined,
  waitUntil: () => undefined,
} as unknown as ExecutionContext;

const responseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(data ?? "");
};

const responseMessages = async (
  response: Response,
): Promise<Array<Record<string, unknown>>> => {
  const text = await response.text();
  const payloads = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as unknown)
    : [JSON.parse(text) as unknown];
  return payloads
    .flatMap((payload) => (Array.isArray(payload) ? payload : [payload]))
    .filter(
      (payload): payload is Record<string, unknown> =>
        typeof payload === "object" && payload !== null,
    );
};

const makeHarness = (
  overrides: {
    readonly beginResult?: BeginToolCallResult;
    readonly contactPage?: {
      readonly asOf: string;
      readonly partial: boolean;
      readonly snapshotObservedAt: string | null;
      readonly stale: boolean;
    };
    readonly failBegin?: boolean;
    readonly failComplete?: boolean;
    readonly failInspect?: boolean;
    readonly failReject?: boolean;
    readonly scopes?: ReadonlyArray<
      "connections:read" | "directory:read" | "messages:read" | "messages:send"
    >;
    readonly groupPage?: McpToolGroupPage | null;
    readonly cursorKey?: CryptoKey;
  } = {},
) => {
  const observations: Array<string> = [];
  const telemetry: Array<SafeTelemetryEvent> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(McpToolClock, {
      now: Effect.succeed(new Date("2026-07-31T12:00:00.000Z")),
    }),
    Layer.succeed(McpToolIdentifiers, {
      nextAuditLogId: Effect.succeed("50000000-0000-4000-8000-000000000030"),
    }),
    Layer.succeed(McpCursorCodec, {
      decode: ({ cursor }) => {
        try {
          return Effect.succeed(JSON.parse(atob(cursor)) as [string, string]);
        } catch {
          return Effect.fail({ _tag: "InvalidCursorError" } as never);
        }
      },
      encode: ({ boundary }) => Effect.succeed(btoa(JSON.stringify(boundary))),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("not used"),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ ciphertext }) =>
        Effect.succeed(
          Uint8Array.from(atob(ciphertext.ciphertext), (value) =>
            value.charCodeAt(0),
          ),
        ),
      encrypt: () => Effect.die("not used"),
    }),
    Layer.succeed(McpToolPersistence, {
      beginToolCall: (input) => {
        observations.push("begin");
        if (overrides.failBegin) {
          return Effect.fail(new McpToolPersistenceError());
        }
        if (overrides.beginResult !== undefined) {
          return Effect.succeed(overrides.beginResult);
        }
        const requiredScope =
          input.toolName === "list_connections"
            ? "connections:read"
            : "directory:read";
        if (
          overrides.scopes !== undefined &&
          !overrides.scopes.includes(requiredScope)
        ) {
          return Effect.succeed({
            auditLogId: "50000000-0000-4000-8000-000000000030",
            outcome: "authorization_denied" as const,
          });
        }
        return Effect.succeed({
          auditLogId: "50000000-0000-4000-8000-000000000030",
          outcome: "started" as const,
        });
      },
      completeToolCall: () => {
        observations.push("complete");
        return overrides.failComplete
          ? Effect.fail(new McpToolPersistenceError())
          : Effect.void;
      },
      inspectAuthorization: () =>
        overrides.failInspect
          ? Effect.fail(new McpToolPersistenceError())
          : Effect.succeed({
              scopes: overrides.scopes ?? ["connections:read"],
            }),
      loadGroupSearchMaterial: () => {
        observations.push("load-group-search-material");
        return Effect.succeed({
          accountKey: {
            ciphertext: "AQID",
            keyVersion: 1,
            kmsKeyId:
              "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
            personalAccountId: "10000000-0000-4000-8000-000000000039",
            version: 1 as const,
          },
          connectionKey: {
            accountKeyVersion: 1,
            ciphertext: "AQID",
            connectionId: "20000000-0000-4000-8000-000000000039",
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            personalAccountId: "10000000-0000-4000-8000-000000000039",
            version: 1 as const,
          },
          identityKey: {
            ciphertext: btoa(
              String.fromCharCode(...new Uint8Array(32).fill(39)),
            ),
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            version: 1 as const,
          },
        });
      },
      listConnections: () => {
        observations.push("list");
        return Effect.succeed([
          {
            displayName: null,
            numberLastFour: "1234",
            publicId: "con_123456789012345678901",
            state: "connected" as const,
            stateChangedAt: "2026-07-30T12:00:00.000Z",
          },
        ]);
      },
      listGroups: (input) => {
        observations.push("list-groups");
        if (input.searchIndex !== null) {
          expect(input.searchIndex).toMatch(/^gi1_[A-Za-z0-9_-]{43}$/u);
        }
        return Effect.succeed(
          overrides.groupPage === undefined
            ? {
                accountKey: {
                  ciphertext: "AQID",
                  keyVersion: 1,
                  kmsKeyId:
                    "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
                  personalAccountId: "10000000-0000-4000-8000-000000000039",
                  version: 1 as const,
                },
                asOf: "2026-07-31T11:59:00.000Z",
                connectionKey: {
                  accountKeyVersion: 1,
                  ciphertext: "AQID",
                  connectionId: "20000000-0000-4000-8000-000000000039",
                  keyVersion: 1,
                  nonce: "AQIDBAUGBwgJCgsM",
                  personalAccountId: "10000000-0000-4000-8000-000000000039",
                  version: 1 as const,
                },
                groups: [
                  {
                    displayName: {
                      ciphertext: btoa("Family"),
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      version: 1 as const,
                    },
                    id: "30000000-0000-4000-8000-000000000039",
                    publicId: "grp_AAAAAAAAAAAAAAAAAAAAA",
                  },
                  {
                    displayName: {
                      ciphertext: btoa("Family"),
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      version: 1 as const,
                    },
                    id: "30000000-0000-4000-8000-000000000040",
                    publicId: "grp_aaaaaaaaaaaaaaaaaaaaa",
                  },
                ],
                partial: false,
                stale: false,
              }
            : overrides.groupPage,
        );
      },
      loadContactReadMaterial: () => {
        observations.push("material");
        return Effect.succeed({
          accountKey: {
            ciphertext: "AQI=",
            keyVersion: 1,
            kmsKeyId: "kms-content-root",
            personalAccountId: "10000000-0000-4000-8000-000000000030",
            version: 1 as const,
          },
          asOf: "2026-07-30T12:00:00.000Z",
          connectionKey: {
            accountKeyVersion: 1,
            ciphertext: "AQI=",
            connectionId: "20000000-0000-4000-8000-000000000030",
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            personalAccountId: "10000000-0000-4000-8000-000000000030",
            version: 1 as const,
          },
          identityKey: {
            ciphertext: btoa(
              String.fromCharCode(...new Uint8Array(32).fill(7)),
            ),
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            version: 1 as const,
          },
          partial: false,
          personalAccountId: "10000000-0000-4000-8000-000000000030",
          stale: false,
          whatsappConnectionId: "20000000-0000-4000-8000-000000000030",
        });
      },
      listEncryptedContacts: (input) => {
        observations.push("contacts");
        const encrypted = (value: string) => ({
          ciphertext: btoa(value),
          keyVersion: 1,
          nonce: "AQIDBAUGBwgJCgsM",
          version: 1 as const,
        });
        const contacts = [
          {
            displayNameCiphertext: encrypted("Grace"),
            displayNameSort: "grace",
            phoneCiphertext: null,
            providerIdentityIndex: `di1_${"g".repeat(43)}`,
            publicId: "ctc_123456789012345678902",
          },
          {
            displayNameCiphertext: encrypted("Ada"),
            displayNameSort: "ada",
            phoneCiphertext: encrypted("+15550199"),
            providerIdentityIndex: `di1_${"a".repeat(43)}`,
            publicId: "ctc_123456789012345678901",
          },
        ].sort((left, right) =>
          left.displayNameSort.localeCompare(right.displayNameSort),
        );
        return Effect.succeed({
          ...(overrides.contactPage ?? {
            asOf: "2026-07-30T12:00:00.000Z",
            partial: false,
            snapshotObservedAt: "2026-07-30T12:00:00.000Z",
            stale: false,
          }),
          contacts: contacts
            .filter(
              (contact) =>
                input.cursorDisplayNameSort === null ||
                contact.displayNameSort > input.cursorDisplayNameSort ||
                (contact.displayNameSort === input.cursorDisplayNameSort &&
                  contact.publicId > (input.cursorPublicId ?? "")),
            )
            .slice(0, input.limit),
        });
      },
      rejectToolCall: (input) => {
        observations.push("reject");
        if (overrides.failReject) {
          return Effect.fail(new McpToolPersistenceError());
        }
        const requiredScope =
          input.toolName === "list_connections"
            ? "connections:read"
            : "directory:read";
        return Effect.succeed(
          overrides.scopes !== undefined &&
            !overrides.scopes.includes(requiredScope)
            ? ("authorization_denied" as const)
            : ("rejected" as const),
        );
      },
    }),
    Layer.succeed(McpCursorSigning, {
      key: overrides.cursorKey ?? ({} as CryptoKey),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          telemetry.push(event);
        }),
    }),
  );

  return {
    handler: createMcpRequestHandler({
      browserOrigin: "https://app.example.test",
      hourLimit: 10,
      layer,
      minuteLimit: 2,
      resourceUrl: "https://api.example.test/mcp",
    }),
    observations,
    telemetry,
  };
};

describe("stateless MCP list_connections boundary", () => {
  test("scope-filters discovery and publishes closed exact schemas", async () => {
    const permitted = makeHarness();
    const response = await permitted.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          inputSchema: Record<string, unknown>;
          name: string;
          outputSchema: Record<string, unknown>;
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0]).toMatchObject({
      name: "list_connections",
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      outputSchema: {
        additionalProperties: false,
        type: "object",
      },
    });

    const omitted = makeHarness({ scopes: ["messages:send"] });
    const omittedResponse = await omitted.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    expect(await omittedResponse.json()).toMatchObject({
      result: { tools: [] },
    });
  });

  test("scope-filters discovery in a legacy-stateless JSON-RPC batch", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const request = new Request("https://api.example.test/mcp", {
      body: JSON.stringify([
        {
          id: "request-1",
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        },
      ]),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "api.example.test",
        "mcp-protocol-version": "2025-06-18",
      },
      method: "POST",
    });
    const response = await harness.handler(
      request,
      {},
      executionContext,
      authorization,
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      result: { tools: [] },
    });
  });

  test("audits a direct call in a scope-filtered legacy batch", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const request = new Request("https://api.example.test/mcp", {
      body: JSON.stringify([
        {
          id: "discovery-request",
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        },
        {
          id: "call-request",
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: {}, name: "list_connections" },
        },
      ]),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "api.example.test",
        "mcp-protocol-version": "2025-06-18",
      },
      method: "POST",
    });
    const response = await harness.handler(
      request,
      {},
      executionContext,
      authorization,
    );
    const messages = await responseMessages(response);

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "discovery-request",
          result: { tools: [] },
        }),
        expect.objectContaining({
          id: "call-request",
          result: expect.objectContaining({
            isError: true,
            structuredContent: expect.objectContaining({
              error_code: "authorization_denied",
            }),
          }),
        }),
      ]),
    );
    expect(harness.observations).toEqual(["begin"]);
  });

  test("audits before reading and returns structured/text parity without provider data", async () => {
    const harness = makeHarness();
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        content: Array<{ text: string; type: string }>;
        structuredContent: unknown;
      };
    };

    expect(response.status).toBe(200);
    expect(harness.observations).toEqual(["begin", "list", "complete"]);
    expect(body.result.structuredContent).toEqual({
      connections: [
        {
          connection_id: "con_123456789012345678901",
          display_name: null,
          number_last_four: "1234",
          state: "connected",
          state_changed_at: "2026-07-30T12:00:00.000Z",
        },
      ],
    });
    expect(body.result.content).toEqual([
      {
        text: JSON.stringify(body.result.structuredContent),
        type: "text",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("provider");
    expect(harness.telemetry).toEqual([
      {
        event: "mcp.tool_call.completed",
        outcome: "success",
        resultCount: 1,
        service: "api",
        tool: "list_connections",
      },
    ]);
  });

  test("fails closed with a safe execution error when initial audit is unavailable", async () => {
    const harness = makeHarness({ failBegin: true });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error_code: "audit_unavailable",
          retryable: true,
        },
      },
    });
    expect(harness.observations).toEqual(["begin"]);
    expect(harness.telemetry).toEqual([
      {
        event: "mcp.tool_call.completed",
        outcome: "audit_unavailable",
        service: "api",
        tool: "list_connections",
      },
    ]);
  });

  test("enters the audited handler before authorization discovery on a direct call", async () => {
    const harness = makeHarness({ failBegin: true, failInspect: true });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error_code: "audit_unavailable",
          retryable: true,
        },
      },
    });
    expect(harness.observations).toEqual(["begin"]);
  });

  test("audits and rechecks scope when an omitted tool is invoked directly", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error_code: "authorization_denied",
          retryable: false,
        },
      },
    });
    expect(harness.observations).toEqual(["begin"]);
  });

  test("maps an authoritative quota rejection to stable retry and reset details", async () => {
    const harness = makeHarness({
      beginResult: {
        auditLogId: "50000000-0000-4000-8000-000000000030",
        outcome: "rate_limited",
        resetsAt: new Date("2026-07-31T12:00:30.000Z"),
        retryAfterSeconds: 30,
      },
    });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        content: Array<{ text: string; type: string }>;
        structuredContent: unknown;
      };
    };

    expect(body.result.structuredContent).toEqual({
      error_code: "rate_limited",
      message: "The request quota is exhausted.",
      resets_at: "2026-07-31T12:00:30.000Z",
      retry_after_seconds: 30,
      retryable: true,
    });
    expect(body.result.content).toEqual([
      {
        text: JSON.stringify(body.result.structuredContent),
        type: "text",
      },
    ]);
    expect(harness.observations).toEqual(["begin"]);
  });

  test("does not release Connection metadata when audit completion fails", async () => {
    const harness = makeHarness({ failComplete: true });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );
    const serialized = JSON.stringify(await response.json());

    expect(serialized).toContain("audit_unavailable");
    expect(serialized).not.toContain("con_123456789012345678901");
    expect(harness.observations).toEqual(["begin", "list", "complete"]);
  });

  test("discovers both directory tools and returns deterministic suffix-only contact pages", async () => {
    const harness = makeHarness({ scopes: ["directory:read"] });
    const discovery = await harness.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    const discoveryBody = (await discovery.json()) as {
      result: {
        tools: Array<{
          inputSchema: Record<string, unknown>;
          name: string;
          outputSchema: Record<string, unknown>;
        }>;
      };
    };
    expect(discoveryBody.result.tools.map(({ name }) => name)).toEqual([
      "list_groups",
      "list_contacts",
    ]);
    expect(
      discoveryBody.result.tools.find(({ name }) => name === "list_contacts"),
    ).toMatchObject({
      inputSchema: expect.objectContaining({ additionalProperties: false }),
      outputSchema: expect.objectContaining({ additionalProperties: false }),
    });

    const first = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678901",
          limit: 1,
        },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );
    const firstBody = (await first.json()) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(firstBody.result.structuredContent).toEqual({
      as_of: "2026-07-30T12:00:00.000Z",
      contacts: [
        {
          contact_id: "ctc_123456789012345678901",
          display_name: "Ada",
          phone_last_four: "0199",
        },
      ],
      has_more: true,
      next_cursor: expect.any(String),
      partial: false,
      stale: true,
    });
    expect(JSON.stringify(firstBody)).not.toContain("+15550199");
    expect(harness.observations).toEqual([
      "begin",
      "material",
      "contacts",
      "complete",
    ]);

    const second = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678901",
          cursor: firstBody.result.structuredContent.next_cursor,
          limit: 1,
        },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await second.json()).toMatchObject({
      result: {
        structuredContent: {
          contacts: [
            {
              contact_id: "ctc_123456789012345678902",
              display_name: "Grace",
              phone_last_four: null,
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      },
    });
  });

  test("keeps provider reconciliation staleness visible when webhooks advance as_of", async () => {
    const harness = makeHarness({
      contactPage: {
        asOf: "2026-07-31T12:00:00.000Z",
        partial: false,
        snapshotObservedAt: "2026-07-31T11:40:00.000Z",
        stale: false,
      },
      scopes: ["directory:read"],
    });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: { connection_id: "con_123456789012345678901" },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        structuredContent: {
          as_of: "2026-07-31T12:00:00.000Z",
          stale: true,
        },
      },
    });
  });

  test("audits invalid cursors without reserving request quota", async () => {
    const harness = makeHarness({ scopes: ["directory:read"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678901",
          cursor: "not-a-cursor",
        },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error_code: "invalid_cursor" },
      },
    });
    expect(harness.observations).toEqual(["reject"]);
  });

  test("audits direct list_contacts calls and withholds Directory data when completion fails", async () => {
    const unauthorized = makeHarness({ scopes: ["connections:read"] });
    const denied = await unauthorized.handler(
      jsonRpcRequest("tools/call", {
        arguments: { connection_id: "con_123456789012345678901" },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await denied.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error_code: "authorization_denied" },
      },
    });
    expect(unauthorized.observations).toEqual(["begin"]);

    const unavailable = makeHarness({
      failComplete: true,
      scopes: ["directory:read"],
    });
    const response = await unavailable.handler(
      jsonRpcRequest("tools/call", {
        arguments: { connection_id: "con_123456789012345678901" },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("audit_unavailable");
    expect(serialized).not.toContain("Ada");
  });

  test("supports the legacy-stateless 2025 protocol lane", async () => {
    const harness = makeHarness();
    const request = jsonRpcRequest("tools/list", undefined, "2025-06-18");
    const response = await harness.handler(
      request,
      {},
      executionContext,
      authorization,
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      result: {
        tools: [{ name: "list_connections" }],
      },
    });
  });
});

describe("stateless MCP list_groups boundary", () => {
  test("scope-filters discovery to directory tools", async () => {
    const harness = makeHarness({ scopes: ["directory:read"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(body.result.tools.map(({ name }) => name)).toEqual([
      "list_groups",
      "list_contacts",
    ]);
  });

  test("audits before decrypting and returns normalized prefix results without provider data", async () => {
    const harness = makeHarness({ scopes: ["directory:read"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678939",
          search: "fam",
        },
        name: "list_groups",
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        content: Array<{ text: string; type: string }>;
        structuredContent: unknown;
      };
    };

    expect(harness.observations).toEqual([
      "begin",
      "load-group-search-material",
      "list-groups",
      "complete",
    ]);
    expect(body.result.structuredContent).toEqual({
      groups: [
        {
          display_name: "Family",
          group_id: "grp_AAAAAAAAAAAAAAAAAAAAA",
        },
        {
          display_name: "Family",
          group_id: "grp_aaaaaaaaaaaaaaaaaaaaa",
        },
      ],
      has_more: false,
      next_cursor: null,
      as_of: "2026-07-31T11:59:00.000Z",
      stale: false,
      partial: false,
    });
    expect(body.result.content[0]?.text).toBe(
      JSON.stringify(body.result.structuredContent),
    );
    expect(JSON.stringify(body)).not.toContain("provider");
  });

  test("returns authorization-bound keyset pages and rejects changed filters", async () => {
    const key = await Effect.runPromise(
      importCursorSigningKey(new Uint8Array(32).fill(39)),
    );
    const harness = makeHarness({
      cursorKey: key,
      scopes: ["directory:read"],
    });
    const first = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678939",
          limit: 1,
        },
        name: "list_groups",
      }),
      {},
      executionContext,
      authorization,
    );
    const firstBody = (await first.json()) as {
      result: {
        structuredContent: {
          groups: Array<{ group_id: string }>;
          has_more: boolean;
          next_cursor: string;
        };
      };
    };
    expect(firstBody.result.structuredContent).toMatchObject({
      groups: [{ group_id: "grp_AAAAAAAAAAAAAAAAAAAAA" }],
      has_more: true,
    });

    const second = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678939",
          cursor: firstBody.result.structuredContent.next_cursor,
          limit: 1,
        },
        name: "list_groups",
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await second.json()).toMatchObject({
      result: {
        structuredContent: {
          groups: [{ group_id: "grp_aaaaaaaaaaaaaaaaaaaaa" }],
          has_more: false,
          next_cursor: null,
        },
      },
    });

    const mismatch = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678939",
          cursor: firstBody.result.structuredContent.next_cursor,
          limit: 1,
          search: "wor",
        },
        name: "list_groups",
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await mismatch.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error_code: "invalid_cursor" },
      },
    });
  });
});
