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

  const invalidApiOrigins = [
    "http://api.example.com",
    "https://user:password@api.example.com",
    "https://api.example.com/v1",
    "https://api.example.com?environment=production",
    "https://api.example.com#production",
  ] as const;

  for (const invalidApiOrigin of invalidApiOrigins) {
    test(`fails closed when the browser API origin is ${invalidApiOrigin}`, async () => {
      const response = await createProductionHealthRoute({
        DEPLOYMENT_ENVIRONMENT: "production",
        NEXT_PUBLIC_API_ORIGIN: invalidApiOrigin,
      })();

      expect(response.status).toBe(503);
    });
  }

  test("accepts a direct HTTPS API Worker origin", async () => {
    const response = await createProductionHealthRoute({
      DEPLOYMENT_ENVIRONMENT: "production",
      NEXT_PUBLIC_API_ORIGIN: "https://api.example.com",
    })();

    expect(response.status).toBe(200);
  });
});
