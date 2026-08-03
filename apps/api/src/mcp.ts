import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  type CursorBoundary,
  type CursorContext,
  signCursor,
  verifyCursor,
} from "@whatsapp-mcp/contracts/cursor";
import { makeExecutionErrorResult } from "@whatsapp-mcp/contracts/mcp-error";
import { makeSuccessResultBuilder } from "@whatsapp-mcp/contracts/mcp-result";
import {
  type ListConnectionsOutput,
  ListConnectionsOutputContract,
  type ListGroupsOutput,
  ListGroupsOutputContract,
} from "@whatsapp-mcp/contracts/mcp-schema";
import type {
  BeginToolCallResult,
  McpAccessAuthorization,
  McpToolConnectionRecord,
  McpToolGroupPage,
  McpToolGroupSearchMaterial,
  McpToolName,
} from "@whatsapp-mcp/db/mcp-tool";
import { createMcpHandler } from "agents/mcp/server";
import { Context, Data, Effect, type Layer } from "effect";
import { z } from "zod";
import {
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import {
  groupSearchIndex,
  importGroupDirectoryIndexKey,
  normalizeGroupDisplayName,
} from "./group-privacy";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

export class McpToolPersistenceError extends Data.TaggedError(
  "McpToolPersistenceError",
) {}

export interface McpToolPersistenceService {
  readonly beginToolCall: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly hourLimit: number;
      readonly minuteLimit: number;
      readonly observedAt: Date;
      readonly toolName: McpToolName;
    },
  ) => Effect.Effect<BeginToolCallResult, McpToolPersistenceError>;
  readonly completeToolCall: (input: {
    readonly auditLogId: string;
    readonly completedAt: Date;
    readonly errorCode: string | null;
    readonly outcome: "authorization_denied" | "execution_error" | "success";
    readonly resultCount: number | null;
  }) => Effect.Effect<void, McpToolPersistenceError>;
  readonly inspectAuthorization: (
    input: McpAccessAuthorization & { readonly observedAt: Date },
  ) => Effect.Effect<
    {
      readonly scopes: ReadonlyArray<
        | "connections:read"
        | "directory:read"
        | "messages:read"
        | "messages:send"
      >;
    } | null,
    McpToolPersistenceError
  >;
  readonly listConnections: (
    input: McpAccessAuthorization & { readonly observedAt: Date },
  ) => Effect.Effect<
    ReadonlyArray<McpToolConnectionRecord> | null,
    McpToolPersistenceError
  >;
  readonly listGroups: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
      readonly searchIndex: string | null;
    },
  ) => Effect.Effect<McpToolGroupPage | null, McpToolPersistenceError>;
  readonly loadGroupSearchMaterial: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
    },
  ) => Effect.Effect<
    McpToolGroupSearchMaterial | null,
    McpToolPersistenceError
  >;
}

export const McpToolPersistence = Context.GenericTag<McpToolPersistenceService>(
  "@whatsapp-mcp/api/McpToolPersistence",
);

export interface McpToolClockService {
  readonly now: Effect.Effect<Date>;
}

export const McpToolClock = Context.GenericTag<McpToolClockService>(
  "@whatsapp-mcp/api/McpToolClock",
);

export interface McpToolIdentifiersService {
  readonly nextAuditLogId: Effect.Effect<string>;
}

export const McpToolIdentifiers = Context.GenericTag<McpToolIdentifiersService>(
  "@whatsapp-mcp/api/McpToolIdentifiers",
);

export interface McpCursorSigningService {
  readonly key: CryptoKey;
}

export const McpCursorSigning = Context.GenericTag<McpCursorSigningService>(
  "@whatsapp-mcp/api/McpCursorSigning",
);

export type McpToolRequirements =
  | McpToolClockService
  | McpToolIdentifiersService
  | McpToolPersistenceService
  | SafeTelemetryService
  | EnvelopeEncryption
  | McpCursorSigningService;

