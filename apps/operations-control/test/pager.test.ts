import { describe, expect, test, vi } from "vitest";
import type { OperationsControlEnvironment } from "../src/environment";
import { handleAlert, handleReceipt } from "../src/pager";

const observedAt = "2026-08-19T12:00:00.000Z";

const makeEnvironment = () => {
  const values = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const get = vi.fn(async (key: string) => {
    const value = values.get(key);
    return value ? JSON.parse(value) : null;
  });
  const send = vi.fn(async () => ({ messageId: "message-safe-id" }));
  return {
    environment: {
      ALERT_RECEIPTS: { get, put },
      CLOUDFLARE_ANALYTICS_TOKEN: "a".repeat(64),
      CLOUDFLARE_ZONE_ID: "b".repeat(32),
      PAGER_DESTINATION_ADDRESS: "hi@cueva.io",
      PAGER_EMAIL: { send },
    } as unknown as OperationsControlEnvironment,
    send,
  };
};

describe("production pager authority", () => {
  test("sends only the closed alert and confirms final delivery by message id", async () => {
    const { environment, send } = makeEnvironment();
    const alert = {
      alert: "recovery-game-day",
      observedAt,
      severity: "ticket",
      status: "firing",
    };
    const accepted = await handleAlert(
      new Request("https://operations.normal.fast/v1/alerts", {
        method: "POST",
        body: JSON.stringify(alert),
      }),
      environment,
    );
    expect(accepted.status).toBe(202);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "hi@cueva.io",
        from: expect.objectContaining({ email: "pager@alerts.normal.fast" }),
      }),
    );

    const fetcher = vi.fn(async () =>
      Response.json({
        data: {
          viewer: {
            zones: [
              {
                emailSendingAdaptive: [
                  {
                    datetime: observedAt,
                    isLastEvent: 1,
                    messageId: "message-safe-id",
                    status: "delivered",
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    const receipt = await handleReceipt(
      new Request("https://operations.normal.fast/v1/receipts", {
        method: "POST",
        body: JSON.stringify({
          alert: "recovery-game-day",
          observed_at: observedAt,
        }),
      }),
      environment,
      fetcher,
    );
    await expect(receipt.json()).resolves.toEqual({
      delivered: true,
      observed_at: observedAt,
    });
  });

  test("does not treat an accepted email as delivered", async () => {
    const { environment } = makeEnvironment();
    await handleAlert(
      new Request("https://operations.normal.fast/v1/alerts", {
        method: "POST",
        body: JSON.stringify({
          alert: "alert-delivery-canary",
          observedAt,
          severity: "ticket",
          status: "firing",
        }),
      }),
      environment,
    );
    const response = await handleReceipt(
      new Request("https://operations.normal.fast/v1/receipts", {
        method: "POST",
        body: JSON.stringify({
          alert: "alert-delivery-canary",
          observed_at: observedAt,
        }),
      }),
      environment,
      async () =>
        Response.json({
          data: {
            viewer: { zones: [{ emailSendingAdaptive: [] }] },
          },
        }),
    );
    await expect(response.json()).resolves.toEqual({
      delivered: false,
      observed_at: observedAt,
    });
  });
});
