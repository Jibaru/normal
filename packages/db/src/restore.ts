import type { Client as PgClient } from "pg";

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
  use: (client: PgClient) => Promise<Value>,
) => {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
};

export const makePgRestoreRepository = (
  connectionString: string,
): RestoreRepository => ({
  begin: (branchId, observedAt) =>
    withClient(connectionString, async (client) => {
      const result = await client.query<{
        deletion_kind: RestoreCandidate["deletionKind"];
        opaque_entity_id: string;
      }>("SELECT * FROM app_private.begin_restore_replay($1,$2)", [
        branchId,
        observedAt,
      ]);
      return result.rows.map((row) => ({
        deletionKind: row.deletion_kind,
        opaqueEntityId: row.opaque_entity_id,
      }));
    }),
  replayDeletion: (input) =>
    withClient(connectionString, async (client) => {
      const result = await client.query<{ replayed: boolean }>(
        "SELECT app_private.replay_restore_deletion($1,$2,$3,$4) AS replayed",
        [
          input.deletionKind,
          input.opaqueEntityId,
          input.markerId,
          input.observedAt,
        ],
      );
      return result.rows[0]?.replayed === true;
    }),
  purgeExpired: (observedAt, limit) =>
    withClient(connectionString, async (client) => {
      const result = await client.query<{ purged: number }>(
        "SELECT app_private.purge_restore_expired($1,$2) AS purged",
        [observedAt, limit],
      );
      return result.rows[0]?.purged ?? 0;
    }),
  listObjectDeletions: (limit) =>
    withClient(connectionString, async (client) => {
      const result = await client.query<{
        bucket: RestoreObjectDeletion["bucket"];
        object_key: string;
      }>("SELECT * FROM app_private.list_restore_object_deletions($1)", [
        limit,
      ]);
      return result.rows.map((row) => ({
        bucket: row.bucket,
        objectKey: row.object_key,
      }));
    }),
  finishObjectDeletion: (deletion) =>
    withClient(connectionString, async (client) => {
      await client.query(
        "SELECT app_private.finish_restore_object_deletion($1,$2)",
        [deletion.bucket, deletion.objectKey],
      );
    }),
  complete: (input) =>
    withClient(connectionString, async (client) => {
      await client.query(
        "SELECT app_private.complete_restore_replay($1,$2,$3,$4,$5)",
        [
          input.branchId,
          input.completedAt,
          input.markerCount,
          input.deletedEntityCount,
          input.expiredRecordCount,
        ],
      );
    }),
});
