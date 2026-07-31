import { Context, type Effect, type Redacted, type Stream } from "effect";
import type {
  AdapterEffect,
  AdapterReference,
  BoundedRetryAfterMs,
  ProtectedAdapterValue,
  ProviderNeutralFailure,
  UtcTimestamp,
} from "./common";
import {
  maximumJsonResponseBytes,
  maximumMediaDownloadBytes,
  maximumRetryAfterMs,
} from "./common";
import type { SessionAuthority } from "./control";

export type {
  AdapterFailureCode,
  BoundedRetryAfterMs,
  OperationClass,
  ProviderNeutralFailure,
  RetryDecision,
} from "./common";
export { makeBoundedRetryAfterMs } from "./common";

export type ContactLocator = AdapterReference<"ContactLocator">;
export type GroupLocator = AdapterReference<"GroupLocator">;
export type MediaSource = ProtectedAdapterValue<"MediaSource">;
export type StableMessageIdentity = AdapterReference<"StableMessageIdentity">;
export type RecipientLocator = ContactLocator | GroupLocator;
export type DirectorySessionAuthority =
  ProtectedAdapterValue<"SessionAuthority">;
export type WasenderRecipientIdentity =
  ProtectedAdapterValue<"WasenderRecipientIdentity">;

declare const wasenderIdentityProtectionKey: unique symbol;

/**
 * Connection-scoped key used only to turn a verified provider message
 * identity into a non-reversible equality token.
 */
export type WasenderIdentityProtectionKey = Redacted.Redacted<
  Uint8Array & {
    readonly [wasenderIdentityProtectionKey]: "WasenderIdentityProtectionKey";
  }
>;

export interface DirectoryContact {
  readonly active: boolean;
  readonly displayName: string | null;
  readonly phoneNumber: string | null;
  /**
   * An adapter-produced routing token, never a raw provider contact identifier.
   */
  readonly recipient: ContactLocator;
}

export interface DirectoryGroup {
  readonly displayName: string | null;
  readonly joined: boolean;
  /**
   * An adapter-produced routing token, never a raw provider group identifier.
   */
  readonly recipient: GroupLocator;
}

export interface DirectoryObservation<Entry> {
  readonly completeness: "complete" | "partial";
  readonly entries: ReadonlyArray<Entry>;
  readonly observedAt: UtcTimestamp;
  readonly stale: boolean;
}

/**
 * Per-session Directory authority. Its production Layer is configured with one
 * WhatsApp Connection's session credential.
 */
export interface SessionDirectory {
  readonly readContacts: () => AdapterEffect<
    DirectoryObservation<DirectoryContact>
  >;
  readonly readGroups: () => AdapterEffect<
    DirectoryObservation<DirectoryGroup>
  >;
}

export const SessionDirectory = Context.GenericTag<SessionDirectory>(
  "@whatsapp-mcp/wasender/SessionDirectory",
);

export type DefinitiveSendFailureReason =
  | "authentication_failed"
  | "provider_rejected"
  | "recipient_rejected"
  | "throttled";

export type AmbiguousSendReason =
  | "connection_lost"
  | "invalid_response"
  | "timed_out"
  | "unavailable";

export type IdentityBearingSendStatus =
  | "accepted"
  | "delivered"
  | "read"
  | "sent";

export type TextSendResult =
  | {
      readonly outcome: "definitive_failure";
      readonly reason: DefinitiveSendFailureReason;
      readonly retryAfterMs: BoundedRetryAfterMs | null;
    }
  | {
      readonly outcome: "provider_acknowledgement";
      readonly status: "accepted";
    }
  | {
      readonly messageIdentity: StableMessageIdentity;
      readonly outcome: "identity_evidence";
      readonly status: IdentityBearingSendStatus;
    }
  | {
      readonly outcome: "ambiguous";
      readonly reason: AmbiguousSendReason;
    };

/**
 * Exactly one text-send attempt. Transport failures are converted to a
 * definitive or ambiguous result so callers cannot accidentally apply a
 * generic Effect retry schedule.
 */
export interface TextSending {
  readonly sendText: (request: {
    readonly recipient: RecipientLocator;
    readonly text: string;
  }) => Effect.Effect<TextSendResult>;
}

export const TextSending = Context.GenericTag<TextSending>(
  "@whatsapp-mcp/wasender/TextSending",
);

