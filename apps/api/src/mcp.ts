import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  type CursorBoundary,
  type CursorContext,
  type InvalidCursorError,
  signCursor,
  verifyCursor,
} from "@whatsapp-mcp/contracts/cursor";
import { makeExecutionErrorResult } from "@whatsapp-mcp/contracts/mcp-error";
import { makeSuccessResultBuilder } from "@whatsapp-mcp/contracts/mcp-result";
import {
  type ListConnectionsOutput,
  ListConnectionsOutputContract,
  type ListContactsOutput,
  ListContactsOutputContract,
} from "@whatsapp-mcp/contracts/mcp-schema";
import type {
  BeginToolCallResult,
  McpAccessAuthorization,
  McpToolConnectionRecord,
  McpToolContactReadMaterial,
  McpToolEncryptedContactRecord,
} from "@whatsapp-mcp/db/mcp-tool";
import { createMcpHandler } from "agents/mcp/server";
import { Context, Data, Effect, type Layer } from "effect";
import { z } from "zod";
import {
  contactSearchIndex,
  decryptDirectoryString,
  importDirectoryIndexKey,
  normalizeContactDisplayName,
} from "./directory-privacy";
import {
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
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
      readonly toolName: "list_connections" | "list_contacts";
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
  readonly loadContactReadMaterial: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
    },
  ) => Effect.Effect<
    McpToolContactReadMaterial | null,
    McpToolPersistenceError
  >;
  readonly listEncryptedContacts: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly cursorDisplayNameSort: string | null;
      readonly cursorPublicId: string | null;
      readonly limit: number;
      readonly observedAt: Date;
      readonly searchIndex: string | null;
      readonly searchKind: "name" | "phone" | null;
    },
  ) => Effect.Effect<
    ReadonlyArray<McpToolEncryptedContactRecord> | null,
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

export interface McpCursorCodecService {
  readonly decode: (input: {
    readonly context: CursorContext;
    readonly cursor: string;
    readonly nowEpochSeconds: number;
  }) => Effect.Effect<CursorBoundary, InvalidCursorError>;
  readonly encode: (input: {
    readonly boundary: CursorBoundary;
    readonly context: CursorContext;
    readonly expiresAtEpochSeconds: number;
  }) => Effect.Effect<string, McpToolPersistenceError>;
}

export const McpCursorCodec = Context.GenericTag<McpCursorCodecService>(
  "@whatsapp-mcp/api/McpCursorCodec",
);

export const makeMcpCursorCodec = (key: CryptoKey): McpCursorCodecService => ({
  decode: ({ context, cursor, nowEpochSeconds }) =>
    verifyCursor(key, cursor, context, nowEpochSeconds),
  encode: ({ boundary, context, expiresAtEpochSeconds }) =>
    signCursor(key, { boundary, context, expiresAtEpochSeconds }).pipe(
      Effect.mapError(() => new McpToolPersistenceError()),
    ),
});

export type McpToolRequirements =
  | EnvelopeEncryption
  | McpCursorCodecService
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

const ListContactsInput = z
  .object({
    connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    search: z
      .string()
      .refine((value) => {
        if (value.startsWith("+")) return /^\+[1-9]\d{6,14}$/u.test(value);
        const length = Array.from(normalizeContactDisplayName(value)).length;
        return length >= 3 && length <= 64;
      })
      .optional(),
  })
  .strict();

const ListContactsOutputSchema = z
  .object({
    as_of: z.iso.datetime(),
    contacts: z
      .array(
        z
          .object({
            contact_id: z.string().regex(/^ctc_[A-Za-z0-9_-]{21}$/u),
            display_name: z.string().nullable(),
            phone_last_four: z
              .string()
              .regex(/^[0-9]{4}$/u)
              .nullable(),
          })
          .strict(),
      )
      .max(50),
    has_more: z.boolean(),
    next_cursor: z.string().min(1).nullable(),
    partial: z.boolean(),
    stale: z.boolean(),
  })
  .strict();

