import { describe, expect, test } from "vitest";
import type { RecoveryVerifierEnvironment } from "../src/environment";
import { handleRequest } from "../src/index";
import {
  stableRecoveryProbeId,
  verifyIsolatedApiKeyHmacRotation,
} from "../src/verify";

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

  test("derives stable distinct probe identities for workflow retries", async () => {
    const input = {
      operation: "recovery_operation_123",
      recovery_branch_id: "br-recovery-123",
    } as const;
    const first = await stableRecoveryProbeId(input, 1);
    expect(await stableRecoveryProbeId(input, 1)).toBe(first);
    expect(await stableRecoveryProbeId(input, 2)).not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
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
