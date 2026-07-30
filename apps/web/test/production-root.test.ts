import { describe, expect, test } from "bun:test";
import { createProductionHealthRoute } from "../src/effect/production";

describe("web production root", () => {
  test("fails closed when deployment configuration is absent", async () => {
    const response = await createProductionHealthRoute({})();

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      service: "web",
      status: "unavailable",
    });
  });

  test("fails closed when the browser API origin is not HTTPS", async () => {
    const response = await createProductionHealthRoute({
      DEPLOYMENT_ENVIRONMENT: "production",
      NEXT_PUBLIC_API_ORIGIN: "http://api.example.com",
    })();

    expect(response.status).toBe(503);
  });

  test("accepts a direct HTTPS API Worker origin", async () => {
    const response = await createProductionHealthRoute({
      DEPLOYMENT_ENVIRONMENT: "production",
      NEXT_PUBLIC_API_ORIGIN: "https://api.example.com",
    })();

    expect(response.status).toBe(200);
  });
});
