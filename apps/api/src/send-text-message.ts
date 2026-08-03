import type { SendTextMessageOutput } from "@whatsapp-mcp/contracts/mcp-schema";
import type {
  AtomicSendRepository,
  SendEncryptionMaterial,
} from "@whatsapp-mcp/db/send";
import {
  makeWasenderTextSending,
  type RecipientLocator,
  type WasenderIdentityProtectionKey,
  type WasenderRecipientIdentity,
} from "@whatsapp-mcp/wasender/session";
import { Effect, Redacted } from "effect";
import type {
  EnvelopeEncryption,
  VersionedCiphertext,
} from "./encryption/envelope";
import type { SendTextMessageResult, SendTextMessageService } from "./mcp";

const encoder = new TextEncoder();
const base64 = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const envelope = (value: {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
}): VersionedCiphertext => ({
  ciphertext: base64(value.ciphertext),
  keyVersion: value.keyVersion,
  nonce: base64(value.nonce),
  version: 1,
});
const keys = (material: SendEncryptionMaterial) => ({
  accountKey: {
    ciphertext: base64(material.accountKey.ciphertext),
    keyVersion: material.accountKey.keyVersion,
    kmsKeyId: material.accountKey.kmsKeyId,
    personalAccountId: material.accountKey.personalAccountId,
    version: 1 as const,
  },
  connectionKey: {
    accountKeyVersion: material.connectionKey.accountKeyVersion,
    ciphertext: base64(material.connectionKey.ciphertext),
    connectionId: material.connectionKey.connectionId,
    keyVersion: material.connectionKey.keyVersion,
    nonce: base64(material.connectionKey.nonce),
    personalAccountId: material.connectionKey.personalAccountId,
    version: 1 as const,
  },
});
const base64Url = (value: Uint8Array): string =>
  base64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const fingerprint = async (
  key: CryptoKey,
  input: {
    authorizationId: string;
    connectionId: string;
    recipientId: string;
    text: string;
  },
): Promise<string> => {
  const parts = [
    input.authorizationId,
    input.connectionId,
    input.recipientId,
    input.text,
  ].map((value) => encoder.encode(value));
  const size = parts.reduce((sum, value) => sum + 4 + value.byteLength, 0);
  const framed = new Uint8Array(size);
  const view = new DataView(framed.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.byteLength);
    offset += 4;
    framed.set(part, offset);
    offset += part.byteLength;
  }
  const signed = await crypto.subtle.sign("HMAC", key, framed);
  return `sf1_${base64Url(new Uint8Array(signed))}`;
};
const receipt = (
  value: {
    createdAt: Date;
    publicId: string;
    status: SendTextMessageOutput["status"];
    statusChangedAt: Date;
  },
  replay: boolean,
): SendTextMessageOutput => ({
  send_id: value.publicId as SendTextMessageOutput["send_id"],
  status: value.status,
  created_at:
    value.createdAt.toISOString() as SendTextMessageOutput["created_at"],
  status_changed_at:
    value.statusChangedAt.toISOString() as SendTextMessageOutput["status_changed_at"],
  idempotent_replay: replay,
});

export interface AtomicSendServiceOptions {
  readonly encryption: EnvelopeEncryption;
  readonly fingerprintKey: CryptoKey;
  readonly hourRequestLimit: number;
  readonly minuteRequestLimit: number;
  readonly nextAuditLogId: () => string;
  readonly nextSend: () => { readonly id: string; readonly publicId: string };
  readonly now: () => Date;
  readonly repository: AtomicSendRepository;
  readonly sendDailyLimit: number;
  readonly sendPerMinuteLimit: number;
  readonly telemetry: (event: unknown) => void;
}

export const makeAtomicSendTextMessageService = (
  options: AtomicSendServiceOptions,
): SendTextMessageService => ({
  send: (input) =>
    Effect.promise(async (): Promise<SendTextMessageResult> => {
      const observedAt = options.now();
      const send = options.nextSend();
      const requestFingerprint = await fingerprint(options.fingerprintKey, {
        authorizationId: input.authorizationId,
        connectionId: input.connectionId,
        recipientId: input.recipientId,
        text: input.text,
      });
      const committed = await options.repository.commit(
        {
          ...input,
          auditLogId: options.nextAuditLogId(),
          connectionPublicId: input.connectionId,
          fingerprint: requestFingerprint,
          hourRequestLimit: options.hourRequestLimit,
          minuteRequestLimit: options.minuteRequestLimit,
          observedAt,
          pendingExpiresAt: new Date(observedAt.valueOf() + 7 * 86_400_000),
          recipientPublicId: input.recipientId,
          sendDailyLimit: options.sendDailyLimit,
          sendId: send.id,
          sendPublicId: send.publicId,
          sendPerMinuteLimit: options.sendPerMinuteLimit,
        },
        async (material) => {
          const protectedContent = await Effect.runPromise(
            options.encryption.encrypt({
              ...keys(material),
              context: {
                accountId: material.accountKey.personalAccountId,
                connectionId: material.connectionKey.connectionId,
                entity: "send-operation",
                fieldOrObjectPurpose: "pending-send-content",
                recordId: send.id,
              },
              plaintext: encoder.encode(input.text),
            }),
          );
          return {
            ciphertext: Uint8Array.from(
              atob(protectedContent.ciphertext),
              (character) => character.charCodeAt(0),
            ),
            keyVersion: protectedContent.keyVersion,
            nonce: Uint8Array.from(atob(protectedContent.nonce), (character) =>
              character.charCodeAt(0),
            ),
          };
        },
      );
      if (committed.outcome === "replay")
        return {
          outcome: "receipt",
          receipt: receipt(committed.receipt, true),
        };
      if (committed.outcome !== "created") return committed;
      const provider = committed.provider;
      const opened = keys(provider);
      const decryptString = async (
        ciphertext: VersionedCiphertext,
        context: { entity: string; purpose: string; recordId: string },
      ): Promise<string> => {
        const value = await Effect.runPromise(
          options.encryption.decrypt({
            ...opened,
            ciphertext,
            context: {
              accountId: provider.accountKey.personalAccountId,
              connectionId: provider.connectionKey.connectionId,
              entity: context.entity,
              fieldOrObjectPurpose: context.purpose,
              recordId: context.recordId,
            },
          }),
        );
        try {
          return new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          }).decode(value);
        } finally {
          value.fill(0);
        }
      };
      let status:
        | "accepted"
        | "sent"
        | "delivered"
        | "read"
        | "failed"
        | "unknown";
      try {
        const authority = await decryptString(envelope(provider.authority), {
          entity: "whatsapp-connection",
          purpose: "provider-session-authority",
          recordId: provider.connectionKey.connectionId,
        });
        const recipient = await decryptString(envelope(provider.recipient), {
          entity:
            provider.recipientType === "contact"
              ? "directory-contact"
              : "whatsapp-group",
          purpose: "provider-identity",
          recordId: provider.recipientRecordId,
        });
        const identityBytes = await Effect.runPromise(
          options.encryption.decrypt({
            ...opened,
            ciphertext: envelope(provider.identityKey),
            context: {
              accountId: provider.accountKey.personalAccountId,
              connectionId: provider.connectionKey.connectionId,
              entity: "whatsapp-connection",
              fieldOrObjectPurpose: "webhook-identity-key",
              recordId: provider.connectionKey.connectionId,
            },
          }),
        );
        try {
          const locator = "send-recipient" as RecipientLocator;
          const adapter = makeWasenderTextSending({
            authority: Redacted.make(authority) as never,
            identityKey: Redacted.make(
              identityBytes,
            ) as WasenderIdentityProtectionKey,
            resolveRecipient: (candidate) =>
              candidate === locator
                ? (Redacted.make(recipient) as WasenderRecipientIdentity)
                : null,
            telemetry: { emit: options.telemetry },
          });
          const result = await Effect.runPromise(
            adapter.sendText({ recipient: locator, text: input.text }),
          );
          status =
            result.outcome === "ambiguous"
              ? "unknown"
              : result.outcome === "definitive_failure"
                ? "failed"
                : result.status;
        } finally {
          identityBytes.fill(0);
        }
      } catch {
        status = "unknown";
      }
      const updated = await options.repository
        .recordProviderOutcome({
          changedAt: options.now(),
          sendId: send.id,
          status,
        })
        .catch(() => committed.receipt);
      return { outcome: "receipt", receipt: receipt(updated, false) };
    }).pipe(
      Effect.catchAll(() =>
        Effect.succeed({ outcome: "service_unavailable" as const }),
      ),
    ),
});

export const importSendFingerprintKey = async (
  hex: string,
): Promise<CryptoKey> => {
  if (!/^[a-f0-9]{64}$/u.test(hex))
    throw new Error(
      "SEND_FINGERPRINT_HMAC_SECRET must be a 32-byte hex secret",
    );
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(hex.match(/../gu) ?? [], (part) =>
      Number.parseInt(part, 16),
    ),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
};
