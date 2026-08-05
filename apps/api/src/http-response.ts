export const noStoreResponse = (
  body: BodyInit | null,
  status: number,
  headers: Readonly<Record<string, string>> = {},
  contentType?: string,
): Response =>
  new Response(body, {
    headers: {
      ...headers,
      "cache-control": "no-store",
      ...(contentType === undefined ? {} : { "content-type": contentType }),
    },
    status,
  });

export const noStoreJsonResponse = (
  body: unknown,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  noStoreResponse(
    JSON.stringify(body),
    status,
    headers,
    "application/json; charset=utf-8",
  );
