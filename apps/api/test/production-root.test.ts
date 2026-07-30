import { describe, expect, test } from "vitest";
import { createProductionHandler } from "../src/production";

describe("API production root", () => {
  test("accepts valid production configuration", async () => {
    const response = await createProductionHandler({
      DEPLOYMENT_ENVIRONMENT: "production",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(200);
  });

  test("fails closed when deployment configuration is invalid", async () => {
    const response = await createProductionHandler({
      DEPLOYMENT_ENVIRONMENT: "test",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      service: "api",
      status: "unavailable",
    });
  });
});
