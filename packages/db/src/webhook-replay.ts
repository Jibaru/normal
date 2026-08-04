import { sql } from "drizzle-orm";
import type { Client as PgClient } from "pg";
import {
  makeDatabase,
  makeQueryConnection,
  type QueryConnection,
} from "./database";

export type WebhookReplayReasonCode =
  | "dependency_recovered"
  | "schema_support_deployed"
  | "transient_incident_resolved";

export interface WebhookReplayQueueMessage {
  readonly ciphertext_sha256: string;
  readonly object_id: string;
  readonly payload_bytes: number;
  readonly personal_account_id: string;
  readonly received_at: string;
  readonly version: 1;
  readonly whatsapp_connection_id: string;
}

export interface PrepareWebhookReplayInput {
  readonly incidentReference: string;
  readonly observedAt: string;
  readonly operatorReference: string;
  readonly reasonCode: WebhookReplayReasonCode;
  readonly requestId: string;
  readonly requestedAt: string;
}

export type PrepareWebhookReplayResult =
  | { readonly outcome: "source_unavailable" }
  | {
      readonly message: WebhookReplayQueueMessage;
      readonly outcome: "already_dispatched" | "pending";
    };

export interface WebhookReplayRepository {
  readonly complete: (input: {
    readonly dispatchedAt: string;
    readonly requestId: string;
  }) => Promise<void>;
  readonly finalizeExpiredSource: (input: {
    readonly eventId: string;
    readonly observedAt: string;
  }) => Promise<boolean>;
  readonly listExpiredSources: (input: {
    readonly limit: number;
    readonly observedAt: string;
  }) => Promise<ReadonlyArray<string>>;
  readonly prepare: (
    input: PrepareWebhookReplayInput,
  ) => Promise<PrepareWebhookReplayResult>;
}

export interface WebhookReplayConnection extends QueryConnection {}

export interface WebhookReplayConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: WebhookReplayConnection) => Promise<Value>,
  ) => Promise<Value>;
}

interface PrepareRow extends Record<string, unknown> {
  readonly ciphertext_sha256: unknown;
  readonly event_id: unknown;
  readonly outcome: unknown;
  readonly payload_bytes: unknown;
  readonly personal_account_id: unknown;
  readonly received_at: unknown;
  readonly whatsapp_connection_id: unknown;
}

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );

const positiveInteger = (value: unknown): number | null => {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : value;
  return typeof parsed === "number" &&
    Number.isSafeInteger(parsed) &&
    parsed > 0
    ? parsed
    : null;
};

const timestamp = (value: unknown): string | null => {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return parsed !== null && Number.isFinite(parsed.valueOf())
    ? parsed.toISOString()
    : null;
};

const preparedResult = (
  row: PrepareRow | undefined,
): PrepareWebhookReplayResult => {
  if (row?.outcome === "source_unavailable") {
    return { outcome: "source_unavailable" };
  }
  const payloadBytes = positiveInteger(row?.payload_bytes);
  const receivedAt = timestamp(row?.received_at);
  if (
    (row?.outcome !== "pending" && row?.outcome !== "already_dispatched") ||
    !uuid(row.event_id) ||
    !uuid(row.personal_account_id) ||
    !uuid(row.whatsapp_connection_id) ||
    typeof row.ciphertext_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.ciphertext_sha256) ||
    payloadBytes === null ||
    receivedAt === null
  ) {
    throw new Error("invalid Webhook Event replay preparation");
  }
  return {
    message: {
      ciphertext_sha256: row.ciphertext_sha256,
      object_id: row.event_id,
      payload_bytes: payloadBytes,
      personal_account_id: row.personal_account_id,
      received_at: receivedAt,
      version: 1,
      whatsapp_connection_id: row.whatsapp_connection_id,
    },
    outcome: row.outcome,
  };
};

export const makeWebhookReplayRepository = (
  provider: WebhookReplayConnectionProvider,
): WebhookReplayRepository => ({
  complete: (input) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const result = await db.execute<{ completed: unknown }>(sql`
        SELECT public.complete_webhook_replay(
          ${input.requestId}, ${input.dispatchedAt}
        ) AS completed
      `);
      if (result[0]?.completed !== true) {
        throw new Error("Webhook Event replay attempt unavailable");
      }
    }),

  finalizeExpiredSource: (input) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const result = await db.execute<{ finalized: unknown }>(sql`
        SELECT public.finalize_expired_webhook_source(
          ${input.eventId}, ${input.observedAt}
        ) AS finalized
      `);
      if (typeof result[0]?.finalized !== "boolean") {
        throw new Error("invalid Webhook Event retention result");
      }
      return result[0].finalized;
    }),

  listExpiredSources: (input) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const result = await db.execute<{ event_id: unknown }>(sql`
        SELECT event_id
        FROM public.list_expired_webhook_sources(
          ${input.observedAt}, ${input.limit}
        )
      `);
      return result.map((row) => {
        if (!uuid(row.event_id)) {
          throw new Error("invalid expired Webhook Event source");
        }
        return row.event_id;
      });
    }),

  prepare: (input) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      let result: Array<PrepareRow>;
      try {
        result = await db.execute<PrepareRow>(sql`
          SELECT * FROM public.prepare_webhook_replay(
            ${input.requestId}, ${input.incidentReference},
            ${input.operatorReference}, ${input.reasonCode},
            ${input.requestedAt}, ${input.observedAt}
          )
        `);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "cause" in error &&
          error.cause instanceof Error
        ) {
          throw error.cause;
        }
        throw error;
      }
      return preparedResult(result[0]);
    }),
});

const makePgConnectionProvider = (
  connectionString: string,
): WebhookReplayConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: WebhookReplayConnection) => Promise<Value>,
  ): Promise<Value> => {
    const { Client } = await import("pg");
    const client: PgClient = new Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
    });
    await client.connect();
    try {
      return await use(makeQueryConnection(client));
    } finally {
      await client.end();
    }
  },
});

export const makePgWebhookReplayRepository = (
  connectionString: string,
): WebhookReplayRepository =>
  makeWebhookReplayRepository(makePgConnectionProvider(connectionString));
