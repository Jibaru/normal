import { sql } from "drizzle-orm";
import {
  makeDatabase,
  makeQueryConnection,
  type QueryConnection,
} from "./database";

export interface RestoreCandidate {
  readonly deletionKind: "personal_account" | "whatsapp_connection";
  readonly opaqueEntityId: string;
}

export interface RestoreObjectDeletion {
  readonly bucket: "stored_media" | "webhook_ingress";
  readonly objectKey: string;
}

export interface RestoreRepository {
  readonly begin: (
    branchId: string,
    observedAt: string,
  ) => Promise<ReadonlyArray<RestoreCandidate>>;
  readonly complete: (input: {
    readonly branchId: string;
    readonly completedAt: string;
    readonly deletedEntityCount: number;
    readonly expiredRecordCount: number;
    readonly markerCount: number;
  }) => Promise<void>;
  readonly finishObjectDeletion: (
    deletion: RestoreObjectDeletion,
  ) => Promise<void>;
  readonly listObjectDeletions: (
    limit: number,
  ) => Promise<ReadonlyArray<RestoreObjectDeletion>>;
  readonly purgeExpired: (observedAt: string, limit: number) => Promise<number>;
  readonly replayDeletion: (
    input: RestoreCandidate & {
      readonly markerId: string;
      readonly observedAt: string;
    },
  ) => Promise<boolean>;
}

const withClient = async <Value>(
  connectionString: string,
  use: (client: QueryConnection) => Promise<Value>,
) => {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await client.connect();
  try {
    return await use(makeQueryConnection(client));
  } finally {
    await client.end();
  }
};

export const makePgRestoreRepository = (
  connectionString: string,
): RestoreRepository => ({
  begin: (branchId, observedAt) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{
        deletion_kind: RestoreCandidate["deletionKind"];
        opaque_entity_id: string;
      }>(sql`
        SELECT * FROM public.begin_restore_replay(${branchId}, ${observedAt})
      `);
      return result.map((row) => ({
        deletionKind: row.deletion_kind,
        opaqueEntityId: row.opaque_entity_id,
      }));
    }),
  replayDeletion: (input) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{ replayed: boolean }>(sql`
        SELECT public.replay_restore_deletion(
          ${input.deletionKind}, ${input.opaqueEntityId}, ${input.markerId},
          ${input.observedAt}
        ) AS replayed
      `);
      return result[0]?.replayed === true;
    }),
  purgeExpired: (observedAt, limit) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{ purged: number }>(sql`
        SELECT public.purge_restore_expired(${observedAt}, ${limit}) AS purged
      `);
      return result[0]?.purged ?? 0;
    }),
  listObjectDeletions: (limit) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{
        bucket: RestoreObjectDeletion["bucket"];
        object_key: string;
      }>(sql`
        SELECT * FROM public.list_restore_object_deletions(${limit})
      `);
      return result.map((row) => ({
        bucket: row.bucket,
        objectKey: row.object_key,
      }));
    }),
  finishObjectDeletion: (deletion) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      await db.execute(sql`
        SELECT public.finish_restore_object_deletion(
          ${deletion.bucket}, ${deletion.objectKey}
        )
      `);
    }),
  complete: (input) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      await db.execute(sql`
        SELECT public.complete_restore_replay(
          ${input.branchId}, ${input.completedAt}, ${input.markerCount},
          ${input.deletedEntityCount}, ${input.expiredRecordCount}
        )
      `);
    }),
});
