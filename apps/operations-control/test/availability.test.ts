import { describe, expect, test, vi } from "vitest";
import { AvailabilityError, handleAvailability } from "../src/availability";
import type { OperationsControlEnvironment } from "../src/environment";

const asOf = "2026-08-19T12:00:00.000Z";
const body = {
  version: 1,
  window: "30d",
  as_of: asOf,
  operation: `recovery_operation_${"a".repeat(32)}`,
  recovery_branch_id: "br-availability-test",
  source_point_at: "2026-08-19T11:55:00.000Z",
  verification_nonce: "b".repeat(64),
  replay_digest: "c".repeat(64),
};

const page = {
  props: {
    currentStatus: {
      status: "up",
      last_checked: new Date().toISOString().replace("Z", "000Z"),
      services: { whatsapp_servers: "up" },
    },
    uptime: { "30d": 99.8 },
    scheduledOutages: [
      {
        affected_services: ["WhatsApp Server"],
        starts_at: "2026-08-01T00:00:00.000000Z",
        ends_at: "2026-08-01T01:00:00.000000Z",
        status: "completed",
      },
    ],
  },
};

const environment = {
  API_ORIGIN: "https://api.normal.fast",
  CLOUDFLARE_ANALYTICS_TOKEN: "a".repeat(64),
  CLOUDFLARE_ZONE_ID: "b".repeat(32),
} as OperationsControlEnvironment;

describe("production availability authority", () => {
  test("binds live first-party, dependency, and sampled-key evidence to the exact request", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("cloudflare.com")) {
        return Response.json({
          data: {
            viewer: {
              zones: [
                {
                  httpRequestsAdaptiveGroups: [
                    { count: 20_000, ratio: { status5xx: 0.002 } },
                  ],
                },
              ],
            },
          },
        });
      }
      return new Response(
        `<div data-page="${JSON.stringify(page).replaceAll('"', "&quot;")}"></div>`,
        { headers: { "content-type": "text/html" } },
      );
    });
    const response = await handleAvailability(
      new Request("https://operations.normal.fast/v1/availability", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      environment,
      { fetch: fetcher, keys: async () => true },
    );
    await expect(response.json()).resolves.toEqual({
      ...body,
      window_started_at: "2026-07-20T12:00:00.000Z",
      window_completed_at: asOf,
      first_party_percent: 99.8,
      wasender_percent: 99.8,
      whatsapp_percent: 99.8,
      sampled_keys_usable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("rejects extended requests before external access", async () => {
    const fetcher = vi.fn();
    await expect(
      handleAvailability(
        new Request("https://operations.normal.fast/v1/availability", {
          method: "POST",
          body: JSON.stringify({ ...body, tenant_id: "forbidden" }),
        }),
        environment,
        { fetch: fetcher, keys: async () => true },
      ),
    ).rejects.toThrow("invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("reports only the failed availability authority", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("cloudflare.com"))
        throw new Error("sensitive upstream detail");
      return new Response(
        `<div data-page="${JSON.stringify(page).replaceAll('"', "&quot;")}"></div>`,
      );
    });
    await expect(
      handleAvailability(
        new Request("https://operations.normal.fast/v1/availability", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        environment,
        { fetch: fetcher, keys: async () => true },
      ),
    ).rejects.toEqual(new AvailabilityError("first_party"));
  });
});