export interface TextSendTelemetryEvent {
  readonly attemptCount: 0 | 1;
  readonly durationMs: number;
  readonly operationClass: "text-send";
  readonly outcome: TextSendResult["outcome"];
  readonly responseBytes: number | null;
}

export interface TextSendTelemetry {
  readonly emit: (event: TextSendTelemetryEvent) => void;
}

/**
 * Per-connection production dependencies. The domain resolver unwraps only
 * the encrypted provider identity belonging to the already-authorized
 * Directory recipient; it returns no identity for any other locator.
 */
export interface WasenderTextSendingOptions {
  readonly authority: SessionAuthority;
  readonly identityKey: WasenderIdentityProtectionKey;
  readonly resolveRecipient: (
    recipient: RecipientLocator,
  ) => WasenderRecipientIdentity | null;
  readonly telemetry: TextSendTelemetry;
}

declare const mediaDownloadByteLimit: unique symbol;

export type MediaDownloadByteLimit = number & {
  readonly [mediaDownloadByteLimit]: "MediaDownloadByteLimit";
};

export const makeMediaDownloadByteLimit = (
  value: number,
): MediaDownloadByteLimit => {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximumMediaDownloadBytes
  ) {
    throw new RangeError(
      `Media download byte limit must be an integer from 1 through ${maximumMediaDownloadBytes}`,
    );
  }
  return value as MediaDownloadByteLimit;
};

export interface MediaMetadata {
  readonly expectedSizeBytes: number | null;
  readonly fileName: string | null;
  readonly mimeType: string | null;
  /**
   * A log-safe source value that the owning Worker envelope-encrypts before
   * persistence. Provider URLs never become domain values.
   */
  readonly source: MediaSource;
}

export interface GuardedMediaDownload {
  /**
   * The implementation counts actual streamed bytes and fails the stream
   * before it can yield more than this limit.
   */
  readonly maxBytes: MediaDownloadByteLimit;
  readonly stream: Stream.Stream<Uint8Array, ProviderNeutralFailure>;
}

/**
 * Per-session media authority. Metadata and guarded download remain distinct
 * operations because they have independent timeout and response bounds.
 */
export interface MediaRetrieval {
  readonly getMetadata: (request: {
    readonly source: MediaSource;
  }) => AdapterEffect<MediaMetadata>;
  readonly download: (request: {
    readonly maxBytes: MediaDownloadByteLimit;
    readonly source: MediaSource;
  }) => AdapterEffect<GuardedMediaDownload>;
}

export const MediaRetrieval = Context.GenericTag<MediaRetrieval>(
  "@whatsapp-mcp/wasender/MediaRetrieval",
);

/**
 * Operation-specific policies prevent a generic retry wrapper from turning an
 * ambiguous provider result into a repeated side effect.
 */
export const jsonReadPolicy = {
  ambiguity: "safe-to-repeat",
  attemptTimeoutMs: 10_000,
  jittered: true,
  maxAttempts: 3,
  maxResponseBytes: maximumJsonResponseBytes,
  maxRetryAfterMs: maximumRetryAfterMs,
  operationClass: "safe-read",
  reconciliation: "not-required",
  retryHttpStatuses: [408, 429, "5xx"],
  retryNetworkErrors: true,
  totalTimeoutMs: 25_000,
} as const;

export const textSendPolicy = {
  ambiguity: "acceptance-may-be-unknown",
  attemptTimeoutMs: 15_000,
  maxAttempts: 1,
  maxResponseBytes: maximumJsonResponseBytes,
  operationClass: "text-send",
  reconciliation: "exact-identity-evidence-only",
  retryAmbiguousResult: false,
} as const;

export const mediaDecryptMetadataPolicy = {
  ambiguity: "safe-to-repeat",
  attemptTimeoutMs: 30_000,
  maxAttempts: 1,
  maxResponseBytes: maximumJsonResponseBytes,
  operationClass: "media-metadata",
  reconciliation: "not-required",
} as const;

export const guardedMediaDownloadPolicy = {
  ambiguity: "partial-bytes-must-be-discarded",
  attemptTimeoutMs: 60_000,
  maxAttempts: 1,
  maxResponseBytes: maximumMediaDownloadBytes,
  operationClass: "media-download",
  reconciliation: "restart-from-byte-zero",
} as const;

export {
  makeWasenderSessionDirectory,
  type WasenderDirectoryTelemetryEvent,
  type WasenderSessionDirectoryConfig,
} from "./directory";
export {
  makeWasenderTextSending,
  makeWasenderTextSendingLayer,
} from "./text-send";
