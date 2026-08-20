import { AvailabilityError, handleAvailability } from "./availability";
import { required, safeJson, verifyToken } from "./config";
import type { OperationsControlEnvironment } from "./environment";
import { handleAlert, handleReceipt } from "./pager";

const bearer = (request: Request) => {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
};

export const handleRequest = async (
  request: Request,
  env: OperationsControlEnvironment,
) => {
  try {
    if (env.DEPLOYMENT_ENVIRONMENT !== "production")
      throw new Error("Operations control is unavailable");
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      request.method !== "POST" ||
      url.search !== "" ||
      request.headers.get("content-type")?.split(";", 1)[0] !==
        "application/json"
    )
      return safeJson({ status: "failed" }, 404);
    let token: string;
    if (url.pathname === "/v1/availability")
      token = required(
        env.OBSERVABILITY_QUERY_TOKEN,
        "Observability query token",
      );
    else if (url.pathname === "/v1/alerts")
      token = required(env.PAGER_WEBHOOK_TOKEN, "Pager webhook token");
    else if (url.pathname === "/v1/receipts")
      token = required(env.PAGER_RECEIPT_TOKEN, "Pager receipt token");
    else return safeJson({ status: "failed" }, 404);
    if (!(await verifyToken(bearer(request), token)))
      return safeJson({ status: "failed" }, 401);
    if (url.pathname === "/v1/availability")
      return await handleAvailability(request, env);
    if (url.pathname === "/v1/alerts") return await handleAlert(request, env);
    return await handleReceipt(request, env);
  } catch (error) {
    return safeJson(
      { status: "failed" },
      503,
      error instanceof AvailabilityError
        ? { "x-operations-availability-stage": error.stage }
        : undefined,
    );
  }
};

export default { fetch: handleRequest };
