import { DurableObject } from "cloudflare:workers";
import { required, verifyToken } from "./config";
import { type StartRequest, startRequestSchema } from "./contract";

export { ProductionRecoveryWorkflow } from "./workflow";

const operationPattern = /^recovery_operation_[a-f0-9]{32}$/u;
const terminalStatuses = new Set(["complete", "errored", "terminated"]);
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

interface ActiveOperation extends StartRequest {
  readonly createdAt: number;
  readonly operation: string;
}

export class RecoveryGate extends DurableObject<Env> {
  private serial = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    const previous = this.serial;
    let release: () => void = () => undefined;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.start(request);
    } finally {
      release();
    }
  }

  private async start(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ status: "failed" }, 405);
    const payload = startRequestSchema.parse(await request.json());
    const active = await this.ctx.storage.get<ActiveOperation>("active");
    if (active) {
      try {
        const instance = await this.env.RECOVERY_WORKFLOW.get(active.operation);
        const status = await instance.status();
        if (
          active.drill === payload.drill &&
          active.requested_source_point_at ===
            payload.requested_source_point_at &&
          active.serving === payload.serving
        )
          return json({ operation: active.operation, status: "running" }, 202);
        if (!terminalStatuses.has(status.status)) {
          return json({ status: "failed" }, 409);
        }
      } catch (error) {
        if (Date.now() - active.createdAt <= 31 * 86_400_000) throw error;
        await this.ctx.storage.delete("active");
      }
    }
    const operation = `recovery_operation_${crypto.randomUUID().replaceAll("-", "")}`;
    await this.ctx.storage.put("active", {
      ...payload,
      createdAt: Date.now(),
      operation,
    });
    try {
      await this.env.RECOVERY_WORKFLOW.create({
        id: operation,
        params: payload,
        retention: { successRetention: "30 days", errorRetention: "30 days" },
      });
    } catch (error) {
      try {
        await this.env.RECOVERY_WORKFLOW.get(operation);
      } catch {
        await this.ctx.storage.delete("active");
        throw error;
      }
    }
    return json({ operation, status: "running" }, 202);
  }
}

const authorized = async (request: Request, env: Env) => {
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  return verifyToken(
    provided,
    required(env.RECOVERY_CONTROL_TOKEN, "Recovery control token"),
  );
};

const readStartRequest = async (request: Request): Promise<StartRequest> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 1_024) throw new Error("Recovery request is too large");
  const body = await request.text();
  if (body.length > 1_024) throw new Error("Recovery request is too large");
  const parsed = startRequestSchema.parse(JSON.parse(body) as unknown);
  const source = Date.parse(parsed.requested_source_point_at);
  const now = Date.now();
  if (
    new Date(source).toISOString() !== parsed.requested_source_point_at ||
    source > now ||
    now - source > 7 * 86_400_000
  )
    throw new Error("Recovery source point is outside the prior seven days");
  return parsed;
};

export const handleRequest: ExportedHandlerFetchHandler<Env> = async (
  request,
  env,
) => {
  if (!(await authorized(request, env))) return json({ status: "failed" }, 401);
  const url = new URL(request.url);
  try {
    if (url.protocol !== "https:") return json({ status: "failed" }, 400);
    if (request.method === "POST" && url.pathname === "/drills") {
      const payload = await readStartRequest(request);
      const gate = env.RECOVERY_GATE.getByName("production-recovery");
      return gate.fetch("https://recovery-gate.internal/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const match = /^\/drills\/([^/]+)$/u.exec(url.pathname);
    if (request.method !== "GET" || !match?.[1])
      return json({ status: "failed" }, 404);
    const operation = decodeURIComponent(match[1]);
    if (!operationPattern.test(operation))
      return json({ status: "failed" }, 404);
    const status = await (await env.RECOVERY_WORKFLOW.get(operation)).status();
    if (
      ["queued", "running", "paused", "waiting", "waitingForPause"].includes(
        status.status,
      )
    )
      return json({ status: "running" });
    if (status.status === "complete" && status.output !== undefined)
      return json({ status: "complete", evidence: status.output });
    if (terminalStatuses.has(status.status)) return json({ status: "failed" });
    return json({ status: "failed" }, 503);
  } catch {
    return json({ status: "failed" }, 400);
  }
};

export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
