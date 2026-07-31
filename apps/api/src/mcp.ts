import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { makeExecutionErrorResult } from "@whatsapp-mcp/contracts/mcp-error";
import { makeSuccessResultBuilder } from "@whatsapp-mcp/contracts/mcp-result";
import {
  type ListConnectionsOutput,
  ListConnectionsOutputContract,
} from "@whatsapp-mcp/contracts/mcp-schema";
import type {
  BeginToolCallResult,
  McpAccessAuthorization,
  McpToolConnectionRecord,
} from "@whatsapp-mcp/db/mcp-tool";
import { createMcpHandler } from "agents/mcp/server";
import { Context, Data, Effect, type Layer } from "effect";
import { z } from "zod";
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
      readonly toolName: "list_connections";
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

export type McpToolRequirements =
  | McpToolClockService
  | McpToolIdentifiersService
  | McpToolPersistenceService
  | SafeTelemetryService;

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

const buildListConnectionsResult = makeSuccessResultBuilder(
  ListConnectionsOutputContract,
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
      tool: "list_connections",
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
      yield* emitToolCompletion("audit_unavailable");
      return auditUnavailable();
    }
    if (started.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("authorization_denied");
      return authorizationDenied();
    }
    if (started.right.outcome === "rate_limited") {
      yield* emitToolCompletion("rate_limited");
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
      yield* emitToolCompletion(outcome);
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
      yield* emitToolCompletion(outcome);
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
      completed._tag === "Left" ? "audit_unavailable" : "success",
      completed._tag === "Left" ? undefined : output.connections.length,
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
      if (!hasConnectionsRead) {
        server.server.setRequestHandler("tools/list", () => ({ tools: [] }));
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
