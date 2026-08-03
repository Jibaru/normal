import { describe, expect, test } from "vitest";
import { createDeploymentSmokeHandler } from "../src/deployment-smoke";

describe("deployment smoke boundary", () => {
  test("authenticates, starts a disposable canary, and reports completion", async () => {
    const calls: string[] = [];
    const handler = createDeploymentSmokeHandler({
      complete: async (_id) => ({
        status: "complete",
        subsystems: ["database", "provider-control", "queue", "r2-kms"],
      }),
      secret: "a".repeat(64),
      start: async () => {
        calls.push("start");
        return `smk_${"a".repeat(43)}`;
      },
    });
    const start = await handler(
      new Request("https://api.example.test/_internal/deployment-smoke", {
        method: "POST",
        headers: { authorization: `Bearer ${"a".repeat(64)}` },
      }),
    );
    expect(start.status).toBe(202);
    expect(calls).toEqual(["start"]);

    const poll = await handler(
      new Request(
        `https://api.example.test/_internal/deployment-smoke?id=smk_${"a".repeat(43)}`,
        { headers: { authorization: `Bearer ${"a".repeat(64)}` } },
      ),
    );
    expect(await poll.json()).toEqual({
      status: "complete",
      subsystems: ["database", "provider-control", "queue", "r2-kms"],
    });
  });

  test("does not reveal whether an unauthorized canary exists", async () => {
    const handler = createDeploymentSmokeHandler({
      complete: async () => ({ status: "complete", subsystems: [] }),
      secret: "a".repeat(64),
      start: async () => "unused",
    });
    const response = await handler(
      new Request(
        "https://api.example.test/_internal/deployment-smoke?id=smk_secret",
        {
          headers: { authorization: "Bearer wrong" },
        },
      ),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
