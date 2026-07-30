import { describe, expect, test } from "bun:test";
import { decodeHealthResponse, decodeReadinessResponse } from "../src/health";

describe("HealthResponse", () => {
  test("accepts a non-sensitive canary response", () => {
    expect(
      decodeHealthResponse({
        service: "api",
        status: "ok",
      }),
    ).toEqual({ service: "api", status: "ok" });
  });

  test("rejects fields outside the public canary contract", () => {
    expect(() =>
      decodeHealthResponse({
        service: "api",
        status: "ok",
        databaseUrl: "postgres://secret",
      }),
    ).toThrow();
  });
});

describe("ReadinessResponse", () => {
  test("accepts the non-sensitive API database readiness response", () => {
    expect(
      decodeReadinessResponse({
        service: "api",
        status: "ready",
      }),
    ).toEqual({ service: "api", status: "ready" });
  });

  test("rejects dependency details", () => {
    expect(() =>
      decodeReadinessResponse({
        service: "api",
        status: "ready",
        schemaVersion: 1,
      }),
    ).toThrow();
  });
});
