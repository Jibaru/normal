import { describe, expect, test } from "bun:test";
import { makeCanaryPayload, sendCanary } from "./send-observability-canary";

describe("production alert delivery canary", () => {
  test("delivers only the identity-free alert envelope", async () => {
    let body: string | undefined;
    let headers: RequestInit["headers"];
    await sendCanary(
      "https://pager.invalid/hooks/production",
      async (_input, init) => {
        body = String(init?.body);
        headers = init?.headers;
        return new Response(null, { status: 202 });
      },
    );
    expect(JSON.parse(body ?? "null")).toEqual({
      alert: "alert-delivery-canary",
      observedAt: expect.any(String),
      severity: "ticket",
      status: "firing",
    });
    expect([...new Headers(headers)]).toEqual([
      ["content-type", "application/json"],
    ]);
  });

  test("fails closed for missing, placeholder, insecure, and rejected delivery", async () => {
    for (const endpoint of [
      undefined,
      "http://pager.test",
      "https://example.test/hook",
    ]) {
      await expect(sendCanary(endpoint)).rejects.toThrow(
        "PAGER_WEBHOOK_URL is unavailable",
      );
    }
    await expect(
      sendCanary(
        "https://pager.invalid/hook",
        async () => new Response(null, { status: 503 }),
      ),
    ).rejects.toThrow("Alert canary delivery failed (503)");
  });

  test("uses exactly the configured safe fields", () => {
    expect(Object.keys(JSON.parse(makeCanaryPayload(new Date(0))))).toEqual([
      "alert",
      "observedAt",
      "severity",
      "status",
    ]);
  });
});
