import { and, eq, sql } from "drizzle-orm";
import type { Client as PgClient } from "pg";
import { type Database, makeDatabase, makeQueryConnection } from "./database";
import { personalAccountsInApp } from "./schema";
import { withTransaction } from "./transaction";

export interface PersonalAccountConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface PersonalAccountConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: PersonalAccountConnection) => Promise<Value>,
  ) => Promise<Value>;
}

export interface ActivePersonalAccount {
  readonly admissionState: "active";
  readonly keyAvailable: boolean;
  readonly messageRetentionDays: number;
  readonly personalAccountId: string;
  readonly storedMediaLimitBytes: number;
  readonly whatsappConnectionLimit: number;
}

export interface WaitlistedPersonalAccount {
  readonly admissionState: "waitlisted";
}

export type ResolvedPersonalAccount =
  | ActivePersonalAccount
  | WaitlistedPersonalAccount;

export interface CreatePersonalAccountInput {
  readonly clerkUserId: string;
  readonly keyCiphertext: Uint8Array;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
  readonly providerApprovedSessionCapacity: number;
}

export interface CreatedPersonalAccount {
  readonly admissionState: "active";
  readonly created: boolean;
  readonly messageRetentionDays: number;
  readonly personalAccountId: string;
  readonly storedMediaLimitBytes: number;
  readonly whatsappConnectionLimit: number;
}

export interface PersonalAccountRepository {
  readonly listDeletionPurgeCandidates: (input: {
    readonly limit: number;
    readonly observedAt: string;
  }) => Promise<
    ReadonlyArray<{
      readonly deadlineAt: string;
      readonly deadlineRisk: boolean;
      readonly deletionMarkerId: string;
      readonly requestedAt: string;
    }>
  >;
  readonly purgeDeletion: (input: {
    readonly completedAt: string;
    readonly deletionMarkerId: string;
  }) => Promise<boolean>;
  readonly purgeExpiredDeletionRecords: (limit: number) => Promise<number>;
  readonly create: (
    input: CreatePersonalAccountInput,
  ) => Promise<CreatedPersonalAccount | WaitlistedPersonalAccount | null>;
  readonly resolve: (
    clerkUserId: string,
  ) => Promise<ResolvedPersonalAccount | null>;
  readonly finishDeletion: (input: {
    readonly clerkUserId: string;
    readonly deletionMarkerId: string;
    readonly requestedAt: string;
  }) => Promise<boolean>;
  readonly prepareDeletion: (input: {
    readonly clerkUserId: string;
    readonly observedAt: string;
  }) => Promise<{
    readonly connectionPublicIds: ReadonlyArray<string>;
    readonly personalAccountId: string;
    readonly requestedAt: string;
    readonly state: "active" | "deleting";
  } | null>;
}

const enterPersonalAccountContext = async (
  db: Database,
  personalAccountId: string,
): Promise<boolean> => {
  await db.execute(
    sql`SELECT set_config('public.personal_account_id', ${personalAccountId}, true)`,
  );
  const visible = await db
    .select({ id: personalAccountsInApp.id })
    .from(personalAccountsInApp)
    .where(
      and(
        eq(personalAccountsInApp.id, personalAccountId),
        eq(personalAccountsInApp.state, "active"),
      ),
    );
  return visible.length === 1;
};

const quotaValue = (value: unknown): number => {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^[0-9]+$/.test(value)
        ? Number(value)
        : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error("invalid Personal Account quota");
  }
  return parsed;
};

interface AdmissionRow extends Record<string, unknown> {
  readonly admission_state: unknown;
  readonly created?: unknown;
  readonly key_available?: unknown;
  readonly message_retention_days: unknown;
  readonly personal_account_id: unknown;
  readonly stored_media_limit_bytes: unknown;
  readonly whatsapp_connection_limit: unknown;
}

const admissionState = (
  row: AdmissionRow | undefined,
): "active" | "waitlisted" | null => {
  if (row?.admission_state === "active") return "active";
  if (row?.admission_state === "waitlisted") return "waitlisted";
  return null;
};

