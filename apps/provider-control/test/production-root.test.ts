import { describe, expect, test } from "vitest";
import { createProductionHandler } from "../src/production";

describe("provider-control production root", () => {
  test("accepts valid production configuration", async () => {
    const response = await createProductionHandler({
      DEPLOYMENT_ENVIRONMENT: "production",
    })(new Request("https://provider-control.internal/health"));

    expect(response.status).toBe(200);
  });

  test("fails closed when deployment configuration is absent", async () => {
    const response = await createProductionHandler({})(
      new Request("https://provider-control.internal/health"),
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      service: "provider-control",
      status: "unavailable",
    });
  });
});