const buildListConnectionsResult = makeSuccessResultBuilder(
  ListConnectionsOutputContract,
);
const buildListContactsResult = makeSuccessResultBuilder(
  ListContactsOutputContract,
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
  | "invalid_cursor"
  | "rate_limited"
  | "service_unavailable"
  | "success";

const emitToolCompletion = (
  tool: "list_connections" | "list_contacts",
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

interface OpenContact {
  readonly displayName: string | null;
  readonly normalizedDisplayName: string;
  readonly phoneLastFour: string | null;
  readonly publicId: string;
}

const listContacts = (
  authorization: McpAccessAuthorization,
  input: z.infer<typeof ListContactsInput>,
  hourLimit: number,
  minuteLimit: number,
) =>
  Effect.gen(function* () {
    const clock = yield* McpToolClock;
    const cursors = yield* McpCursorCodec;
    const persistence = yield* McpToolPersistence;
    const identifiers = yield* McpToolIdentifiers;
    const encryption = yield* EnvelopeEncryptionService;
    const startedAt = yield* clock.now;
    const normalizedSearch =
      input.search === undefined
        ? null
        : /^\+/u.test(input.search)
          ? input.search
          : normalizeContactDisplayName(input.search);
    const cursorContext: CursorContext = {
      authorizationId: authorization.authorizationId,
      connectionId: input.connection_id as CursorContext["connectionId"],
      filters: { search: normalizedSearch },
      pageSize: input.limit,
      sortVersion: "contacts-v1",
      tool: "list_contacts",
    };
    let boundary: readonly [string, string] | null = null;
    if (input.cursor !== undefined) {
      const decoded = yield* cursors
        .decode({
          context: cursorContext,
          cursor: input.cursor,
          nowEpochSeconds: Math.floor(startedAt.valueOf() / 1_000),
        })
        .pipe(Effect.either);
      if (
        decoded._tag === "Left" ||
        decoded.right.length !== 2 ||
        typeof decoded.right[0] !== "string" ||
        typeof decoded.right[1] !== "string" ||
        !/^ctc_[A-Za-z0-9_-]{21}$/u.test(decoded.right[1])
      ) {
        yield* emitToolCompletion("list_contacts", "invalid_cursor");
        return invalidCursor();
      }
      boundary = [decoded.right[0], decoded.right[1]];
    }

    const auditLogId = yield* identifiers.nextAuditLogId;
    const started = yield* persistence
      .beginToolCall({
        ...authorization,
        auditLogId,
        hourLimit,
        minuteLimit,
        observedAt: startedAt,
        toolName: "list_contacts",
      })
      .pipe(Effect.either);
    if (started._tag === "Left") {
      yield* emitToolCompletion("list_contacts", "audit_unavailable");
      return auditUnavailable();
    }
    if (started.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("list_contacts", "authorization_denied");
      return authorizationDenied();
    }
    if (started.right.outcome === "rate_limited") {
      yield* emitToolCompletion("list_contacts", "rate_limited");
      return rateLimited(
        started.right.retryAfterSeconds,
        started.right.resetsAt,
      );
    }

    const failAfterAudit = (errorCode: string, denied = false) =>
      Effect.gen(function* () {
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
            ? ("audit_unavailable" as const)
            : denied
              ? ("authorization_denied" as const)
              : ("service_unavailable" as const);
        yield* emitToolCompletion("list_contacts", outcome);
        return completed._tag === "Left"
          ? auditUnavailable()
          : denied
            ? authorizationDenied()
            : serviceUnavailable();
      });

    const materialResult = yield* persistence
      .loadContactReadMaterial({
        ...authorization,
        connectionPublicId: input.connection_id,
        observedAt: yield* clock.now,
      })
      .pipe(Effect.either);
    if (materialResult._tag === "Left") {
      return yield* failAfterAudit("service_unavailable");
    }
    const material = materialResult.right;
    if (material === null) {
      return yield* failAfterAudit("authorization_denied", true);
    }
    const identityBytesResult = yield* encryption
      .decrypt({
        accountKey: material.accountKey,
        ciphertext: material.identityKey,
        connectionKey: material.connectionKey,
        context: {
          accountId: material.personalAccountId,
          connectionId: material.whatsappConnectionId,
          entity: "whatsapp-connection",
          fieldOrObjectPurpose: "webhook-identity-key",
          recordId: material.whatsappConnectionId,
        },
      })
      .pipe(Effect.either);
    if (identityBytesResult._tag === "Left") {
      return yield* failAfterAudit("service_unavailable");
    }

    const openedResult = yield* Effect.acquireUseRelease(
      Effect.succeed(identityBytesResult.right),
      (identityBytes) =>
        Effect.gen(function* () {
          const indexKey = yield* importDirectoryIndexKey(identityBytes);
          const search =
            normalizedSearch === null
              ? null
              : yield* contactSearchIndex(
                  indexKey,
                  material.whatsappConnectionId,
                  normalizedSearch,
                );
          const encrypted = yield* persistence.listEncryptedContacts({
            ...authorization,
            connectionPublicId: input.connection_id,
            cursorDisplayNameSort: boundary?.[0] ?? null,
            cursorPublicId: boundary?.[1] ?? null,
            limit: input.limit + 1,
            observedAt: yield* clock.now,
            searchIndex: search?.index ?? null,
            searchKind: search?.kind ?? null,
          });
          if (encrypted === null) {
            return null;
          }
          return yield* Effect.forEach(
            encrypted,
            (contact) =>
              Effect.gen(function* () {
                const common = {
                  accountKey: material.accountKey,
                  connectionKey: material.connectionKey,
                  encryption,
                  providerIdentityIndex: contact.providerIdentityIndex,
                } as const;
                const [displayName, phoneNumber] = yield* Effect.all(
                  [
                    decryptDirectoryString({
                      ...common,
                      ciphertext: contact.displayNameCiphertext,
                      field: "display-name",
                    }),
                    decryptDirectoryString({
                      ...common,
                      ciphertext: contact.phoneCiphertext,
                      field: "phone-number",
                    }),
                  ],
                  { concurrency: "unbounded" },
                );
                if (
                  (displayName === null
                    ? ""
                    : normalizeContactDisplayName(displayName)) !==
                    contact.displayNameSort ||
                  (phoneNumber !== null &&
                    !/^\+[1-9]\d{6,14}$/u.test(phoneNumber))
                ) {
                  return yield* Effect.fail(new McpToolPersistenceError());
                }
                return {
                  displayName,
                  normalizedDisplayName: contact.displayNameSort,
                  phoneLastFour:
                    phoneNumber === null ? null : phoneNumber.slice(-4),
                  publicId: contact.publicId,
                } satisfies OpenContact;
              }),
            { concurrency: 16 },
          );
        }),
      (identityBytes) =>
        Effect.sync(() => {
          identityBytes.fill(0);
        }),
    ).pipe(Effect.either);
    if (openedResult._tag === "Left") {
      return yield* failAfterAudit("service_unavailable");
    }
    if (openedResult.right === null) {
      return yield* failAfterAudit("authorization_denied", true);
    }

    const hasMore = openedResult.right.length > input.limit;
    const page = openedResult.right.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursorResult =
      hasMore && last !== undefined
        ? yield* cursors
            .encode({
              boundary: [last.normalizedDisplayName, last.publicId],
              context: cursorContext,
              expiresAtEpochSeconds:
                Math.floor(startedAt.valueOf() / 1_000) + 900,
            })
            .pipe(
              Effect.map((cursor) => cursor as string | null),
              Effect.either,
            )
        : ({ _tag: "Right", right: null } as const);
    if (nextCursorResult._tag === "Left") {
      return yield* failAfterAudit("service_unavailable");
    }
    const asOf = new Date(material.asOf);
    const outputResult = Effect.try({
      try: () =>
        ListContactsOutputContract.decodeUnknown({
          as_of: material.asOf,
          contacts: page.map((contact) => ({
            contact_id: contact.publicId,
            display_name: contact.displayName,
            phone_last_four: contact.phoneLastFour,
          })),
          has_more: hasMore,
          next_cursor: nextCursorResult.right,
          partial: material.partial,
          stale:
            material.stale ||
            !Number.isFinite(asOf.valueOf()) ||
            startedAt.valueOf() - asOf.valueOf() > 10 * 60 * 1_000,
        }),
      catch: () => new McpToolPersistenceError(),
    });
    const decodedOutput = yield* outputResult.pipe(Effect.either);
    if (decodedOutput._tag === "Left") {
      return yield* failAfterAudit("service_unavailable");
    }
    const output: ListContactsOutput = decodedOutput.right;
    const completed = yield* persistence
      .completeToolCall({
        auditLogId,
        completedAt: yield* clock.now,
        errorCode: null,
        outcome: "success",
        resultCount: output.contacts.length,
      })
      .pipe(Effect.either);
    yield* emitToolCompletion(
      "list_contacts",
      completed._tag === "Left" ? "audit_unavailable" : "success",
      completed._tag === "Left" ? undefined : output.contacts.length,
    );
    return completed._tag === "Left"
      ? auditUnavailable()
      : buildListContactsResult(output);
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
        "list_contacts",
        {
          description:
            "List active contacts in one selected WhatsApp Connection with suffix-only phone metadata.",
          inputSchema: ListContactsInput,
          outputSchema: ListContactsOutputSchema,
          title: "List WhatsApp Contacts",
        },
        async (input) => {
          const result = await Effect.runPromise(
            listContacts(
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
        server.server.setRequestHandler(
          "tools/list",
          () =>
            ({
              tools: [
                ...(hasConnectionsRead
                  ? [
                      {
                        description:
                          "List every non-deleted WhatsApp Connection selected by the current MCP Authorization.",
                        inputSchema: z.toJSONSchema(ListConnectionsInput),
                        name: "list_connections",
                        outputSchema: z.toJSONSchema(
                          ListConnectionsOutputSchema,
                        ),
                        title: "List WhatsApp Connections",
                      },
                    ]
                  : []),
                ...(hasDirectoryRead
                  ? [
                      {
                        description:
                          "List active contacts in one selected WhatsApp Connection with suffix-only phone metadata.",
                        inputSchema: z.toJSONSchema(ListContactsInput),
                        name: "list_contacts",
                        outputSchema: z.toJSONSchema(ListContactsOutputSchema),
                        title: "List WhatsApp Contacts",
                      },
                    ]
                  : []),
              ],
            }) as never,
        );
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
