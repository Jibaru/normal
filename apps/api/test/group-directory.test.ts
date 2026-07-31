import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import {
  GroupDirectoryIdentifiers,
  GroupDirectoryPersistence,
  GroupDirectoryProvider,
  reconcileGroupDirectory,
} from "../src/group-directory";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const candidate = {
  accountKey: {
    ciphertext: "AQID",
    keyVersion: 1,
    kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
    personalAccountId: "10000000-0000-4000-8000-000000000039",
    version: 1 as const,
  },
  claimId: "50000000-0000-4000-8000-000000000039",
  connectionId: "20000000-0000-4000-8000-000000000039",
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: "AQID",
    connectionId: "20000000-0000-4000-8000-000000000039",
    keyVersion: 1,
    nonce: "AQIDBAUGBwgJCgsM",
    personalAccountId: "10000000-0000-4000-8000-000000000039",
    version: 1 as const,
  },
  identityKey: {
    ciphertext: "AQID",
    keyVersion: 1,
    nonce: "AQIDBAUGBwgJCgsM",
    version: 1 as const,
  },
  personalAccountId: "10000000-0000-4000-8000-000000000039",
  providerAuthority: {
    ciphertext: "AQID",
    keyVersion: 1,
    nonce: "AQIDBAUGBwgJCgsM",
    version: 1 as const,
  },
};

const makeHarness = (providerFails = false) => {
  const calls: string[] = [];
  const telemetry: SafeTelemetryEvent[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("not used"),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ context }) =>
        Effect.succeed(
          context.fieldOrObjectPurpose === "webhook-identity-key"
            ? new Uint8Array(32).fill(39)
            : new TextEncoder().encode(
                JSON.stringify({ sessionCredential: "session-api-key" }),
              ),
        ),
      encrypt: ({ plaintext }) =>
        Effect.succeed({
          ciphertext: btoa(
            String.fromCharCode(...plaintext, ...new Uint8Array(16)),
          ),
          keyVersion: 1,
          nonce: "AQIDBAUGBwgJCgsM",
          version: 1,
        }),
    }),
    Layer.succeed(GroupDirectoryIdentifiers, {
      nextGroup: Effect.succeed({
        id: "60000000-0000-4000-8000-000000000039",
        publicId: "grp_123456789012345678939",
      }),
    }),
    Layer.succeed(GroupDirectoryProvider, {
      read: ({ authority, identityKey }) => {
        calls.push(`provider:${Redacted.value(authority)}`);
        expect(Redacted.value(identityKey)).toEqual(
          new Uint8Array(32).fill(39),
        );
        return providerFails
          ? Effect.fail({
              _tag: "ProviderNeutralFailure" as const,
              code: "unavailable" as const,
              operation: "safe-read" as const,
              retryAfterMs: null,
              retryDecision: "retry_within_safe_read_budget" as const,
            })
          : Effect.succeed({
              completeness: "complete" as const,
              entries: [
                {
                  displayName: "Family",
                  identity: `wi1_${"A".repeat(43)}` as never,
                  joined: true,
                  recipient: "loc_v1_g_sealed-provider-identity" as never,
                },
              ],
              observedAt: "2026-07-31T12:00:00.000Z" as never,
              stale: false,
            });
      },
    }),
    Layer.succeed(GroupDirectoryPersistence, {
      fail: () =>
        Effect.sync(() => {
          calls.push("fail");
          return true;
        }),
      reconcile: (input) =>
        Effect.promise(async () => {
          calls.push("reconcile");
          expect(input).toMatchObject({
            claimId: candidate.claimId,
            completeness: "complete",
            entries: [
              {
                displayName: "Family",
                joined: true,
                locator: `wi1_${"A".repeat(43)}`,
                providerIdentity: "loc_v1_g_sealed-provider-identity",
              },
            ],
            stale: false,
          });
          const firstEntry = input.entries[0];
          if (firstEntry === undefined) throw new Error("missing group entry");
          const protectedFields = await input.protect(
            firstEntry,
            "60000000-0000-4000-8000-000000000039",
          );
          expect(
            protectedFields.displayName?.ciphertext.byteLength,
          ).toBeGreaterThan(16);
          return { applied: 1, unjoined: 0 };
        }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          telemetry.push(event);
        }),
    }),
  );
  return { calls, layer, telemetry };
};

describe("group Directory reconciliation", () => {
  test("uses per-connection authority and atomically protects a complete observation", async () => {
    const harness = makeHarness();
    await expect(
      Effect.runPromise(
        reconcileGroupDirectory(candidate, "2026-07-31T12:01:00.000Z").pipe(
          Effect.provide(harness.layer),
        ),
      ),
    ).resolves.toEqual({ applied: 1, unjoined: 0 });
    expect(harness.calls).toEqual([
      'provider:{"sessionCredential":"session-api-key"}',
      "reconcile",
    ]);
    expect(harness.telemetry).toContainEqual({
      appliedCount: 1,
      event: "group_directory.reconciliation.completed",
      outcome: "success",
      service: "api",
      unjoinedCount: 0,
    });
  });

  test("marks freshness partial and stale when the provider read fails", async () => {
    const harness = makeHarness(true);
    await expect(
      Effect.runPromise(
        reconcileGroupDirectory(candidate, "2026-07-31T12:01:00.000Z").pipe(
          Effect.provide(harness.layer),
        ),
      ),
    ).resolves.toBeNull();
    expect(harness.calls).toEqual([
      'provider:{"sessionCredential":"session-api-key"}',
      "fail",
    ]);
  });
});
