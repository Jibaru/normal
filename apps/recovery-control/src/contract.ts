import { z } from "zod";

export const drillKindSchema = z.enum([
  "monthly_restore",
  "quarterly_game_day",
]);

export const startRequestSchema = z
  .object({
    drill: drillKindSchema,
    requested_source_point_at: z.iso.datetime({ offset: true }),
    serving: z.literal(false),
  })
  .strict();

export type StartRequest = z.infer<typeof startRequestSchema>;

const monthlyChecks = {
  schema_compatible: z.literal(true),
  rls_isolated: z.literal(true),
  sampled_keys_usable: z.literal(true),
  invariants_valid: z.literal(true),
  quotas_valid: z.literal(true),
  audit_valid: z.literal(true),
  current_time_expiry_applied: z.literal(true),
  deletion_markers_replayed: z.literal(true),
  recipient_transitions_replayed: z.literal(true),
  recipient_purge_cutoffs_applied: z.literal(true),
  prepared_recipient_transitions_drained: z.literal(true),
  object_deletion_intents_drained: z.literal(true),
  deleted_identifiers_absent: z.literal(true),
  api_keys_revoked: z.literal(true),
  api_key_digests_cleared: z.literal(true),
  api_key_hmac_rotated: z.literal(true),
  predecessor_hmac_rejected: z.literal(true),
} as const;

const quarterlyChecks = {
  endpoint_rotation: z.literal(true),
  oauth_kv_reconstructed: z.literal(true),
  immutable_queue_replay: z.literal(true),
  kms_access: z.literal(true),
  r2_access: z.literal(true),
  media_loss_failed_closed: z.literal(true),
  alert_delivered: z.literal(true),
  deletion_gate_bypass_denied: z.literal(true),
} as const;

const verificationBase = {
  achieved_rpo_seconds: z.number().finite().nonnegative().max(300),
  achieved_first_party_availability_percent: z
    .number()
    .finite()
    .min(99.5)
    .max(100),
  dependencies: z
    .object({
      wasender_percent: z.number().finite().nonnegative().max(100),
      whatsapp_percent: z.number().finite().nonnegative().max(100),
    })
    .strict(),
} as const;

export const verificationResponseSchema = z.discriminatedUnion("drill", [
  z
    .object({
      ...verificationBase,
      version: z.literal(1),
      drill: z.literal("monthly_restore"),
      operation: z.string().regex(/^recovery_operation_[a-f0-9]{32}$/u),
      recovery_branch_id: z.string().regex(/^br-[a-z0-9-]{1,57}$/u),
      source_point_at: z.iso.datetime({ offset: true }),
      started_at: z.iso.datetime({ offset: true }),
      verification_nonce: z.string().regex(/^[a-f0-9]{64}$/u),
      replay_digest: z.string().regex(/^[a-f0-9]{64}$/u),
      checks: z.object(monthlyChecks).strict(),
    })
    .strict(),
  z
    .object({
      ...verificationBase,
      version: z.literal(1),
      drill: z.literal("quarterly_game_day"),
      operation: z.string().regex(/^recovery_operation_[a-f0-9]{32}$/u),
      recovery_branch_id: z.string().regex(/^br-[a-z0-9-]{1,57}$/u),
      source_point_at: z.iso.datetime({ offset: true }),
      started_at: z.iso.datetime({ offset: true }),
      verification_nonce: z.string().regex(/^[a-f0-9]{64}$/u),
      replay_digest: z.string().regex(/^[a-f0-9]{64}$/u),
      checks: z.object({ ...monthlyChecks, ...quarterlyChecks }).strict(),
    })
    .strict(),
]);

export type VerificationResponse = z.infer<typeof verificationResponseSchema>;

export interface ReplayEvidence {
  readonly deletion_markers_enumerated: number;
  readonly deletion_marker_failures: 0;
  readonly deleted_entities_repurged: number;
  readonly recipient_transitions_replayed: number;
  readonly recipient_transition_failures: 0;
  readonly unresolved_recipient_prefixes: number;
  readonly expired_records_purged: number;
  readonly api_keys_revoked: number;
  readonly api_key_digests_cleared: number;
  readonly object_deletion_intents_simulated: number;
  readonly object_deletion_failures: 0;
}
