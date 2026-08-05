import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { makeDatabase, withPgQueryConnection } from "./database";
import type {
  PersonalAccountConnection,
  PersonalAccountConnectionProvider,
} from "./personal-account";
import {
  mcpAuthorizationsInApp,
  personalAccountsInApp,
  sendOperationsInApp,
  toolCallLogsInApp,
  whatsappConnectionsInApp,
} from "./schema";
import { withTransaction } from "./transaction";

export interface ToolCallLogSummary {
  readonly authorizationId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly completedAt: Date | null;
  readonly connectionId: string | null;
  readonly errorCode: string | null;
  readonly latencyMs: number | null;
  readonly mediaBytes: number;
  readonly outcome:
    | "started"
    | "success"
    | "execution_error"
    | "rate_limited"
    | "authorization_denied";
  readonly resultCount: number | null;
  readonly sendId: string | null;
  readonly startedAt: Date;
  readonly toolName: string;
}

export interface ToolCallLogPage {
  readonly logs: ReadonlyArray<ToolCallLogSummary>;
  readonly nextCursor: string | null;
}

export interface ToolCallLogRepository {
  readonly listForUser: (
    clerkUserId: string,
    observedAt: Date,
    cursor: string | null,
    limit: number,
  ) => Promise<ToolCallLogPage | null>;
  readonly purgeExpired: (limit: number) => Promise<number>;
}

export const makeToolCallLogRepository = (
  provider: PersonalAccountConnectionProvider,
): ToolCallLogRepository => ({
  listForUser: (clerkUserId, observedAt, cursor, limit) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new Error("invalid Tool Call Log page limit");
        }
        const context = await db.execute<{
          personal_account_id: string | null;
        }>(sql`
          SELECT public.bootstrap_personal_account_for_clerk(${clerkUserId})
            AS personal_account_id
        `);
        const personalAccountId = context[0]?.personal_account_id;
        if (typeof personalAccountId !== "string") return null;
        await db.execute(
          sql`SELECT set_config('public.personal_account_id', ${personalAccountId}, true)`,
        );
        const account = await db
          .select({ id: personalAccountsInApp.id })
          .from(personalAccountsInApp)
          .where(
            and(
              eq(personalAccountsInApp.id, personalAccountId),
              eq(personalAccountsInApp.state, "active"),
            ),
          );
        if (account.length !== 1) return null;

        const boundary =
          cursor === null
            ? undefined
            : (
                await db
                  .select({
                    publicId: toolCallLogsInApp.publicId,
                    startedAt: toolCallLogsInApp.startedAt,
                  })
                  .from(toolCallLogsInApp)
                  .where(
                    and(
                      eq(
                        toolCallLogsInApp.personalAccountId,
                        personalAccountId,
                      ),
                      eq(toolCallLogsInApp.publicId, cursor),
                    ),
                  )
              )[0];
        const result =
          cursor !== null && boundary === undefined
            ? []
            : await db
                .select({
                  authorizationPublicId:
                    sql<string>`${mcpAuthorizationsInApp.publicId}`.as(
                      "authorization_public_id",
                    ),
                  clientId: mcpAuthorizationsInApp.clientId,
                  clientName: mcpAuthorizationsInApp.clientName,
                  completedAt: toolCallLogsInApp.completedAt,
                  connectionPublicId: sql<string | null>`COALESCE(
                    ${toolCallLogsInApp.connectionPublicId},
                    ${whatsappConnectionsInApp.publicId}
                  )`.as("connection_public_id"),
                  errorCode: toolCallLogsInApp.errorCode,
                  latencyMs: toolCallLogsInApp.latencyMs,
                  mediaBytesReserved: toolCallLogsInApp.mediaBytesReserved,
                  outcome: toolCallLogsInApp.outcome,
                  publicId: sql<string>`${toolCallLogsInApp.publicId}`.as(
                    "log_public_id",
                  ),
                  resultCount: toolCallLogsInApp.resultCount,
                  sendPublicId: sql<string | null>`COALESCE(
                    ${toolCallLogsInApp.sendPublicId}, ${sendOperationsInApp.publicId}
                  )`.as("send_public_id"),
                  startedAt: toolCallLogsInApp.startedAt,
                  toolName: toolCallLogsInApp.toolName,
                })
                .from(toolCallLogsInApp)
                .innerJoin(
                  mcpAuthorizationsInApp,
                  and(
                    eq(
                      mcpAuthorizationsInApp.personalAccountId,
                      toolCallLogsInApp.personalAccountId,
                    ),
                    eq(
                      mcpAuthorizationsInApp.id,
                      toolCallLogsInApp.mcpAuthorizationId,
                    ),
                  ),
                )
                .leftJoin(
                  sendOperationsInApp,
                  and(
                    eq(
                      sendOperationsInApp.personalAccountId,
                      toolCallLogsInApp.personalAccountId,
                    ),
                    eq(sendOperationsInApp.toolCallLogId, toolCallLogsInApp.id),
                  ),
                )
                .leftJoin(
                  whatsappConnectionsInApp,
                  and(
                    eq(
                      whatsappConnectionsInApp.personalAccountId,
                      sendOperationsInApp.personalAccountId,
                    ),
                    eq(
                      whatsappConnectionsInApp.id,
                      sendOperationsInApp.whatsappConnectionId,
                    ),
                  ),
                )
                .where(
                  and(
                    eq(toolCallLogsInApp.personalAccountId, personalAccountId),
                    gt(toolCallLogsInApp.expiresAt, observedAt.toISOString()),
                    boundary === undefined
                      ? undefined
                      : or(
                          lt(toolCallLogsInApp.startedAt, boundary.startedAt),
                          and(
                            eq(toolCallLogsInApp.startedAt, boundary.startedAt),
                            lt(toolCallLogsInApp.publicId, boundary.publicId),
                          ),
                        ),
                  ),
                )
                .orderBy(
                  desc(toolCallLogsInApp.startedAt),
                  desc(toolCallLogsInApp.publicId),
                )
                .limit(limit + 1);
        const pageRows = result.slice(0, limit);
        const logs = pageRows.map((row) => ({
          authorizationId: row.authorizationPublicId,
          clientId: row.clientId,
          clientName: row.clientName ?? row.clientId,
          completedAt:
            row.completedAt === null ? null : new Date(row.completedAt),
          connectionId: row.connectionPublicId,
          errorCode: row.errorCode,
          latencyMs: row.latencyMs,
          mediaBytes: Number(row.mediaBytesReserved),
          outcome: row.outcome as ToolCallLogSummary["outcome"],
          resultCount: row.resultCount,
          sendId: row.sendPublicId,
          startedAt: new Date(row.startedAt),
          toolName: row.toolName,
        }));
        return {
          logs,
          nextCursor:
            result.length > limit ? (pageRows.at(-1)?.publicId ?? null) : null,
        };
      }),
    ),
  purgeExpired: (limit) =>
    provider.withConnection(async (connection) => {
      const result = await makeDatabase(connection).execute<{ purged: number }>(
        sql`SELECT public.purge_expired_tool_call_logs(${limit}) AS purged`,
      );
      return Number(result[0]?.purged ?? 0);
    }),
});

const makePgConnectionProvider = (
  connectionString: string,
): PersonalAccountConnectionProvider => ({
  withConnection: (use) => withPgQueryConnection(connectionString, use),
});

export const makePgToolCallLogRepository = (
  connectionString: string,
): ToolCallLogRepository =>
  makeToolCallLogRepository(makePgConnectionProvider(connectionString));
