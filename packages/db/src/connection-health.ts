import type { WhatsAppConnectionState } from "@whatsapp-mcp/domain/whatsapp-connection";
import { sql } from "drizzle-orm";
import type { Client as PgClient } from "pg";
import {
  makeDatabase,
  makeQueryConnection,
  type QueryConnection,
} from "./database";

export interface ConnectionHealthConnection extends QueryConnection {}

export interface ConnectionHealthConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: ConnectionHealthConnection) => Promise<Value>,
  ) => Promise<Value>;
}

export interface ConnectionHealthCandidate {
  readonly claimId: string;
  readonly connectionId: string;
  readonly setupMarker: string;
  readonly webhookIngressId: string;
}

export type ConnectionHealthGapEvidence =
  | "healthy"
  | "connection_unavailable"
  | "webhook_configuration"
  | "unknown";

export type ReconciledConnectionHealthState = Exclude<
  WhatsAppConnectionState,
  "connecting" | "deleting"
>;

export type IngestionGapEvidenceCause =
  | "ingress_failure"
  | "processing_failure"
  | "restore_loss";

export interface ConnectionHealthRepository {
  readonly claim: (input: {
    readonly claimedAt: string;
    readonly limit: number;
  }) => Promise<ReadonlyArray<ConnectionHealthCandidate>>;
  readonly finish: (input: {
    readonly checkedAt: string;
    readonly claimId: string;
    readonly connectionId: string;
    readonly gapEvidence: ConnectionHealthGapEvidence;
    readonly startedAt: string;
    readonly state: ReconciledConnectionHealthState;
    readonly webhookConfigurationHealthy: boolean;
  }) => Promise<boolean>;
  readonly recordEvidence: (input: {
    readonly active: boolean;
    readonly cause: IngestionGapEvidenceCause;
    readonly connectionId: string;
    readonly observedAt: string;
  }) => Promise<boolean>;
}

interface CandidateRow extends Record<string, unknown> {
  readonly connection_setup_marker: unknown;
  readonly health_claim_id: unknown;
  readonly webhook_ingress_id: unknown;
  readonly whatsapp_connection_id: unknown;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const setupMarkerPattern = /^cst_[A-Za-z0-9_-]{21}$/u;

const candidate = (row: CandidateRow): ConnectionHealthCandidate => {
  if (
    typeof row.health_claim_id !== "string" ||
    !uuidPattern.test(row.health_claim_id) ||
    typeof row.whatsapp_connection_id !== "string" ||
    !uuidPattern.test(row.whatsapp_connection_id) ||
    typeof row.connection_setup_marker !== "string" ||
    !setupMarkerPattern.test(row.connection_setup_marker) ||
    typeof row.webhook_ingress_id !== "string" ||
    !uuidPattern.test(row.webhook_ingress_id)
  ) {
    throw new Error("invalid connection health claim");
  }
  return {
    claimId: row.health_claim_id,
    connectionId: row.whatsapp_connection_id,
    setupMarker: row.connection_setup_marker,
    webhookIngressId: row.webhook_ingress_id,
  };
};

const booleanResult = (value: unknown): boolean => {
  if (typeof value !== "boolean") {
    throw new Error("invalid connection health persistence result");
  }
  return value;
};

export const makeConnectionHealthRepository = (
  provider: ConnectionHealthConnectionProvider,
): ConnectionHealthRepository => ({
  claim: (input) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const result = await db.execute<CandidateRow>(sql`
        SELECT * FROM app_private.claim_whatsapp_connection_health(
          ${input.claimedAt}, ${input.limit}
        )
      `);
      return result.map(candidate);
    }),
  finish: (input) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const result = await db.execute<{ finished: unknown }>(sql`
        SELECT app_private.finish_whatsapp_connection_health(
          ${input.connectionId}, ${input.claimId}, ${input.state},
          ${input.gapEvidence}, ${input.webhookConfigurationHealthy},
          ${input.startedAt}, ${input.checkedAt}
        ) AS finished
      `);
      return booleanResult(result[0]?.finished);
    }),
  recordEvidence: (input) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const result = await db.execute<{ recorded: unknown }>(sql`
        SELECT app_private.record_ingestion_gap_evidence(
          ${input.connectionId}, ${input.cause}, ${input.active},
          ${input.observedAt}
        ) AS recorded
      `);
      return booleanResult(result[0]?.recorded);
    }),
});

const makePgConnectionProvider = (
  connectionString: string,
): ConnectionHealthConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: ConnectionHealthConnection) => Promise<Value>,
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

export const makePgConnectionHealthRepository = (
  connectionString: string,
): ConnectionHealthRepository =>
  makeConnectionHealthRepository(makePgConnectionProvider(connectionString));
