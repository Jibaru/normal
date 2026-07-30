import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const originalEnvironment = process.env.DEPLOYMENT_ENVIRONMENT;

beforeAll(() => {
  process.env.DEPLOYMENT_ENVIRONMENT = "production";
});

afterAll(() => {
  if (originalEnvironment === undefined) {
    delete process.env.DEPLOYMENT_ENVIRONMENT;
    return;
  }
  process.env.DEPLOYMENT_ENVIRONMENT = originalEnvironment;
});

describe("web route entrypoint", () => {
  test("serves the health canary from the Next.js route module", async () => {
    const { GET } = await import("../src/app/health/route");
    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      service: "web",
      status: "ok",
    });
  });
});
