import { describe, expect, test } from "bun:test";
import { createHealthRoute } from "../src/effect/canary";
import { makeTestRoot } from "./support/root";

describe("web health route", () => {
  test("returns the public canary contract through a Response boundary", async () => {
    const root = makeTestRoot();
    const response = await createHealthRoute(root.layer)();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as unknown).toEqual({
      service: "web",
      status: "ok",
    });
    expect(root.events).toEqual([
      {
        event: "http.request.completed",
        method: "GET",
        route: "health",
        service: "web",
        status: 200,
      },
    ]);
  });
});
