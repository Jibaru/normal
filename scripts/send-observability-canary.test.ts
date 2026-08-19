import { describe, expect, test } from "bun:test";
import { makeCanaryPayload, sendCanary } from "./send-observability-canary";

describe("production alert delivery canary", () => {
  test("delivers only the identity-free alert envelope", async () => {
    let body: string | undefined;
    let headers: RequestInit["headers"];
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    await sendCanary({
      endpoint: "https://pager.invalid/hooks/production",
      receiptEndpoint: "https://pager.invalid/receipts/production",
      receiptToken: "r".repeat(64),
      webhookToken: "w".repeat(64),
      observedAt: new Date(0),
      fetcher: async (input, init) => {
        requests.push({
          input: String(input),
          ...(init === undefined ? {} : { init }),
        });
        if (requests.length === 1) {
          body = String(init?.body);
          headers = init?.headers;
        }
        return requests.length === 1
          ? new Response(null, { status: 202 })
          : Response.json({
              delivered: true,
              observed_at: new Date(0).toISOString(),
            });
      },
    });
    expect(JSON.parse(body ?? "null")).toEqual({
      alert: "alert-delivery-canary",
      observedAt: expect.any(String),
      severity: "ticket",
      status: "firing",
    });
    expect([...new Headers(headers)]).toEqual([
      ["authorization", `Bearer ${"w".repeat(64)}`],
      ["content-type", "application/json"],
    ]);
  });

  test("fails closed for missing, placeholder, insecure, and rejected delivery", async () => {
    for (const endpoint of [
      undefined,
      "http://pager.test",
      "https://example.test/hook",
    ]) {
      await expect(
        sendCanary({
          endpoint,
          receiptEndpoint: "https://pager.invalid/receipt",
          receiptToken: "r".repeat(64),
          webhookToken: "w".repeat(64),
        }),
      ).rejects.toThrow("PAGER_WEBHOOK_URL is unavailable");
    }
    await expect(
      sendCanary({
        endpoint: "https://pager.invalid/hook",
        receiptEndpoint: "https://pager.invalid/receipt",
        receiptToken: "r".repeat(64),
        webhookToken: "w".repeat(64),
        fetcher: async () => new Response(null, { status: 503 }),
      }),
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
