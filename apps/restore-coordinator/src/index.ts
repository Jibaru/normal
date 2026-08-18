import {
  type DeletionMarkerBucket,
  makeDeletionMarkerStore,
} from "@whatsapp-mcp/api/deletion/marker";
import type { RecipientJournalBucket } from "@whatsapp-mcp/api/recipient/journal";
import { restrictedRestoreRuntimeConnectionString } from "@whatsapp-mcp/db/config";
import { makePgRestoreRepository } from "@whatsapp-mcp/db/restore";
import { Redacted } from "effect";
import { replayRestore } from "./replay";

interface Environment {
  readonly DELETION_MARKERS: R2Bucket;
  readonly DEPLOYMENT_ENVIRONMENT: "development" | "preview" | "production";
  readonly NEON_BRANCH_ID: string;
  readonly RESTORE_DATABASE_URL: string;
  readonly DELETION_MARKER_HMAC_SECRET: string;
  readonly RECIPIENT_TRANSITION_HMAC_SECRET: string;
  readonly RECIPIENT_TRANSITIONS: R2Bucket;
  readonly STORED_MEDIA: R2Bucket;
  readonly WEBHOOK_INGRESS: R2Bucket;
}

const required = (value: string | undefined, name: string) => {
  if (!value || /example|placeholder|replace/iu.test(value))
    throw new Error(`${name} is unavailable`);
  return value;
};

const scheduled: ExportedHandlerScheduledHandler<Environment> = async (
  controller,
  environment,
) => {
  const result = await replayRestore({
    branchId: required(environment.NEON_BRANCH_ID, "Neon branch identity"),
    environment: environment.DEPLOYMENT_ENVIRONMENT,
    hmacSecret: Redacted.make(
      required(
        environment.DELETION_MARKER_HMAC_SECRET,
        "Deletion marker HMAC secret",
      ),
    ),
    handleObjectDeletion: async (deletion) => {
      await environment[
        deletion.bucket === "stored_media" ? "STORED_MEDIA" : "WEBHOOK_INGRESS"
      ].delete(deletion.objectKey);
    },
    markers: makeDeletionMarkerStore({
      bucket: environment.DELETION_MARKERS as unknown as DeletionMarkerBucket,
      environment: environment.DEPLOYMENT_ENVIRONMENT,
      hmacSecret: Redacted.make(environment.DELETION_MARKER_HMAC_SECRET),
    }),
    observedAt: new Date(controller.scheduledTime).toISOString(),
    recipientHmacSecret: Redacted.make(
      required(
        environment.RECIPIENT_TRANSITION_HMAC_SECRET,
        "WhatsApp Recipient Exclusion transition HMAC secret",
      ),
    ),
    recipientJournal:
      environment.RECIPIENT_TRANSITIONS as unknown as RecipientJournalBucket,
    repository: makePgRestoreRepository(
      restrictedRestoreRuntimeConnectionString(
        required(environment.RESTORE_DATABASE_URL, "Restore database"),
      ),
    ),
  });
  console.info(
    JSON.stringify({
      event: "restore.replay.completed",
      service: "restore-coordinator",
      ...result,
    }),
  );
};

export default { scheduled } satisfies ExportedHandler<Environment>;
