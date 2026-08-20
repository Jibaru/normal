import { parseApiKeyCredential } from "@whatsapp-mcp/contracts/api-key";
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
import { makePgMcpToolRepository } from "@whatsapp-mcp/db/mcp-tool";
import { RestoreReplayRequired } from "@whatsapp-mcp/db/readiness";
import {
  makePgRecoveryVerifierRepository,
  verifyRecoveryRlsIsolation,
} from "@whatsapp-mcp/db/recovery-verifier";
import { digestApiKeyCredential } from "@whatsapp-mcp/domain/api-key-hmac";
import { createNeonRecoveryClient } from "@whatsapp-mcp/neon-recovery/client";
import { queryAvailability } from "./availability";
import { required } from "./config";
import type { RecoveryVerifierEnvironment } from "./environment";

const encoder = new TextEncoder();
export type RecoveryVerificationStage =
  | "availability"
  | "branch"
  | "completion"
  | "database_verification"
  | "endpoint_rotation"
  | "hmac_rotation"
  | "input"
  | "objectives"
  | "quarterly_game_day"
  | "rls_prepare"
  | "rls_verification"
  | "verifier_access"
  | "verifier_password"
  | "verifier_uri";
const toHex = (value: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const recoveryClient = (
  env: RecoveryVerifierEnvironment,
  runtimeRole:
    | "whatsapp_api_runtime"
    | "whatsapp_recovery_verifier" = "whatsapp_recovery_verifier",
) =>
  createNeonRecoveryClient({
    apiKey: required(env.NEON_RECOVERY_API_KEY, "Neon recovery API key"),
    projectId: required(env.NEON_PROJECT_ID, "Neon project identity"),
    parentBranchId: required(env.NEON_PARENT_BRANCH_ID, "Neon parent branch"),
    branchNamePrefix: env.RECOVERY_BRANCH_PREFIX,
    databaseName: env.RECOVERY_DATABASE_NAME,
    runtimeRole,
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

export const stableRecoveryProbeId = async (
  input: Pick<RecoveryVerificationRequest, "operation" | "recovery_branch_id">,
  ordinal: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
) => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(
        `${input.operation}:${input.recovery_branch_id}:rls-probe:${ordinal}`,
      ),
    ),
  ).slice(0, 16);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined)
    throw new Error("Recovery RLS probe identity failed");
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const verifyIsolatedApiKeyHmacRotation = async () => {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-";
  const randomPart = (length: number) =>
    [...crypto.getRandomValues(new Uint8Array(length))]
      .map((byte) => alphabet[byte & 63])
      .join("");
  const parsed = parseApiKeyCredential(
    `normal_apk_${randomPart(21)}.${randomPart(43)}`,
  );
  if (parsed === null) throw new Error("Isolated API Key credential failed");
  const predecessorSecret = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const replacementSecret = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const predecessorDigest = await digestApiKeyCredential(
    predecessorSecret,
    parsed.credential,
  );
  const replacementDigest = await digestApiKeyCredential(
    replacementSecret,
    parsed.credential,
  );
  const rotated = toHex(predecessorDigest) !== toHex(replacementDigest);
  const predecessorRejected =
    toHex(
      await digestApiKeyCredential(replacementSecret, parsed.credential),
    ) !== toHex(predecessorDigest);
  if (!rotated || !predecessorRejected)
    throw new Error("Isolated API Key HMAC rotation failed");
  return { rotated: true, predecessorRejected: true } as const;
};

