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

export const sendCanary = async (
  endpoint: string | undefined,
  fetcher: CanaryFetch = fetch,
): Promise<void> => {
  if (
    !endpoint ||
    !endpoint.startsWith("https://") ||
    /example|placeholder|replace/iu.test(endpoint)
  )
    throw new Error("PAGER_WEBHOOK_URL is unavailable");
  const response = await fetcher(endpoint, {
    body: makeCanaryPayload(),
    headers: { "content-type": "application/json" },
    method: "POST",
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Alert canary delivery failed (${response.status})`);
};

if (import.meta.main) {
  await sendCanary(process.env.PAGER_WEBHOOK_URL);
  console.info("Production alert delivery canary succeeded.");
}
