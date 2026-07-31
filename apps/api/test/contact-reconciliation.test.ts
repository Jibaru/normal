import type { ContactReconciliationCandidate } from "@whatsapp-mcp/db/directory";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  ContactReconciliationClock,
  ContactReconciliationIdentifiers,
  ContactReconciliationPersistence,
  reconcileContacts,
} from "../src/contact-reconciliation";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const candidate: ContactReconciliationCandidate = {
  accountKey: {
    ciphertext: "AQI=",
    keyVersion: 1,
    kmsKeyId: "kms-content-root",
    personalAccountId: "10000000-0000-4000-8000-000000000037",
    version: 1,
  },
  authority: {
    ciphertext: "AQI=",
    keyVersion: 1,
    nonce: "AQIDBAUGBwgJCgsM",
    version: 1,
  },
  claimId: "50000000-0000-4000-8000-000000000037",
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: "AQI=",
    connectionId: "20000000-0000-4000-8000-000000000037",
    keyVersion: 1,
    nonce: "AQIDBAUGBwgJCgsM",
    personalAccountId: "10000000-0000-4000-8000-000000000037",
    version: 1,
  },
  identityKey: {
    ciphertext: "AQI=",
    keyVersion: 1,
    nonce: "AQIDBAUGBwgJCgsM",
    version: 1,
  },
  personalAccountId: "10000000-0000-4000-8000-000000000037",
  whatsappConnectionId: "20000000-0000-4000-8000-000000000037",
};

const makeHarness = () => {
  const failures: unknown[] = [];
  const finishes: unknown[] = [];
  const telemetry: SafeTelemetryEvent[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(ContactReconciliationClock, {
      now: Effect.succeed("2026-07-31T12:05:01.000Z"),
    }),
    Layer.succeed(ContactReconciliationIdentifiers, {
      nextContactId: Effect.succeed("ctc_123456789012345678901"),
    }),
    Layer.succeed(ContactReconciliationPersistence, {
      fail: (input) =>
        Effect.sync(() => {
          failures.push(input);
        }),
      finish: (input) =>
        Effect.sync(() => {
          finishes.push(input);
        }),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("not used"),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ context }) =>
        Effect.succeed(
          context.fieldOrObjectPurpose === "provider-session-authority"
            ? encoder.encode("session-directory-authority")
            : new Uint8Array(32).fill(37),
        ),
      encrypt: ({ plaintext }) =>
        Effect.succeed({
          ciphertext: btoa(
            String.fromCharCode(...plaintext, ...new Uint8Array(17).fill(9)),
          ),
          keyVersion: 1,
          nonce: btoa(String.fromCharCode(...new Uint8Array(12).fill(8))),
          version: 1,
        }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          telemetry.push(event);
        }),
    }),
  );
  return { failures, finishes, layer, telemetry };
};

describe("contact reconciliation", () => {
  test("protects a complete provider observation before atomically finishing", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            items: [{ jid: "15550199@s.whatsapp.net", name: "Ada" }],
            pagination: { limit: 100, page: 1, total: 1, totalPages: 1 },
          },
          success: true,
        }),
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const harness = makeHarness();

    await Effect.runPromise(
      reconcileContacts(candidate).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.failures).toEqual([]);
    expect(harness.finishes).toEqual([
      expect.objectContaining({
        contacts: [
          expect.objectContaining({
            displayNameCiphertext: expect.any(Object),
            phoneCiphertext: expect.any(Object),
            providerIdentityCiphertext: expect.any(Object),
            publicId: "ctc_123456789012345678901",
          }),
        ],
        partial: false,
        stale: false,
      }),
    ]);
    expect(JSON.stringify(harness.finishes)).not.toContain(
      "15550199@s.whatsapp.net",
    );
    expect(harness.telemetry).toContainEqual({
      attempts: 1,
      durationMs: expect.any(Number),
      event: "directory.provider_read.completed",
      operation: "safe-read",
      outcome: "complete",
      responseBytes: expect.any(Number),
      service: "api",
    });
    expect(harness.telemetry).toContainEqual({
      contactCount: 1,
      event: "directory.contacts.reconciliation.completed",
      outcome: "complete",
      service: "api",
    });
  });

  test("marks the projection partial and stale when the provider read fails", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 401 })) as unknown as typeof fetch;
    const harness = makeHarness();

    await Effect.runPromise(
      reconcileContacts(candidate).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.finishes).toEqual([]);
    expect(harness.failures).toEqual([
      {
        claimId: candidate.claimId,
        failedAt: "2026-07-31T12:05:01.000Z",
        whatsappConnectionId: candidate.whatsappConnectionId,
      },
    ]);
    expect(harness.telemetry).toContainEqual({
      attempts: 1,
      durationMs: expect.any(Number),
      event: "directory.provider_read.completed",
      operation: "safe-read",
      outcome: "failed",
      responseBytes: 0,
      service: "api",
    });
    expect(harness.telemetry).toContainEqual({
      contactCount: 0,
      event: "directory.contacts.reconciliation.completed",
      outcome: "failed",
      service: "api",
    });
  });
});