export const verifyRecovery = async (
  env: RecoveryVerifierEnvironment,
  candidate: unknown,
  reportStage: (stage: RecoveryVerificationStage) => void = () => undefined,
) => {
  reportStage("input");
  if (env.DEPLOYMENT_ENVIRONMENT !== "production")
    throw new Error("Production recovery verification is unavailable");
  const input = decodeRecoveryVerificationRequest(candidate);
  if ((await expectedReplayDigest(input)) !== input.replay_digest)
    throw new Error("Recovery replay digest does not match");
  reportStage("branch");
  const client = recoveryClient(env);
  const branch = await client.findGuardedPitrBranch({
    name: `${env.RECOVERY_BRANCH_PREFIX}${input.operation}`,
    parentTimestamp: input.source_point_at,
  });
  if (branch === "absent" || branch.id !== input.recovery_branch_id)
    throw new Error("Guarded recovery branch is unavailable");
  reportStage("verifier_password");
  await client.resetRestoreRuntimePassword(branch);
  reportStage("verifier_uri");
  const firstUri = await client.getDirectRestoreUri(branch);
  reportStage("verifier_access");
  await checkRestrictedDatabaseAccess(firstUri);
  reportStage("database_verification");
  let repository = makePgRecoveryVerifierRepository(firstUri);
  let activeUri = firstUri;
  let database = await repository.verify(branch.id, new Date().toISOString());

  let endpointRotation = true;
  if (input.drill === "quarterly_game_day") {
    reportStage("endpoint_rotation");
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

  let quarterly: ReturnType<typeof decodeQuarterlyRecoveryChecks> | undefined;
  if (input.drill === "quarterly_game_day") {
    reportStage("quarterly_game_day");
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
    quarterly = await gameDayRequest(
      env,
      "/verify",
      { ...execution, receipt: receipt.receipt },
      decodeQuarterlyRecoveryChecks,
    );
  }

  const probeIds = await Promise.all([
    stableRecoveryProbeId(input, 1),
    stableRecoveryProbeId(input, 2),
    stableRecoveryProbeId(input, 3),
    stableRecoveryProbeId(input, 4),
    stableRecoveryProbeId(input, 5),
    stableRecoveryProbeId(input, 6),
    stableRecoveryProbeId(input, 7),
    stableRecoveryProbeId(input, 8),
  ]);
  const [
    firstProbeAccountId,
    secondProbeAccountId,
    probeConnectionId,
    probeConversationId,
    probeMessageId,
    probeMediaId,
    probeAuthorizationId,
    probeAuditLogId,
  ] = probeIds;
  reportStage("rls_prepare");
  const probeRequired = await repository.prepareRlsProbe(
    branch.id,
    firstProbeAccountId,
    secondProbeAccountId,
  );
  let rlsIsolated = !probeRequired;
  let mediaLossStateTransitioned = !probeRequired;
  if (probeRequired) {
    reportStage("rls_verification");
    try {
      const apiRuntimeClient = recoveryClient(env, "whatsapp_api_runtime");
      await apiRuntimeClient.resetRestoreRuntimePassword(branch);
      const apiRuntimeUri = await apiRuntimeClient.getDirectRestoreUri(branch);
      await checkRestrictedDatabaseAccess(apiRuntimeUri);
      await verifyRecoveryRlsIsolation(
        apiRuntimeUri,
        firstProbeAccountId,
        secondProbeAccountId,
      );
      rlsIsolated = true;
      if (quarterly !== undefined) {
        const mediaFailureRequired = await repository.prepareMediaLossProbe(
          branch.id,
          firstProbeAccountId,
          probeConnectionId,
          probeConversationId,
          probeMessageId,
          probeMediaId,
          probeAuthorizationId,
          probeAuditLogId,
        );
        if (mediaFailureRequired) {
          await makePgMcpToolRepository(apiRuntimeUri).failStoredMediaRead({
            auditLogId: probeAuditLogId,
            completedAt: new Date(),
            errorCode: "resource_unavailable",
            mediaId: probeMediaId,
            mediaFailureCode: "object_missing",
          });
        }
        mediaLossStateTransitioned = await repository.verifyMediaLossProbe(
          branch.id,
          firstProbeAccountId,
          probeMediaId,
          probeAuditLogId,
        );
        if (!mediaLossStateTransitioned)
          throw new Error("Stored Media loss did not become failed");
      }
    } finally {
      await repository.completeRlsProbe(
        branch.id,
        firstProbeAccountId,
        secondProbeAccountId,
      );
    }
  }
  database = { ...database, rlsOk: database.rlsOk && rlsIsolated };

  reportStage("availability");
  const availability = await queryAvailability(env, input);
  reportStage("hmac_rotation");
  const hmac = await verifyIsolatedApiKeyHmacRotation();
  reportStage("objectives");
  const achievedRpoSeconds = Math.abs(
    (Date.parse(input.source_point_at) - Date.parse(database.sourcePointAt)) /
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
    if (quarterly === undefined || !mediaLossStateTransitioned)
      throw new Error("Quarterly recovery checks are incomplete");
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
  reportStage("completion");
  await repository.complete(branch.id, new Date().toISOString());
  return result;
};
