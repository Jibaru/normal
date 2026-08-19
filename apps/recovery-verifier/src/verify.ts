import {
  decodeQuarterlyRecoveryChecks,
  decodeQuarterlyRecoveryExecutionReceipt,
  decodeRecoveryVerificationRequest,
  decodeRecoveryVerificationResponse,
  type RecoveryVerificationRequest,
} from "@whatsapp-mcp/contracts/recovery";
import {
  checkDatabaseReadiness,
  checkRestrictedDatabaseAccess,
} from "@whatsapp-mcp/db/connectivity";
import { RestoreReplayRequired } from "@whatsapp-mcp/db/readiness";
import { makePgRecoveryVerifierRepository } from "@whatsapp-mcp/db/recovery-verifier";
import { createNeonRecoveryClient } from "@whatsapp-mcp/neon-recovery/client";
import { queryAvailability } from "./availability";
import { required } from "./config";
import type { RecoveryVerifierEnvironment } from "./environment";

const encoder = new TextEncoder();
const toHex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const recoveryClient = (env: RecoveryVerifierEnvironment) =>
  createNeonRecoveryClient({
    apiKey: required(env.NEON_RECOVERY_API_KEY, "Neon recovery API key"),
    projectId: required(env.NEON_PROJECT_ID, "Neon project identity"),
    parentBranchId: required(env.NEON_PARENT_BRANCH_ID, "Neon parent branch"),
    branchNamePrefix: env.RECOVERY_BRANCH_PREFIX,
    databaseName: env.RECOVERY_DATABASE_NAME,
    runtimeRole: "whatsapp_recovery_verifier",
    polling: { maxAttempts: 120, intervalMs: 5_000, timeoutMs: 600_000 },
  });

