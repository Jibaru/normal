import { describe, expect, test } from "bun:test";
import { decodeHealthResponse } from "../src/health";

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
