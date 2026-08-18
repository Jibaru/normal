import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  type DeletionMarkerBucket,
  makeDeletionMarkerStore,
} from "@whatsapp-mcp/api/deletion/marker";
import type { RecipientJournalBucket } from "@whatsapp-mcp/api/recipient/journal";
import { makePgRestoreRepository } from "@whatsapp-mcp/db/restore";
import { restrictedRestoreRuntimeConnectionString } from "@whatsapp-mcp/db/restricted-runtime-config";
import { createNeonRecoveryClient } from "@whatsapp-mcp/neon-recovery/client";
import { replayRestore } from "@whatsapp-mcp/restore-coordinator/replay";
import { Redacted } from "effect";
import { required, safeHttpsUrl } from "./config";
import type { ReplayEvidence, StartRequest } from "./contract";
import { verificationResponseSchema } from "./contract";

const stepConfig = {
  retries: { limit: 2, delay: 10_000, backoff: "exponential" as const },
  timeout: 1_800_000,
};
const nonRetryableStepConfig = {
  retries: { limit: 0, delay: 0 },
  timeout: 1_800_000,
};

const toHex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const neonClient = (env: Env) =>
  createNeonRecoveryClient({
    apiKey: required(env.NEON_RECOVERY_API_KEY, "Neon recovery API key"),
    projectId: required(env.NEON_PROJECT_ID, "Neon project identity"),
    parentBranchId: required(
      env.NEON_PARENT_BRANCH_ID,
      "Neon recovery parent branch",
    ),
    branchNamePrefix: env.RECOVERY_BRANCH_PREFIX,
    databaseName: env.RECOVERY_DATABASE_NAME,
    polling: { maxAttempts: 120, intervalMs: 5_000, timeoutMs: 600_000 },
  });

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > 65_536)
    throw new Error("Recovery verifier response is too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Recovery verifier response is unavailable");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 65_536) {
      await reader.cancel();
      throw new Error("Recovery verifier response is too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
};

export class ProductionRecoveryWorkflow extends WorkflowEntrypoint<
  Env,
  StartRequest
> {
  async run(event: WorkflowEvent<StartRequest>, step: WorkflowStep) {
    if (this.env.DEPLOYMENT_ENVIRONMENT !== "production")
      throw new Error("Production recovery is unavailable outside production");
    const startedAt = event.timestamp.toISOString();
    const branch = await step.do(
      "reconcile guarded PITR branch",
      stepConfig,
      async () => {
        const client = neonClient(this.env);
        return client.reconcilePitrBranch({
          name: `${this.env.RECOVERY_BRANCH_PREFIX}${event.instanceId}`,
          parentTimestamp: event.payload.requested_source_point_at,
        });
      },
      {
        rollback: async ({ output }) => {
          const guarded =
            output ??
            (await neonClient(this.env).findGuardedPitrBranch({
              name: `${this.env.RECOVERY_BRANCH_PREFIX}${event.instanceId}`,
              parentTimestamp: event.payload.requested_source_point_at,
            }));
          if (guarded !== "absent")
            await neonClient(this.env).deleteGuardedBranch(guarded);
        },
        rollbackConfig: stepConfig,
      },
    );
    const observedAt = await step.do("record replay time", async () =>
      new Date().toISOString(),
    );

    const replay = await step.do(
      "replay restore-external authorities",
      nonRetryableStepConfig,
      async (): Promise<ReplayEvidence> => {
        const client = neonClient(this.env);
        await client.resetRestoreRuntimePassword(branch);
        const connectionString = restrictedRestoreRuntimeConnectionString(
          await client.getDirectRestoreUri(branch),
        );
        const result = await replayRestore({
          branchId: branch.id,
          currentTime: () => new Date().toISOString(),
          environment: "production",
          handleObjectDeletion: async () => undefined,
          hmacSecret: Redacted.make(
            required(
              this.env.DELETION_MARKER_HMAC_SECRET,
              "Deletion marker HMAC secret",
            ),
          ),
          markers: makeDeletionMarkerStore({
            bucket: this.env
              .DELETION_MARKERS as unknown as DeletionMarkerBucket,
            environment: "production",
            hmacSecret: Redacted.make(this.env.DELETION_MARKER_HMAC_SECRET),
          }),
          observedAt,
          recipientHmacSecret: Redacted.make(
            required(
              this.env.RECIPIENT_TRANSITION_HMAC_SECRET,
              "Recipient transition HMAC secret",
            ),
          ),
          recipientJournal: this.env
            .RECIPIENT_TRANSITIONS as unknown as RecipientJournalBucket,
          repository: makePgRestoreRepository(connectionString),
        });
        return {
          deletion_markers_enumerated: result.markerCount,
          deletion_marker_failures: 0,
          deleted_entities_repurged: result.deletedEntityCount,
          recipient_transitions_replayed: result.recipientTransitionCount,
          recipient_transition_failures: 0,
          unresolved_recipient_prefixes: result.unresolvedRecipientPrefixCount,
          expired_records_purged: result.expiredRecordCount,
          api_keys_revoked: result.apiKeysRevoked,
          api_key_digests_cleared: result.apiKeyDigestsCleared,
          object_deletion_intents_simulated: result.objectDeletionCount,
          object_deletion_failures: 0,
        };
      },
    );

    const verificationIdentity = await step.do(
      "bind verification request",
      async () => {
        const nonce = new Uint8Array(32);
        crypto.getRandomValues(nonce);
        return {
          verification_nonce: [...nonce]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
          replay_digest: toHex(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify(replay)),
            ),
          ),
        };
      },
    );

    const verification = await step.do(
      "verify recovery and aggregate availability",
      stepConfig,
      async () => {
        const response = await fetch(
          safeHttpsUrl(this.env.RECOVERY_EVIDENCE_URL, "Recovery evidence URL"),
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(300_000),
            headers: {
              accept: "application/json",
              authorization: `Bearer ${required(
                this.env.RECOVERY_EVIDENCE_TOKEN,
                "Recovery evidence token",
              )}`,
              "content-type": "application/json",
              "idempotency-key": event.instanceId,
            },
            body: JSON.stringify({
              version: 1,
              operation: event.instanceId,
              drill: event.payload.drill,
              environment: "production",
              started_at: startedAt,
              source_point_at: event.payload.requested_source_point_at,
              recovery_branch_id: branch.id,
              serving: false,
              replay,
              ...verificationIdentity,
            }),
          },
        );
        if (
          !response.ok ||
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/json")
        )
          throw new Error("Recovery evidence verification failed");
        const parsed = verificationResponseSchema.parse(
          await readBoundedJson(response),
        );
        if (
          parsed.drill !== event.payload.drill ||
          parsed.operation !== event.instanceId ||
          parsed.recovery_branch_id !== branch.id ||
          parsed.source_point_at !== event.payload.requested_source_point_at ||
          parsed.started_at !== startedAt ||
          parsed.verification_nonce !==
            verificationIdentity.verification_nonce ||
          parsed.replay_digest !== verificationIdentity.replay_digest
        )
          throw new Error("Recovery verifier returned mismatched evidence");
        return parsed;
      },
    );

    await step.do("delete guarded PITR branch", stepConfig, async () => {
      await neonClient(this.env).deleteGuardedBranch(branch);
    });
    const completedAt = await step.do("record completion time", async () =>
      new Date().toISOString(),
    );
    const achievedRtoSeconds = Math.ceil(
      (Date.parse(completedAt) - Date.parse(startedAt)) / 1_000,
    );
    return {
      version: 1,
      drill: event.payload.drill,
      environment: "production",
      started_at: startedAt,
      completed_at: completedAt,
      source_point_at: event.payload.requested_source_point_at,
      recovery_branch_id: branch.id,
      serving: false,
      achieved_rpo_seconds: verification.achieved_rpo_seconds,
      achieved_rto_seconds: achievedRtoSeconds,
      achieved_first_party_availability_percent:
        verification.achieved_first_party_availability_percent,
      objectives: {
        recovery_time_seconds: 14_400,
        neon_recovery_point_seconds: 300,
        deletion_marker_loss: 0,
        first_party_availability_percent: 99.5,
      },
      dependencies: verification.dependencies,
      replay,
      checks: verification.checks,
    } as const;
  }
}
