import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const originalEnvironment = process.env.DEPLOYMENT_ENVIRONMENT;
const originalApiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;

beforeAll(() => {
  process.env.DEPLOYMENT_ENVIRONMENT = "production";
  process.env.NEXT_PUBLIC_API_ORIGIN = "https://api.example.com";
});

afterAll(() => {
  if (originalEnvironment === undefined) {
    delete process.env.DEPLOYMENT_ENVIRONMENT;
  } else {
    process.env.DEPLOYMENT_ENVIRONMENT = originalEnvironment;
  }

  if (originalApiOrigin === undefined) {
    delete process.env.NEXT_PUBLIC_API_ORIGIN;
  } else {
    process.env.NEXT_PUBLIC_API_ORIGIN = originalApiOrigin;
  }
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
