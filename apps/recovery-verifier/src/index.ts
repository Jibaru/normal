import { decodeRecoveryVerificationRequest } from "@whatsapp-mcp/contracts/recovery";
import { required, verifyToken } from "./config";
import type { RecoveryVerifierEnvironment } from "./environment";
import { type RecoveryVerificationStage, verifyRecovery } from "./verify";

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

const authorized = async (
  request: Request,
  env: RecoveryVerifierEnvironment,
) => {
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  return verifyToken(
    provided,
    required(env.RECOVERY_EVIDENCE_TOKEN, "Recovery evidence token"),
  );
};

const readRequest = async (request: Request) => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 65_536)
    throw new Error("Recovery evidence request is too large");
  const body = await request.text();
  if (body.length > 65_536)
    throw new Error("Recovery evidence request is too large");
  return decodeRecoveryVerificationRequest(JSON.parse(body) as unknown);
};

export const handleRequest = async (
  request: Request,
  env: RecoveryVerifierEnvironment,
) => {
  if (!(await authorized(request, env))) return json({ status: "failed" }, 401);
  let stage: RecoveryVerificationStage | "request" = "request";
  try {
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      request.method !== "POST" ||
      url.pathname !== "/verify" ||
      request.headers.get("content-type")?.split(";", 1)[0] !==
        "application/json"
    )
      return json({ status: "failed" }, 404);
    const input = await readRequest(request);
    if (request.headers.get("idempotency-key") !== input.operation)
      throw new Error("Recovery verification identity mismatch");
    return json(
      await verifyRecovery(env, input, (reported) => {
        stage = reported;
      }),
    );
  } catch {
    return json({ status: "failed" }, 503, {
      "x-recovery-verification-stage": stage,
    });
  }
};

export default { fetch: handleRequest };
