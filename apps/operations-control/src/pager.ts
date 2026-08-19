import { type OperationsFetch, queryPagerDelivery } from "./cloudflare";
import { canonicalTimestamp, exactKeys, readJson, safeJson } from "./config";
import type { OperationsControlEnvironment } from "./environment";

const alerts = ["alert-delivery-canary", "recovery-game-day"] as const;
const receiptPrefix = "pager-receipt/v1/";

interface StoredReceipt {
  readonly messageId: string;
  readonly observedAt: string;
  readonly version: 1;
}

const keyFor = async (alert: string, observedAt: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${alert}:${observedAt}`),
  );
  return `${receiptPrefix}${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

const pagerAddress = (value: string | undefined) => {
  if (
    typeof value !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) ||
    value.length > 254 ||
    /example|placeholder|replace/iu.test(value)
  )
    throw new Error("Pager destination is unavailable");
  return value;
};

export const handleAlert = async (
  request: Request,
  env: OperationsControlEnvironment,
) => {
  const candidate = await readJson(request);
  if (
    !exactKeys(candidate, ["alert", "observedAt", "severity", "status"]) ||
    !alerts.includes(candidate.alert as (typeof alerts)[number]) ||
    (candidate.severity !== "ticket" && candidate.severity !== "page") ||
    candidate.status !== "firing" ||
    !canonicalTimestamp(candidate.observedAt)
  )
    throw new Error("Pager alert is invalid");
  const alert = candidate.alert as (typeof alerts)[number];
  const observedAt = candidate.observedAt;
  const severity = candidate.severity as "page" | "ticket";
  const response = await env.PAGER_EMAIL.send({
    from: {
      email: "pager@alerts.normal.fast",
      name: "normal.fast operations",
    },
    to: pagerAddress(env.PAGER_DESTINATION_ADDRESS),
    subject: `[${severity}] ${alert}`,
    text: [
      `Alert: ${alert}`,
      `Severity: ${severity}`,
      "Status: firing",
      `Observed at: ${observedAt}`,
    ].join("\n"),
    html: `<p>Alert: ${alert}</p><p>Severity: ${severity}</p><p>Status: firing</p><p>Observed at: ${observedAt}</p>`,
  });
  if (
    typeof response.messageId !== "string" ||
    response.messageId.length === 0 ||
    response.messageId.length > 998
  )
    throw new Error("Pager alert was rejected");
  const stored: StoredReceipt = {
    messageId: response.messageId,
    observedAt,
    version: 1,
  };
  await env.ALERT_RECEIPTS.put(
    await keyFor(alert, observedAt),
    JSON.stringify(stored),
    { expirationTtl: 86_400 },
  );
  return safeJson({ accepted: true }, 202);
};

export const handleReceipt = async (
  request: Request,
  env: OperationsControlEnvironment,
  fetcher: OperationsFetch = fetch,
) => {
  const candidate = await readJson(request);
  if (
    !exactKeys(candidate, ["alert", "observed_at"]) ||
    !alerts.includes(candidate.alert as (typeof alerts)[number]) ||
    !canonicalTimestamp(candidate.observed_at)
  )
    throw new Error("Pager receipt is invalid");
  const stored = await env.ALERT_RECEIPTS.get<StoredReceipt>(
    await keyFor(candidate.alert as string, candidate.observed_at),
    "json",
  );
  if (
    stored?.version !== 1 ||
    stored.observedAt !== candidate.observed_at ||
    typeof stored.messageId !== "string" ||
    stored.messageId.length === 0
  )
    throw new Error("Pager receipt is unavailable");
  const observedAt = candidate.observed_at;
  const delivery = await queryPagerDelivery(
    env,
    {
      completedAt: new Date(Date.now() + 60_000).toISOString(),
      messageId: stored.messageId,
      startedAt: new Date(Date.parse(observedAt) - 5 * 60_000).toISOString(),
    },
    fetcher,
  );
  if (delivery === "failed") throw new Error("Pager delivery failed");
  return safeJson({
    delivered: delivery === "delivered",
    observed_at: observedAt,
  });
};
