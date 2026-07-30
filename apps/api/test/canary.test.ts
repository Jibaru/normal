import { describe, expect, test } from "vitest";
import { createCanaryHandler } from "../src/canary";
import { makeTestRoot } from "./support/root";

describe("API Worker canary", () => {
  test("responds at the public HTTP boundary without sensitive fields", async () => {
    const root = makeTestRoot();
    const response = await createCanaryHandler(root.layer)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as unknown).toEqual({
      service: "api",
      status: "ok",
    });
    expect(root.events).toEqual([
      {
        event: "http.request.completed",
        method: "GET",
        route: "health",
        service: "api",
        status: 200,
      },
    ]);
  });

  test("returns a non-cacheable not-found response for other paths", async () => {
    const root = makeTestRoot();
    const response = await createCanaryHandler(root.layer)(
      new Request("https://api.example.test/private?token=do-not-log"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(root.events[0]).toEqual({
      event: "http.request.completed",
      method: "GET",
      route: "unmatched",
      service: "api",
      status: 404,
    });
    expect(JSON.stringify(root.events)).not.toContain("do-not-log");
  });

  test("checks the production database boundary before reporting readiness", async () => {
    const root = makeTestRoot();
    const response = await createCanaryHandler(root.layer)(
      new Request("https://api.example.test/ready"),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      service: "api",
      status: "ready",
    });
    expect(root.databaseChecks).toBe(1);
  });
});