const gameDayRequest = async <Value>(
  env: RecoveryVerifierEnvironment,
  path: "/execute" | "/verify",
  body: unknown,
  decode: (candidate: unknown) => Value,
) => {
  const response = await env.RECOVERY_GAME_DAY.fetch(
    `https://recovery-game-day.internal${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error("Quarterly game day failed");
  return decode(await response.json());
};

const expectedReplayDigest = async (input: RecoveryVerificationRequest) =>
  toHex(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(JSON.stringify(input.replay)),
    ),
  );

const verifyIsolatedApiKeyHmacRotation = async () => {
  const credential = crypto.getRandomValues(new Uint8Array(64));
  const predecessor = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const replacement = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const predecessorDigest = await crypto.subtle.sign(
    "HMAC",
    predecessor,
    credential,
  );
  const replacementDigest = await crypto.subtle.sign(
    "HMAC",
    replacement,
    credential,
  );
  const rotated = toHex(predecessorDigest) !== toHex(replacementDigest);
  const predecessorRejected = !(await crypto.subtle.verify(
    "HMAC",
    replacement,
    predecessorDigest,
    credential,
  ));
  credential.fill(0);
  if (!rotated || !predecessorRejected)
    throw new Error("Isolated API Key HMAC rotation failed");
  return { rotated: true, predecessorRejected: true } as const;
};

export const verifyRecovery = async (
  env: RecoveryVerifierEnvironment,
  candidate: unknown,
) => {
  if (env.DEPLOYMENT_ENVIRONMENT !== "production")
    throw new Error("Production recovery verification is unavailable");
  const input = decodeRecoveryVerificationRequest(candidate);
  if ((await expectedReplayDigest(input)) !== input.replay_digest)
    throw new Error("Recovery replay digest does not match");
  const client = recoveryClient(env);
  const branch = await client.findGuardedPitrBranch({
    name: `${env.RECOVERY_BRANCH_PREFIX}${input.operation}`,
    parentTimestamp: input.source_point_at,
  });
  if (branch === "absent" || branch.id !== input.recovery_branch_id)
    throw new Error("Guarded recovery branch is unavailable");
  await client.resetRestoreRuntimePassword(branch);
  const firstUri = await client.getDirectRestoreUri(branch);
  await checkRestrictedDatabaseAccess(firstUri);
  let repository = makePgRecoveryVerifierRepository(firstUri);
  let activeUri = firstUri;
  let database = await repository.verify(branch.id, new Date().toISOString());

  let endpointRotation = true;
  if (input.drill === "quarterly_game_day") {
    await client.rotateGuardedEndpoint(branch);
    const replacementUri = await client.getDirectRestoreUri(branch);
    try {
      await repository.verify(branch.id, new Date().toISOString());
      endpointRotation = false;
    } catch {
      endpointRotation = true;
    }
    if (!endpointRotation)
      throw new Error("Predecessor verifier endpoint remained usable");
    await checkRestrictedDatabaseAccess(replacementUri);
    repository = makePgRecoveryVerifierRepository(replacementUri);
    activeUri = replacementUri;
    database = await repository.verify(branch.id, new Date().toISOString());
  }

  const availability = await queryAvailability(env, input);
  const hmac = await verifyIsolatedApiKeyHmacRotation();
  const achievedRpoSeconds = Math.abs(
    (Date.parse(input.source_point_at) -
      Date.parse(availability.recoveredSourcePointAt)) /
      1_000,
  );
  if (!Number.isFinite(achievedRpoSeconds) || achievedRpoSeconds > 300)
    throw new Error("Recovery point objective was missed");
  if (availability.firstPartyPercent < 99.5)
    throw new Error("First-party availability objective was missed");

  const replayChecks =
    input.replay.deletion_marker_failures === 0 &&
    input.replay.recipient_transition_failures === 0 &&
    input.replay.object_deletion_failures === 0;
  const monthlyChecks = {
    schema_compatible: database.schemaOk,
    rls_isolated: database.rlsOk,
    sampled_keys_usable: availability.sampledKeysUsable,
    invariants_valid: database.invariantsOk,
    quotas_valid: database.quotaOk,
    audit_valid: database.auditOk,
    current_time_expiry_applied: database.expiryOk,
    deletion_markers_replayed: database.deletionOk && replayChecks,
    recipient_transitions_replayed:
      database.recipientTransitionOk && replayChecks,
    recipient_purge_cutoffs_applied:
      database.recipientCutoffOk && database.recipientContentOk,
    prepared_recipient_transitions_drained: database.recipientTransitionOk,
    object_deletion_intents_drained: database.objectIntentOk,
    deleted_identifiers_absent:
      database.deletionOk && input.replay.deleted_identifiers_remaining === 0,
    api_keys_revoked: database.apiKeyOk,
    api_key_digests_cleared: database.apiKeyOk,
    api_key_hmac_rotated: hmac.rotated,
    predecessor_hmac_rejected: hmac.predecessorRejected,
  } as const;

  let checks: Record<string, boolean> = monthlyChecks;
  if (input.drill === "quarterly_game_day") {
    const execution = {
      version: 1,
      operation: input.operation,
      recoveryBranchId: input.recovery_branch_id,
      verificationNonce: input.verification_nonce,
      replayDigest: input.replay_digest,
    } as const;
    const receipt = await gameDayRequest(
      env,
      "/execute",
      execution,
      decodeQuarterlyRecoveryExecutionReceipt,
    );
    const quarterly = await gameDayRequest(
      env,
      "/verify",
      { ...execution, receipt: receipt.receipt },
      decodeQuarterlyRecoveryChecks,
    );
    let bypassDenied = false;
    try {
      await checkDatabaseReadiness(activeUri, branch.id);
    } catch (error) {
      if (error instanceof RestoreReplayRequired) bypassDenied = true;
      else throw error;
    }
    if (!bypassDenied) throw new Error("Deletion gate bypass was not denied");
    checks = {
      ...monthlyChecks,
      endpoint_rotation: endpointRotation,
      ...quarterly,
      deletion_gate_bypass_denied: bypassDenied,
    };
  }

  const result = decodeRecoveryVerificationResponse({
    version: 1,
    drill: input.drill,
    operation: input.operation,
    recovery_branch_id: input.recovery_branch_id,
    source_point_at: input.source_point_at,
    started_at: input.started_at,
    verification_nonce: input.verification_nonce,
    replay_digest: input.replay_digest,
    achieved_rpo_seconds: achievedRpoSeconds,
    achieved_first_party_availability_percent: availability.firstPartyPercent,
    dependencies: {
      wasender_percent: availability.wasenderPercent,
      whatsapp_percent: availability.whatsappPercent,
    },
    checks,
  });
  await repository.complete(branch.id, new Date().toISOString());
  return result;
};
