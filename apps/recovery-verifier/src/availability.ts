import type { RecoveryVerificationRequest } from "@whatsapp-mcp/contracts/recovery";
import { required, safeHttpsUrl } from "./config";
import type { RecoveryVerifierEnvironment } from "./environment";

export interface AvailabilityEvidence {
  readonly apiKeyHmacRotated: true;
  readonly firstPartyPercent: number;
  readonly predecessorHmacRejected: true;
  readonly recoveredSourcePointAt: string;
  readonly sampledKeysUsable: true;
  readonly wasenderPercent: number;
  readonly whatsappPercent: number;
}

export type AvailabilityFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const percentage = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;

export const queryAvailability = async (
  env: RecoveryVerifierEnvironment,
  input: RecoveryVerificationRequest,
  fetcher: AvailabilityFetch = fetch,
): Promise<AvailabilityEvidence> => {
  const response = await fetcher(
    safeHttpsUrl(env.OBSERVABILITY_QUERY_URL, "Observability query URL"),
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${required(
          env.OBSERVABILITY_QUERY_TOKEN,
          "Observability query token",
        )}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        window: "30d",
        as_of: input.started_at,
        operation: input.operation,
        recovery_branch_id: input.recovery_branch_id,
        source_point_at: input.source_point_at,
        verification_nonce: input.verification_nonce,
        replay_digest: input.replay_digest,
      }),
    },
  );
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("application/json")
  )
    throw new Error("Observability query failed");
  const candidate = (await response.json()) as Record<string, unknown>;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 17 ||
    candidate.version !== 1 ||
    candidate.window !== "30d" ||
    candidate.as_of !== input.started_at ||
    candidate.operation !== input.operation ||
    candidate.recovery_branch_id !== input.recovery_branch_id ||
    candidate.source_point_at !== input.source_point_at ||
    typeof candidate.recovered_source_point_at !== "string" ||
    candidate.verification_nonce !== input.verification_nonce ||
    candidate.replay_digest !== input.replay_digest ||
    !percentage(candidate.first_party_percent) ||
    !percentage(candidate.wasender_percent) ||
    !percentage(candidate.whatsapp_percent)
  )
    throw new Error("Observability query returned invalid evidence");
  const started = Date.parse(String(candidate.window_started_at));
  const completed = Date.parse(String(candidate.window_completed_at));
  const recoveredSourcePoint = Date.parse(candidate.recovered_source_point_at);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    !Number.isFinite(recoveredSourcePoint) ||
    new Date(recoveredSourcePoint).toISOString() !==
      candidate.recovered_source_point_at ||
    completed !== Date.parse(input.started_at) ||
    completed - started !== 30 * 86_400_000
  )
    throw new Error("Observability query returned the wrong window");
  if (
    candidate.sampled_keys_usable !== true ||
    candidate.api_key_hmac_rotated !== true ||
    candidate.predecessor_hmac_rejected !== true
  )
    throw new Error("Observability query returned invalid recovery evidence");
  return {
    apiKeyHmacRotated: true,
    firstPartyPercent: candidate.first_party_percent,
    predecessorHmacRejected: true,
    recoveredSourcePointAt: candidate.recovered_source_point_at,
    sampledKeysUsable: true,
    wasenderPercent: candidate.wasender_percent,
    whatsappPercent: candidate.whatsapp_percent,
  };
};
