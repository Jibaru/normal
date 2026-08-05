import { noStoreJsonResponse } from "./http-response";

const path = "/_internal/deployment-smoke";
const canaryPattern = /^smk_[A-Za-z0-9_-]{43}$/u;
const secretPattern = /^[a-f0-9]{64}$/iu;

export interface DeploymentSmokeState {
  readonly status: "complete" | "failed" | "pending";
  readonly subsystems: ReadonlyArray<string>;
}

export interface DeploymentSmokeOptions {
  readonly complete: (canaryId: string) => Promise<DeploymentSmokeState>;
  readonly secret: string;
  readonly start: () => Promise<string>;
}

const json = (body: unknown, status: number) =>
  noStoreJsonResponse(body, status);

const bytes = (value: string) => new TextEncoder().encode(value);
const constantTimeEqual = (left: string, right: string): boolean => {
  const a = bytes(left);
  const b = bytes(right);
  let difference = a.byteLength ^ b.byteLength;
  for (let index = 0; index < Math.max(a.byteLength, b.byteLength); index += 1)
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
};

export const isDeploymentSmokeRequest = (request: Request): boolean =>
  new URL(request.url).pathname === path;

export const createDeploymentSmokeHandler =
  (options: DeploymentSmokeOptions) =>
  async (request: Request): Promise<Response> => {
    const authorization = request.headers.get("authorization") ?? "";
    if (
      !secretPattern.test(options.secret) ||
      !constantTimeEqual(authorization, `Bearer ${options.secret}`)
    )
      return json({ error: "not_found" }, 404);
    const url = new URL(request.url);
    if (request.method === "POST" && url.search === "") {
      const canaryId = await options.start();
      if (!canaryPattern.test(canaryId))
        return json({ error: "unavailable" }, 503);
      return json({ canary_id: canaryId }, 202);
    }
    const canaryId = url.searchParams.get("id") ?? "";
    if (request.method !== "GET" || !canaryPattern.test(canaryId))
      return json({ error: "not_found" }, 404);
    return json(await options.complete(canaryId), 200);
  };
