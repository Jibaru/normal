import { exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

describe("API Worker entrypoint", () => {
  test("serves the health canary through the configured Worker export", async () => {
    const response = await exports.default.fetch(
      "https://api.example.test/health",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "api", status: "ok" });
  });
});
