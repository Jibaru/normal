import { describe, expect, test, vi } from "vitest";
import type { OperationsControlEnvironment } from "../src/environment";
import { handleRequest } from "../src/index";

const environment = {
  DEPLOYMENT_ENVIRONMENT: "production",
  OBSERVABILITY_QUERY_TOKEN: "a".repeat(64),
  PAGER_RECEIPT_TOKEN: "b".repeat(64),
  PAGER_WEBHOOK_TOKEN: "c".repeat(64),
} as OperationsControlEnvironment;

describe("operations control boundary", () => {
  test("rejects unauthenticated requests before reading the body", async () => {
    const text = vi.fn(async () => "{}");
    const request = new Request(
      "https://operations.normal.fast/v1/availability",
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    Object.defineProperty(request, "text", { value: text });
    const response = await handleRequest(request, environment);
    expect(response.status).toBe(401);
    expect(text).not.toHaveBeenCalled();
  });

  test("keeps the boundary unavailable outside production", async () => {
    const response = await handleRequest(
      new Request("https://operations.normal.fast/v1/availability", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(64)}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
      { ...environment, DEPLOYMENT_ENVIRONMENT: "preview" },
    );
    expect(response.status).toBe(503);
  });
});