const ListConnectionsInput = z.object({}).strict();
const ListConnectionsOutputSchema = z
  .object({
    connections: z
      .array(
        z
          .object({
            connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
            display_name: z.string().nullable(),
            number_last_four: z
              .string()
              .regex(/^[0-9]{4}$/u)
              .nullable(),
            state: z.enum([
              "connected",
              "connecting",
              "disconnected",
              "reconnect_required",
              "degraded",
            ]),
            state_changed_at: z.iso.datetime(),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

const codePointLength = (value: string): number => Array.from(value).length;
const ListGroupsInput = z
  .object({
    connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
    search: z
      .string()
      .refine((value) => {
        const length = codePointLength(normalizeGroupDisplayName(value));
        return length >= 3 && length <= 64;
      }, "search must contain 3 to 64 characters")
      .optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(4_096).optional(),
  })
  .strict();
const ListGroupsOutputSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            group_id: z.string().regex(/^grp_[A-Za-z0-9_-]{21}$/u),
            display_name: z.string().nullable(),
          })
          .strict(),
      )
      .max(50),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    as_of: z.iso.datetime(),
    stale: z.boolean(),
    partial: z.boolean(),
  })
  .strict();

const buildListConnectionsResult = makeSuccessResultBuilder(
  ListConnectionsOutputContract,
);
const buildListGroupsResult = makeSuccessResultBuilder(
  ListGroupsOutputContract,
);

const auditUnavailable = () =>
  makeExecutionErrorResult({
    error_code: "audit_unavailable",
    message: "Tool audit is temporarily unavailable.",
    retryable: true,
  });

const authorizationDenied = () =>
  makeExecutionErrorResult({
    error_code: "authorization_denied",
    message: "The MCP Authorization does not permit this tool.",
    retryable: false,
  });

const serviceUnavailable = () =>
  makeExecutionErrorResult({
    error_code: "service_unavailable",
    message: "The service is temporarily unavailable.",
    retryable: true,
  });

const invalidCursor = () =>
  makeExecutionErrorResult({
    error_code: "invalid_cursor",
    message: "The pagination cursor is invalid or expired.",
    retryable: false,
  });

const rateLimited = (retryAfterSeconds: number, resetsAt: Date) =>
  makeExecutionErrorResult({
    error_code: "rate_limited",
    message: "The request quota is exhausted.",
    resets_at: resetsAt.toISOString(),
    retry_after_seconds: retryAfterSeconds,
    retryable: true,
  });

type McpToolOutcome =
  | "audit_unavailable"
  | "authorization_denied"
  | "rate_limited"
  | "service_unavailable"
  | "success";

const emitToolCompletion = (
  tool: McpToolName,
  outcome: McpToolOutcome,
  resultCount?: number,
): Effect.Effect<void, never, SafeTelemetryService> =>
  Effect.gen(function* () {
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      event: "mcp.tool_call.completed",
      outcome,
      ...(resultCount === undefined ? {} : { resultCount }),
      service: "api",
      tool,
    });
  });

const listConnections = (
  authorization: McpAccessAuthorization,
  hourLimit: number,
  minuteLimit: number,
): Effect.Effect<
  | ReturnType<typeof buildListConnectionsResult>
  | ReturnType<typeof auditUnavailable>,
  never,
  McpToolRequirements
