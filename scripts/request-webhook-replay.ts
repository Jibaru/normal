const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const identifierPattern = /^[a-f0-9]{32}$/u;
const operatorReferencePattern = /^[a-f0-9]{64}$/u;
const reasonCodes = [
  "dependency_recovered",
  "schema_support_deployed",
  "transient_incident_resolved",
] as const;

export type ReplayReasonCode = (typeof reasonCodes)[number];

export interface WebhookReplayOperatorConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly operatorReference: string;
  readonly queueId: string;
}

type ReplayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const loadWebhookReplayOperatorConfig = (
  environment: Record<string, string | undefined>,
): WebhookReplayOperatorConfig => {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = environment.CLOUDFLARE_REPLAY_API_TOKEN;
  const operatorReference = environment.WEBHOOK_REPLAY_OPERATOR_REFERENCE;
  const queueId = environment.CLOUDFLARE_INGESTION_REPLAY_QUEUE_ID;
  if (!accountId || !identifierPattern.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a Cloudflare identifier");
  }
  if (!queueId || !identifierPattern.test(queueId)) {
    throw new Error(
      "CLOUDFLARE_INGESTION_REPLAY_QUEUE_ID must be a Cloudflare identifier",
    );
  }
  if (!apiToken || apiToken.length < 20 || apiToken.length > 512) {
    throw new Error("CLOUDFLARE_REPLAY_API_TOKEN is required");
  }
  if (!operatorReference || !operatorReferencePattern.test(operatorReference)) {
    throw new Error(
      "WEBHOOK_REPLAY_OPERATOR_REFERENCE must be a 64-character opaque fingerprint",
    );
  }
  return { accountId, apiToken, operatorReference, queueId };
};

export const requestWebhookReplay = async (
  input: {
    readonly config: WebhookReplayOperatorConfig;
    readonly incidentReference: string;
    readonly reasonCode: ReplayReasonCode;
  },
  dependencies: {
    readonly fetch: ReplayFetch;
    readonly nextRequestId: () => string;
    readonly now: () => string;
  } = {
    fetch,
    nextRequestId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
  },
): Promise<string> => {
  if (!uuidPattern.test(input.incidentReference)) {
    throw new Error("incident reference must be a UUID");
  }
  if (!reasonCodes.includes(input.reasonCode)) {
    throw new Error("invalid replay reason code");
  }
  const requestId = dependencies.nextRequestId();
  const requestedAt = dependencies.now();
  if (
    !uuidPattern.test(requestId) ||
    new Date(requestedAt).toISOString() !== requestedAt
  ) {
    throw new Error("invalid replay request identity or time");
  }
  const response = await dependencies.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${input.config.accountId}/queues/${input.config.queueId}/messages`,
    {
      body: JSON.stringify({
        body: {
          incident_reference: input.incidentReference,
          operator_reference: input.config.operatorReference,
          reason_code: input.reasonCode,
          request_id: requestId,
          requested_at: requestedAt,
          version: 1,
        },
        content_type: "json",
      }),
      headers: {
        authorization: `Bearer ${input.config.apiToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error("Cloudflare replay Queue returned an invalid response");
  }
  if (
    !response.ok ||
    typeof result !== "object" ||
    result === null ||
    (result as Record<string, unknown>).success !== true
  ) {
    throw new Error("Cloudflare replay Queue rejected the request");
  }
  return requestId;
};

if (import.meta.main) {
  const [incidentReference, reasonCode] = process.argv.slice(2);
  if (
    incidentReference === undefined ||
    reasonCode === undefined ||
    !reasonCodes.includes(reasonCode as ReplayReasonCode)
  ) {
    throw new Error(
      "usage: bun run ingestion:replay <incident-reference> <dependency_recovered|schema_support_deployed|transient_incident_resolved>",
    );
  }
  const requestId = await requestWebhookReplay({
    config: loadWebhookReplayOperatorConfig(process.env),
    incidentReference,
    reasonCode: reasonCode as ReplayReasonCode,
  });
  console.info(
    JSON.stringify({ attempt_reference: requestId, outcome: "queued" }),
  );
}
