import { describe, expect, test } from "vitest";
import { createCanaryHandler } from "../src/canary";
import { makeTestRoot } from "./support/root";

describe("provider-control Worker canary", () => {
  test("responds at the service-binding HTTP boundary", async () => {
    const root = makeTestRoot();
    const response = await createCanaryHandler(root.layer)(
      new Request("https://provider-control.internal/health"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as unknown).toEqual({
      service: "provider-control",
      status: "ok",
    });
    expect(root.events).toHaveLength(1);
  });
});
