export const noStoreJsonResponse = (
  body: unknown,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      ...headers,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });
