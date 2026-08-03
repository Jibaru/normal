import type {
  AtomicSendRepository,
  SendEncryptionMaterial,
  SendProviderMaterial,
} from "@whatsapp-mcp/db/send";
import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EnvelopeEncryption } from "../src/encryption/envelope";
import {
  importSendFingerprintKey,
  makeAtomicSendTextMessageService,
} from "../src/send-text-message";

const material: SendEncryptionMaterial = {
  accountKey: {
    ciphertext: new Uint8Array([1]),
    keyVersion: 1,
    kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/test",
    personalAccountId: "10000000-0000-4000-8000-000000000047",
  },
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: new Uint8Array([2]),
    connectionId: "20000000-0000-4000-8000-000000000047",
    keyVersion: 1,
    nonce: new Uint8Array(12),
    personalAccountId: "10000000-0000-4000-8000-000000000047",
  },
};

const protectedValue = (value: string) => ({
  ciphertext: new TextEncoder().encode(value),
  keyVersion: 1,
  nonce: new Uint8Array(12),
});

const input = {
  authorizationId: "40000000-0000-4000-8000-000000000047",
  clientId: "approved-client",
  connectionId: "con_123456789012345678947",
  idempotencyKey: "123456789012345678947",
  oauthSubject: "A".repeat(43),
  recipientId: "ctc_123456789012345678947",
  text: " exact\ne\u0301 ",
} as const;

describe("atomic send workflow", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("commits encrypted state before exactly one provider attempt", async () => {
    const order: string[] = [];
    const provider: SendProviderMaterial = {
      ...material,
      authority: protectedValue("session-authority"),
      identityKey: protectedValue("x".repeat(32)),
      recipient: protectedValue("15551234567@s.whatsapp.net"),
      recipientRecordId: `di1_${"B".repeat(43)}`,
      recipientType: "contact",
    };
    const repository: AtomicSendRepository = {
      commit: async (_request, encrypt) => {
        order.push("transaction-open");
        await encrypt(material);
        order.push("commit");
        return {
          outcome: "created",
          provider,
          receipt: {
            createdAt: new Date("2026-08-03T12:00:00.000Z"),
            publicId: "snd_123456789012345678947",
            status: "processing",
            statusChangedAt: new Date("2026-08-03T12:00:00.000Z"),
          },
        };
      },
      recordProviderOutcome: async ({ status }) => {
        order.push("record-outcome");
        return {
          createdAt: new Date("2026-08-03T12:00:00.000Z"),
          publicId: "snd_123456789012345678947",
          status,
          statusChangedAt: new Date("2026-08-03T12:00:01.000Z"),
        };
      },
    };
    const encryption: EnvelopeEncryption = {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      encrypt: () => {
        order.push("encrypt-pending");
        return Effect.succeed({
          ciphertext: btoa("encrypted-pending-content"),
          keyVersion: 1,
          nonce: btoa(String.fromCharCode(...new Uint8Array(12))),
          version: 1,
        });
      },
      decrypt: ({ context }) => {
        const value =
          context.fieldOrObjectPurpose === "provider-session-authority"
            ? "session-authority"
            : context.fieldOrObjectPurpose === "webhook-identity-key"
              ? "x".repeat(32)
              : "15551234567@s.whatsapp.net";
        return Effect.succeed(new TextEncoder().encode(value));
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, request: RequestInit) => {
        order.push("provider-attempt");
        expect(JSON.parse(String(request.body))).toEqual({
          to: "15551234567@s.whatsapp.net",
          text: input.text,
        });
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              jid: "15551234567@s.whatsapp.net",
              msgId: 47,
              status: "in_progress",
            },
          }),
          { status: 200 },
        );
      }),
    );
    const fingerprintKey = await importSendFingerprintKey("47".repeat(32));
    const service = makeAtomicSendTextMessageService({
      encryption,
      fingerprintKey,
      hourRequestLimit: 600,
      minuteRequestLimit: 60,
      nextAuditLogId: () => "50000000-0000-4000-8000-000000000047",
      nextSend: () => ({
        id: "60000000-0000-4000-8000-000000000047",
        publicId: "snd_123456789012345678947",
      }),
      now: (() => {
        let offset = 0;
        return () => new Date(1_775_390_400_000 + offset++ * 1_000);
      })(),
      repository,
      sendDailyLimit: 200,
      sendPerMinuteLimit: 10,
      telemetry: () => undefined,
    });

    await expect(Effect.runPromise(service.send(input))).resolves.toMatchObject(
      {
        outcome: "receipt",
        receipt: { status: "accepted", idempotent_replay: false },
      },
    );
    expect(order).toEqual([
      "transaction-open",
      "encrypt-pending",
      "commit",
      "provider-attempt",
      "record-outcome",
    ]);
  });

  test("returns an exact replay without encryption or provider work", async () => {
    const repository: AtomicSendRepository = {
      commit: async (_request, encrypt) => {
        expect(encrypt).toBeTypeOf("function");
        return {
          outcome: "replay",
          receipt: {
            createdAt: new Date("2026-08-03T12:00:00.000Z"),
            publicId: "snd_123456789012345678947",
            status: "unknown",
            statusChangedAt: new Date("2026-08-03T12:00:30.000Z"),
          },
        };
      },
      recordProviderOutcome: vi.fn(),
    };
    const encryption: EnvelopeEncryption = {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      decrypt: () => Effect.die("replay must not decrypt provider material"),
      encrypt: () => Effect.die("replay must not encrypt pending content"),
    };
    const providerAttempt = vi.fn();
    vi.stubGlobal("fetch", providerAttempt);
    const service = makeAtomicSendTextMessageService({
      encryption,
      fingerprintKey: await importSendFingerprintKey("47".repeat(32)),
      hourRequestLimit: 600,
      minuteRequestLimit: 60,
      nextAuditLogId: () => "50000000-0000-4000-8000-000000000048",
      nextSend: () => ({
        id: "60000000-0000-4000-8000-000000000048",
        publicId: "snd_123456789012345678948",
      }),
      now: () => new Date("2026-08-03T12:01:00.000Z"),
      repository,
      sendDailyLimit: 200,
      sendPerMinuteLimit: 10,
      telemetry: () => undefined,
    });

    await expect(Effect.runPromise(service.send(input))).resolves.toEqual({
      outcome: "receipt",
      receipt: {
        created_at: "2026-08-03T12:00:00.000Z",
        idempotent_replay: true,
        send_id: "snd_123456789012345678947",
        status: "unknown",
        status_changed_at: "2026-08-03T12:00:30.000Z",
      },
    });
    expect(providerAttempt).not.toHaveBeenCalled();
    expect(repository.recordProviderOutcome).not.toHaveBeenCalled();
  });

  test("accepts an uppercase hexadecimal fingerprint key", async () => {
    await expect(
      importSendFingerprintKey("AB".repeat(32)),
    ).resolves.toBeInstanceOf(CryptoKey);
  });
});
