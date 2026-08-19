import { describe, expect, test } from "vitest";
import type { RecoveryVerifierEnvironment } from "../src/environment";
import { handleRequest } from "../src/index";
import { verifyIsolatedApiKeyHmacRotation } from "../src/verify";

const token = "a".repeat(32);
const call = (
  request: Request,
  env: Partial<RecoveryVerifierEnvironment> = {},
) =>
  handleRequest(
    request as never,
    { RECOVERY_EVIDENCE_TOKEN: token, ...env } as RecoveryVerifierEnvironment,
  );

describe("recovery verifier boundary", () => {
  test("exercises the production API Key digest path with an isolated replacement", async () => {
    await expect(verifyIsolatedApiKeyHmacRotation()).resolves.toEqual({
      predecessorRejected: true,
      rotated: true,
    });
  });

  test("rejects missing credentials with a constant response", async () => {
    const response = await call(
      new Request("https://verifier.example.test/verify", { method: "POST" }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: "failed" });
  });

  test("rejects plaintext and non-contract routes before verification", async () => {
    for (const url of [
      "http://verifier.example.test/verify",
      "https://verifier.example.test/other",
    ]) {
      const response = await call(
        new Request(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ status: "failed" });
    }
  });

  test("rejects extended metadata without exposing parser details", async () => {
    const response = await call(
      new Request("https://verifier.example.test/verify", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tenant_id: "forbidden" }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "failed" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