export const makePersonalAccountRepository = (
  provider: PersonalAccountConnectionProvider,
): PersonalAccountRepository => ({
  listDeletionPurgeCandidates: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        deadline_at: unknown;
        deadline_risk: unknown;
        deletion_marker_id: unknown;
        requested_at: unknown;
      }>(sql`SELECT * FROM public.list_personal_account_purge_candidates(
        ${input.observedAt}, ${input.limit}
      )`);
      return rows.map((row) => {
        if (
          typeof row.deletion_marker_id !== "string" ||
          !(row.requested_at instanceof Date) ||
          !(row.deadline_at instanceof Date) ||
          typeof row.deadline_risk !== "boolean"
        )
          throw new Error("invalid Personal Account purge candidate");
        return {
          deadlineAt: row.deadline_at.toISOString(),
          deadlineRisk: row.deadline_risk,
          deletionMarkerId: row.deletion_marker_id,
          requestedAt: row.requested_at.toISOString(),
        };
      });
    }),
  purgeDeletion: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{ purged: unknown }>(
        sql`SELECT public.purge_personal_account(
          ${input.deletionMarkerId}, ${input.completedAt}
        ) AS purged`,
      );
      return rows[0]?.purged === true;
    }),
  purgeExpiredDeletionRecords: (limit) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{ purged: unknown }>(
        sql`SELECT public.purge_expired_deletion_records(${limit}) AS purged`,
      );
      const purged = Number(rows[0]?.purged);
      if (!Number.isSafeInteger(purged) || purged < 0)
        throw new Error("invalid deletion record purge result");
      return purged;
    }),
  finishDeletion: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        finished: unknown;
      }>(
        sql`SELECT public.finish_personal_account_deletion(
          ${input.clerkUserId}, ${input.deletionMarkerId}, ${input.requestedAt}
        ) AS finished`,
      );
      return rows[0]?.finished === true;
    }),
  prepareDeletion: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        account_state: unknown;
        connection_public_id: unknown;
        personal_account_id: unknown;
        requested_at: unknown;
      }>(sql`SELECT * FROM public.prepare_personal_account_deletion(
        ${input.clerkUserId}, ${input.observedAt}
      )`);
      const first = rows[0];
      if (
        first === undefined ||
        typeof first.personal_account_id !== "string" ||
        !(first.requested_at instanceof Date) ||
        (first.account_state !== "active" && first.account_state !== "deleting")
      )
        return null;
      return {
        connectionPublicIds: rows.flatMap((row) =>
          typeof row.connection_public_id === "string"
            ? [row.connection_public_id]
            : [],
        ),
        personalAccountId: first.personal_account_id,
        requestedAt: first.requested_at.toISOString(),
        state: first.account_state,
      };
    }),
  create: (input) =>
    provider.withConnection((connection) => {
      const db = makeDatabase(connection);
      return withTransaction(connection, async () => {
        const rows = await db.execute<AdmissionRow>(
          sql`SELECT * FROM public.admit_personal_account_for_clerk(
            ${input.clerkUserId}, ${input.personalAccountId},
            ${input.keyVersion}, ${input.kmsKeyId}, ${input.keyCiphertext},
            ${input.providerApprovedSessionCapacity}
          )`,
        );
        const row = rows[0];
        if (admissionState(row) === "waitlisted") {
          return { admissionState: "waitlisted" as const };
        }
        if (
          admissionState(row) !== "active" ||
          typeof row?.personal_account_id !== "string" ||
          typeof row.created !== "boolean" ||
          !(await enterPersonalAccountContext(db, row.personal_account_id))
        ) {
          return null;
        }
        return {
          admissionState: "active" as const,
          created: row.created,
          messageRetentionDays: quotaValue(row.message_retention_days),
          personalAccountId: row.personal_account_id,
          storedMediaLimitBytes: quotaValue(row.stored_media_limit_bytes),
          whatsappConnectionLimit: quotaValue(row.whatsapp_connection_limit),
        };
      });
    }),
  resolve: (clerkUserId) =>
    provider.withConnection((connection) => {
      const db = makeDatabase(connection);
      return withTransaction(connection, async () => {
        const rows = await db.execute<AdmissionRow>(
          sql`SELECT * FROM public.resolve_personal_account_for_clerk(${clerkUserId})`,
        );
        const row = rows[0];
        if (admissionState(row) === "waitlisted") {
          return { admissionState: "waitlisted" as const };
        }
        if (
          admissionState(row) !== "active" ||
          typeof row?.personal_account_id !== "string" ||
          typeof row.key_available !== "boolean" ||
          !(await enterPersonalAccountContext(db, row.personal_account_id))
        ) {
          return null;
        }
        return {
          admissionState: "active" as const,
          keyAvailable: row.key_available,
          messageRetentionDays: quotaValue(row.message_retention_days),
          personalAccountId: row.personal_account_id,
          storedMediaLimitBytes: quotaValue(row.stored_media_limit_bytes),
          whatsappConnectionLimit: quotaValue(row.whatsapp_connection_limit),
        };
      });
    }),
});

const makePgConnectionProvider = (
  connectionString: string,
): PersonalAccountConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: PersonalAccountConnection) => Promise<Value>,
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

export const makePgPersonalAccountRepository = (
  connectionString: string,
): PersonalAccountRepository =>
  makePersonalAccountRepository(makePgConnectionProvider(connectionString));
