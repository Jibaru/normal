import {
  type DeletionMarkerStore,
  deriveDeletionMarkerId,
} from "@whatsapp-mcp/api/deletion/marker";
import type { RestoreRepository } from "@whatsapp-mcp/db/restore";
import { Effect, type Redacted } from "effect";

export interface RestoreBuckets {
  readonly stored_media: Pick<R2Bucket, "delete">;
  readonly webhook_ingress: Pick<R2Bucket, "delete">;
}

export const replayRestore = async (input: {
  readonly branchId: string;
  readonly buckets: RestoreBuckets;
  readonly environment: "development" | "preview" | "production";
  readonly hmacSecret: Redacted.Redacted<string>;
  readonly markers: DeletionMarkerStore;
  readonly observedAt: string;
  readonly repository: RestoreRepository;
}) => {
  const [candidates, markerReferences] = await Promise.all([
    input.repository.begin(input.branchId, input.observedAt),
    Effect.runPromise(input.markers.enumerate()),
  ]);
  const markers = new Map(
    markerReferences.map((reference) => [reference.markerId, reference]),
  );
  let deletedEntityCount = 0;
  for (const candidate of candidates) {
    const markerId = await deriveDeletionMarkerId(
      input.environment,
      input.hmacSecret,
      candidate.deletionKind,
      candidate.opaqueEntityId,
    );
    const marker = markers.get(markerId);
    if (marker?.marker.deletionKind !== candidate.deletionKind) continue;
    if (
      await input.repository.replayDeletion({
        ...candidate,
        markerId,
        observedAt: input.observedAt,
      })
    ) {
      deletedEntityCount += 1;
    }
  }

  let expiredRecordCount = 0;
  for (;;) {
    const purged = await input.repository.purgeExpired(input.observedAt, 1000);
    expiredRecordCount += purged;
    if (purged < 1000) break;
  }
  for (;;) {
    const deletions = await input.repository.listObjectDeletions(1000);
    for (const deletion of deletions) {
      await input.buckets[deletion.bucket].delete(deletion.objectKey);
      await input.repository.finishObjectDeletion(deletion);
    }
    if (deletions.length < 1000) break;
  }
  await input.repository.complete({
    branchId: input.branchId,
    completedAt: input.observedAt,
    deletedEntityCount,
    expiredRecordCount,
    markerCount: markerReferences.length,
  });
  return {
    deletedEntityCount,
    expiredRecordCount,
    markerCount: markerReferences.length,
  };
};
