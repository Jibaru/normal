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
});
