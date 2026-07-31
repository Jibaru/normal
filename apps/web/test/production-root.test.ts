import { describe, expect, test } from "bun:test";
import {
  isDeploymentEnvironment,
  parseApiOrigin,
} from "../src/effect/api-origin";
import { createProductionHealthRoute } from "../src/effect/production";

describe("web production root", () => {
  const validEnvironment = {
    DEPLOYMENT_ENVIRONMENT: "production",
    NEXT_PUBLIC_API_ORIGIN: "https://api.example.com",
    NEXT_PUBLIC_CLERK_JWT_TEMPLATE: "whatsapp-api",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA",
  } as const;

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
        ...validEnvironment,
        NEXT_PUBLIC_API_ORIGIN: invalidApiOrigin,
      })();

      expect(response.status).toBe(503);
    });
  }

  test("accepts a direct HTTPS API Worker origin", async () => {
    const response = await createProductionHealthRoute(validEnvironment)();

    expect(response.status).toBe(200);
  });

  test.each([
    "NEXT_PUBLIC_CLERK_JWT_TEMPLATE",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  ] as const)("fails closed when %s is absent", async (name) => {
    const { [name]: _missing, ...environment } = validEnvironment;
    const response = await createProductionHealthRoute(environment)();

    expect(response.status).toBe(503);
  });

  test("rejects an unsafe Clerk JWT template name", async () => {
    const response = await createProductionHealthRoute({
      ...validEnvironment,
      NEXT_PUBLIC_CLERK_JWT_TEMPLATE: "template with spaces",
    })();

    expect(response.status).toBe(503);
  });

  test("shares validated browser configuration with the product UI", () => {
    expect(parseApiOrigin("https://api.example.com")?.origin).toBe(
      "https://api.example.com",
    );
    expect(parseApiOrigin("https://api.example.com/path")).toBeNull();
    expect(isDeploymentEnvironment("production")).toBe(true);
    expect(isDeploymentEnvironment("test")).toBe(false);
  });
});
