export const makeCanaryPayload = (observedAt = new Date()): string =>
  JSON.stringify({
    alert: "alert-delivery-canary",
    observedAt: observedAt.toISOString(),
    severity: "ticket",
    status: "firing",
  });

export type CanaryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const requiredUrl = (value: string | undefined, name: string) => {
  if (!value || /example|placeholder|replace/iu.test(value))
    throw new Error(`${name} is unavailable`);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error(`${name} is unavailable`);
  return url.href;
};

const requiredToken = (value: string | undefined, name: string) => {
  if (
    !value ||
    value.length < 32 ||
    /example|placeholder|replace/iu.test(value)
  )
    throw new Error(`${name} is unavailable`);
  return value;
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export interface CanaryOptions {
  readonly endpoint: string | undefined;
  readonly fetcher?: CanaryFetch;
  readonly observedAt?: Date;
  readonly pause?: (milliseconds: number) => Promise<void>;
  readonly receiptEndpoint: string | undefined;
  readonly receiptToken: string | undefined;
  readonly webhookToken: string | undefined;
}

export const sendCanary = async (options: CanaryOptions): Promise<void> => {
  const endpoint = requiredUrl(options.endpoint, "PAGER_WEBHOOK_URL");
  const receiptEndpoint = requiredUrl(
    options.receiptEndpoint,
    "PAGER_RECEIPT_URL",
  );
  const webhookToken = requiredToken(
    options.webhookToken,
    "PAGER_WEBHOOK_TOKEN",
  );
  const receiptToken = requiredToken(
    options.receiptToken,
    "PAGER_RECEIPT_TOKEN",
  );
  const fetcher = options.fetcher ?? fetch;
  const observedAt = options.observedAt ?? new Date();
  const observedAtText = observedAt.toISOString();
  const response = await fetcher(endpoint, {
    body: makeCanaryPayload(observedAt),
    headers: {
      authorization: `Bearer ${webhookToken}`,
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Alert canary delivery failed (${response.status})`);

  const pause = options.pause ?? sleep;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await fetcher(receiptEndpoint, {
      body: JSON.stringify({
        alert: "alert-delivery-canary",
        observed_at: observedAtText,
      }),
      headers: {
        authorization: `Bearer ${receiptToken}`,
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
    });
    const body = receipt.ok
      ? ((await receipt.json()) as {
          readonly delivered?: unknown;
          readonly observed_at?: unknown;
        })
      : null;
    if (
      body?.observed_at !== observedAtText ||
      typeof body.delivered !== "boolean"
    )
      throw new Error("Alert canary receipt failed");
    if (body.delivered) return;
    await pause(2_000);
  }
  throw new Error("Alert canary delivery was not confirmed");
};

if (import.meta.main) {
  await sendCanary({
    endpoint: process.env.PAGER_WEBHOOK_URL,
    receiptEndpoint: process.env.PAGER_RECEIPT_URL,
    receiptToken: process.env.PAGER_RECEIPT_TOKEN,
    webhookToken: process.env.PAGER_WEBHOOK_TOKEN,
  });
  console.info("Production alert delivery canary succeeded.");
}
