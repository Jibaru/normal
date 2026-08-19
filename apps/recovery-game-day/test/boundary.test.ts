import { describe, expect, test, vi } from "vitest";
import {
  executeGameDay,
  handleGameDayReplay,
  type RecoveryGameDayEnvironment,
  type RecoveryKvNamespace,
  type RecoveryMessage,
  verifyGameDay,
} from "../src/index";

const operation = `recovery_operation_${"a".repeat(32)}`;
const identity = {
  version: 1,
  operation,
  recoveryBranchId: "br-recovery-game-day",
  verificationNonce: "b".repeat(64),
  replayDigest: "c".repeat(64),
} as const;

const quarterlyReceipt = async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, () => 0xdd),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      JSON.stringify([
        identity.version,
        identity.operation,
        identity.recoveryBranchId,
        identity.verificationNonce,
        identity.replayDigest,
      ]),
    ),
  );
  return `quarterly_receipt_${[...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

const environment = (overrides: Partial<RecoveryGameDayEnvironment> = {}) =>
  ({
    DEPLOYMENT_ENVIRONMENT: "production",
    RECOVERY_KV: { get: vi.fn() },
    QUARTERLY_RECEIPT_SECRET: "d".repeat(64),
    ...overrides,
  }) as unknown as RecoveryGameDayEnvironment;

describe("quarterly recovery executor boundary", () => {
  test("rejects malformed requests before consulting state", async () => {
    const get = vi.fn();
    const env = environment({
      RECOVERY_KV: { get } as unknown as RecoveryKvNamespace,
    });
    await expect(
      executeGameDay(env, { ...identity, tenant_id: "forbidden" }),
    ).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  test("refuses production operations in another environment", async () => {
    await expect(
      executeGameDay(
        environment({
          DEPLOYMENT_ENVIRONMENT: "preview",
        }),
        identity,
      ),
    ).rejects.toThrow("unavailable outside production");
  });

  test("rejects an unbound verification receipt before state access", async () => {
    const get = vi.fn();
    const env = environment({
      RECOVERY_KV: { get } as unknown as RecoveryKvNamespace,
    });
    await expect(
      verifyGameDay(env, {
        ...identity,
        receipt: `quarterly_receipt_${"e".repeat(64)}`,
      }),
    ).rejects.toThrow("receipt is invalid");
    expect(get).not.toHaveBeenCalled();
  });

  test("rejects malformed Queue fixtures before resource access", async () => {
    const get = vi.fn();
    const env = environment({
      RECOVERY_KV: { get } as unknown as RecoveryKvNamespace,
    });
    await expect(
      handleGameDayReplay(env, {
        body: { operation },
      } as RecoveryMessage),
    ).rejects.toThrow("message is invalid");
    expect(get).not.toHaveBeenCalled();
  });

  test("resubmits a receipt-bound replay when persisted state is incomplete", async () => {
    const send = vi.fn(async () => undefined);
    const receipt = await quarterlyReceipt();
    const get = vi.fn().mockResolvedValueOnce("present").mockResolvedValueOnce({
      version: 1,
      operation,
      receipt,
      alertObservedAt: "2026-08-18T12:00:00.000Z",
      oauthKvReconstructed: true,
      kmsAccess: true,
      mediaLossFailedClosed: false,
      queueComplete: false,
      r2Access: true,
    });
    const env = environment({
      RECOVERY_KV: { get } as unknown as RecoveryKvNamespace,
      RECOVERY_REPLAY_QUEUE: { send },
    });
    const result = await executeGameDay(env, identity);

    expect(send).toHaveBeenCalledWith({
      version: 1,
      operation,
      receipt: result.receipt,
    });
  });
});
