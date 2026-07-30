import { exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

describe("provider-control Worker entrypoint", () => {
  test("serves the health canary through its service-binding entrypoint", async () => {
    const response = await exports.default.fetch(
      "https://provider-control.internal/health",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "provider-control",
      status: "ok",
    });
  });
});