> =>
  Effect.gen(function* () {
    const clock = yield* McpToolClock;
    const identifiers = yield* McpToolIdentifiers;
    const persistence = yield* McpToolPersistence;
    const auditLogId = yield* identifiers.nextAuditLogId;
    const startedAt = yield* clock.now;
    const started = yield* persistence
      .beginToolCall({
        ...authorization,
        auditLogId,
        hourLimit,
        minuteLimit,
        observedAt: startedAt,
        toolName: "list_connections",
      })
      .pipe(Effect.either);

    if (started._tag === "Left") {
      yield* emitToolCompletion("list_connections", "audit_unavailable");
      return auditUnavailable();
    }
    if (started.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("list_connections", "authorization_denied");
      return authorizationDenied();
    }
    if (started.right.outcome === "rate_limited") {
      yield* emitToolCompletion("list_connections", "rate_limited");
      return rateLimited(
        started.right.retryAfterSeconds,
        started.right.resetsAt,
      );
    }

    const readAt = yield* clock.now;
    const loaded = yield* persistence
      .listConnections({ ...authorization, observedAt: readAt })
      .pipe(Effect.either);
    if (loaded._tag === "Left") {
      const completedAt = yield* clock.now;
      const completed = yield* persistence
        .completeToolCall({
          auditLogId,
          completedAt,
          errorCode: "service_unavailable",
          outcome: "execution_error",
          resultCount: null,
        })
        .pipe(Effect.either);
      const outcome =
        completed._tag === "Left"
          ? ("audit_unavailable" as const)
          : ("service_unavailable" as const);
      yield* emitToolCompletion("list_connections", outcome);
      return completed._tag === "Left"
        ? auditUnavailable()
        : serviceUnavailable();
    }
    if (loaded.right === null) {
      const completedAt = yield* clock.now;
      const completed = yield* persistence
        .completeToolCall({
          auditLogId,
          completedAt,
          errorCode: "authorization_denied",
          outcome: "authorization_denied",
          resultCount: null,
        })
        .pipe(Effect.either);
      const outcome =
        completed._tag === "Left"
          ? ("audit_unavailable" as const)
          : ("authorization_denied" as const);
      yield* emitToolCompletion("list_connections", outcome);
      return completed._tag === "Left"
        ? auditUnavailable()
        : authorizationDenied();
    }

    const output: ListConnectionsOutput =
      ListConnectionsOutputContract.decodeUnknown({
        connections: loaded.right.map((connection) => ({
          connection_id: connection.publicId,
          display_name: connection.displayName,
          number_last_four: connection.numberLastFour,
          state: connection.state,
          state_changed_at: connection.stateChangedAt,
        })),
      });
    const result = buildListConnectionsResult(output);
    const completedAt = yield* clock.now;
    const completed = yield* persistence
      .completeToolCall({
        auditLogId,
        completedAt,
        errorCode: null,
        outcome: "success",
        resultCount: output.connections.length,
      })
      .pipe(Effect.either);
    yield* emitToolCompletion(
      "list_connections",
      completed._tag === "Left" ? "audit_unavailable" : "success",
      completed._tag === "Left" ? undefined : output.connections.length,
    );
    return completed._tag === "Left" ? auditUnavailable() : result;
  }).pipe(Effect.catchAll(() => Effect.succeed(auditUnavailable())));

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const listGroups = (
  authorization: McpAccessAuthorization,
  input: z.infer<typeof ListGroupsInput>,
  hourLimit: number,
  minuteLimit: number,
) =>
  Effect.gen(function* () {
    const clock = yield* McpToolClock;
    const identifiers = yield* McpToolIdentifiers;
    const persistence = yield* McpToolPersistence;
    const cursorSigning = yield* McpCursorSigning;
    const encryption = yield* EnvelopeEncryptionService;
    const startedAt = yield* clock.now;

    const normalizedSearch =
      input.search === undefined
        ? null
        : normalizeGroupDisplayName(input.search);
    const cursorContext: CursorContext = {
      authorizationId: authorization.authorizationId,
      connectionId: input.connection_id as CursorContext["connectionId"],
      filters: { search: normalizedSearch },
      pageSize: input.limit,
      sortVersion: "groups-normalized-name-v1",
      tool: "list_groups",
    };
    let boundary: CursorBoundary | null = null;
    if (input.cursor !== undefined) {
      const verified = yield* verifyCursor(
        cursorSigning.key,
        input.cursor,
        cursorContext,
        Math.floor(startedAt.valueOf() / 1_000),
      ).pipe(Effect.either);
      if (verified._tag === "Left") {
        return invalidCursor();
      }
      boundary = verified.right;
      if (
        boundary.length !== 2 ||
        typeof boundary[0] !== "string" ||
        typeof boundary[1] !== "string"
      ) {
        return invalidCursor();
      }
    }

    const auditLogId = yield* identifiers.nextAuditLogId;
    const started = yield* persistence
      .beginToolCall({
        ...authorization,
        auditLogId,
        hourLimit,
        minuteLimit,
        observedAt: startedAt,
        toolName: "list_groups",
      })
      .pipe(Effect.either);
    if (started._tag === "Left") {
      yield* emitToolCompletion("list_groups", "audit_unavailable");
      return auditUnavailable();
    }
    if (started.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("list_groups", "authorization_denied");
      return authorizationDenied();
    }
    if (started.right.outcome === "rate_limited") {
      yield* emitToolCompletion("list_groups", "rate_limited");
      return rateLimited(
        started.right.retryAfterSeconds,
        started.right.resetsAt,
      );
    }

    const failAfterAudit = (
      errorCode: "authorization_denied" | "service_unavailable",
    ) =>
      Effect.gen(function* () {
        const denied = errorCode === "authorization_denied";
        const completed = yield* persistence
          .completeToolCall({
            auditLogId,
            completedAt: yield* clock.now,
            errorCode,
            outcome: denied ? "authorization_denied" : "execution_error",
            resultCount: null,
          })
          .pipe(Effect.either);
        const outcome =
          completed._tag === "Left"
            ? "audit_unavailable"
            : denied
              ? "authorization_denied"
              : "service_unavailable";
        yield* emitToolCompletion("list_groups", outcome);
        return completed._tag === "Left"
          ? auditUnavailable()
          : denied
            ? authorizationDenied()
            : serviceUnavailable();
      });

    let searchIndex: string | null = null;
    if (normalizedSearch !== null) {
      const material = yield* persistence
        .loadGroupSearchMaterial({
          ...authorization,
          connectionPublicId: input.connection_id,
          observedAt: yield* clock.now,
        })
        .pipe(Effect.either);
      if (material._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      if (material.right === null) {
        return yield* failAfterAudit("authorization_denied");
      }
      const identityKey = yield* encryption
        .decrypt({
          accountKey: material.right.accountKey,
          ciphertext: material.right.identityKey,
          connectionKey: material.right.connectionKey,
          context: {
            accountId: material.right.accountKey.personalAccountId,
            connectionId: material.right.connectionKey.connectionId,
            entity: "whatsapp-connection",
            fieldOrObjectPurpose: "webhook-identity-key",
            recordId: material.right.connectionKey.connectionId,
          },
        })
        .pipe(Effect.either);
      if (identityKey._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const indexed = yield* Effect.acquireUseRelease(
        Effect.succeed(identityKey.right),
        (bytes) =>
          importGroupDirectoryIndexKey(bytes).pipe(
            Effect.flatMap((key) =>
              groupSearchIndex(
                key,
                material.right.connectionKey.connectionId,
                normalizedSearch,
              ),
            ),
          ),
        (bytes) => Effect.sync(() => bytes.fill(0)),
      ).pipe(Effect.either);
      if (indexed._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      searchIndex = indexed.right;
    }

    const readAt = yield* clock.now;
    const loaded = yield* persistence
      .listGroups({
        ...authorization,
        connectionPublicId: input.connection_id,
        observedAt: readAt,
        searchIndex,
      })
      .pipe(Effect.either);
    if (loaded._tag === "Left" || loaded.right === null) {
      return yield* failAfterAudit(
        loaded._tag === "Right"
          ? "authorization_denied"
          : "service_unavailable",
      );
    }

    const page = loaded.right;
    const decrypted = yield* Effect.forEach(page.groups, (group) =>
      group.displayName === null
        ? Effect.succeed({
            displayName: null as string | null,
            normalizedName: "",
            publicId: group.publicId,
          })
        : encryption
            .decrypt({
              accountKey: page.accountKey,
              ciphertext: group.displayName,
              connectionKey: page.connectionKey,
              context: {
                accountId: page.accountKey.personalAccountId,
                connectionId: page.connectionKey.connectionId,
                entity: "whatsapp-group",
                fieldOrObjectPurpose: "display-name",
                recordId: group.id,
              },
            })
            .pipe(
              Effect.flatMap((bytes) =>
                Effect.acquireUseRelease(
                  Effect.succeed(bytes),
                  (value) =>
                    Effect.try({
                      try: () =>
                        new TextDecoder("utf-8", {
                          fatal: true,
                          ignoreBOM: false,
                        }).decode(value),
                      catch: () => new McpToolPersistenceError(),
                    }),
                  (value) => Effect.sync(() => value.fill(0)),
                ),
              ),
              Effect.map((displayName) => ({
                displayName,
                normalizedName: normalizeGroupDisplayName(displayName),
                publicId: group.publicId,
              })),
            ),
    ).pipe(Effect.either);
    if (decrypted._tag === "Left") {
      const completed = yield* persistence
        .completeToolCall({
          auditLogId,
          completedAt: yield* clock.now,
          errorCode: "service_unavailable",
          outcome: "execution_error",
          resultCount: null,
        })
        .pipe(Effect.either);
      yield* emitToolCompletion(
        "list_groups",
        completed._tag === "Left" ? "audit_unavailable" : "service_unavailable",
      );
      return completed._tag === "Left"
        ? auditUnavailable()
        : serviceUnavailable();
    }

    const ordered = decrypted.right
      .filter(
        (group) =>
          normalizedSearch === null ||
          group.normalizedName.startsWith(normalizedSearch),
      )
      .sort(
        (left, right) =>
          compareText(left.normalizedName, right.normalizedName) ||
          compareText(left.publicId, right.publicId),
      )
      .filter((group) => {
        if (boundary === null) return true;
        const [name, publicId] = boundary as readonly [string, string];
        return (
          compareText(group.normalizedName, name) > 0 ||
          (group.normalizedName === name &&
            compareText(group.publicId, publicId) > 0)
        );
      });
    const selected = ordered.slice(0, input.limit);
    const hasMore = ordered.length > input.limit;
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = selected.at(-1);
      if (last === undefined) return serviceUnavailable();
      nextCursor = yield* signCursor(cursorSigning.key, {
        boundary: [last.normalizedName, last.publicId],
        context: cursorContext,
        expiresAtEpochSeconds: Math.floor(startedAt.valueOf() / 1_000) + 900,
      });
    }
    const asOf = new Date(page.asOf);
    const output: ListGroupsOutput = ListGroupsOutputContract.decodeUnknown({
      groups: selected.map((group) => ({
        display_name: group.displayName,
        group_id: group.publicId,
      })),
      has_more: hasMore,
      next_cursor: nextCursor,
      as_of: page.asOf,
      stale:
        page.stale || readAt.valueOf() - asOf.valueOf() > 2 * 60 * 60 * 1_000,
      partial: page.partial,
    });
    const result = buildListGroupsResult(output);
    const completed = yield* persistence
      .completeToolCall({
        auditLogId,
        completedAt: yield* clock.now,
        errorCode: null,
        outcome: "success",
        resultCount: output.groups.length,
      })
      .pipe(Effect.either);
    yield* emitToolCompletion(
      "list_groups",
      completed._tag === "Left" ? "audit_unavailable" : "success",
      completed._tag === "Left" ? undefined : output.groups.length,
    );
    return completed._tag === "Left" ? auditUnavailable() : result;
  }).pipe(Effect.catchAll(() => Effect.succeed(auditUnavailable())));

const noStore = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const unavailable = (): Response =>
  new Response(JSON.stringify({ error: "service_unavailable" }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status: 503,
  });

export interface McpRequestHandlerOptions {
  readonly browserOrigin: string;
  readonly hourLimit: number;
  readonly layer: Layer.Layer<McpToolRequirements, unknown>;
  readonly minuteLimit: number;
  readonly resourceUrl: string;
}

const isToolsListPayload = (payload: unknown): boolean => {
  const messages = Array.isArray(payload) ? payload : [payload];
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "method" in message &&
      message.method === "tools/list",
  );
};

export const createMcpRequestHandler =
  (options: McpRequestHandlerOptions) =>
  async (
    request: Request,
    environment: unknown,
    context: ExecutionContext,
    authorization: McpAccessAuthorization,
  ): Promise<Response> => {
    const isToolsListRequest = await request
      .clone()
      .json()
      .then(isToolsListPayload)
      .catch(() => false);
    let hasConnectionsRead = true;
    let hasDirectoryRead = true;
    if (isToolsListRequest) {
      try {
        const inspected = await Effect.runPromise(
          Effect.gen(function* () {
            const clock = yield* McpToolClock;
            const persistence = yield* McpToolPersistence;
            return yield* persistence.inspectAuthorization({
              ...authorization,
              observedAt: yield* clock.now,
            });
          }).pipe(Effect.provide(options.layer)),
        );
        hasConnectionsRead =
          inspected?.scopes.includes("connections:read") === true;
        hasDirectoryRead =
          inspected?.scopes.includes("directory:read") === true;
      } catch {
        return unavailable();
      }
    }

    const factory = () => {
      const server = new McpServer({
        name: "WhatsApp MCP",
        version: "0.1.0",
      });
      server.registerTool(
        "list_connections",
        {
          description:
            "List every non-deleted WhatsApp Connection selected by the current MCP Authorization.",
          inputSchema: ListConnectionsInput,
          outputSchema: ListConnectionsOutputSchema,
          title: "List WhatsApp Connections",
        },
        async () => {
          const result = await Effect.runPromise(
            listConnections(
              authorization,
              options.hourLimit,
              options.minuteLimit,
            ).pipe(Effect.provide(options.layer)),
          );
          return {
            ...result,
            content: result.content.map((block) => ({ ...block })),
          } as CallToolResult;
        },
      );
      server.registerTool(
        "list_groups",
        {
          description:
            "List currently joined groups in one selected WhatsApp Connection without roster or provider metadata.",
          inputSchema: ListGroupsInput,
          outputSchema: ListGroupsOutputSchema,
          title: "List WhatsApp Groups",
        },
        async (input) => {
          const result = await Effect.runPromise(
            listGroups(
              authorization,
              input,
              options.hourLimit,
              options.minuteLimit,
            ).pipe(Effect.provide(options.layer)),
          );
          return {
            ...result,
            content: result.content.map((block) => ({ ...block })),
          } as CallToolResult;
        },
      );
      if (!hasConnectionsRead || !hasDirectoryRead) {
        const tools: Array<Record<string, unknown>> = [];
        if (hasConnectionsRead) {
          tools.push({
            description:
              "List every non-deleted WhatsApp Connection selected by the current MCP Authorization.",
            inputSchema: z.toJSONSchema(ListConnectionsInput, {
              target: "draft-2020-12",
            }),
            name: "list_connections",
            outputSchema: z.toJSONSchema(ListConnectionsOutputSchema, {
              target: "draft-2020-12",
            }),
            title: "List WhatsApp Connections",
          });
        }
        if (hasDirectoryRead) {
          tools.push({
            description:
              "List currently joined groups in one selected WhatsApp Connection without roster or provider metadata.",
            inputSchema: z.toJSONSchema(ListGroupsInput, {
              target: "draft-2020-12",
            }),
            name: "list_groups",
            outputSchema: z.toJSONSchema(ListGroupsOutputSchema, {
              target: "draft-2020-12",
            }),
            title: "List WhatsApp Groups",
          });
        }
        server.server.setRequestHandler("tools/list", () => ({
          tools: tools as never,
        }));
      }
      return server;
    };

    const resource = new URL(options.resourceUrl);
    const browser = new URL(options.browserOrigin);
    const handler = createMcpHandler(factory, {
      allowedHostnames: [resource.hostname],
      allowedOriginHostnames: [browser.hostname],
      authContext: { props: { ...authorization } },
      corsOptions: {
        origin: options.browserOrigin,
      },
      legacy: "stateless",
      responseMode: "json",
      route: resource.pathname,
    });
    return noStore(await handler(request, environment, context));
  };
