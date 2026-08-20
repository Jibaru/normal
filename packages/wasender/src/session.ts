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
export type WasenderRecipientRoute =
  ProtectedAdapterValue<"WasenderRecipientRoute">;

declare const verifiedPdfBytes: unique symbol;

/** Raw PDF bytes that passed the adapter's bounded structural preflight. */
export type VerifiedPdfBytes = Uint8Array & {
  readonly [verifiedPdfBytes]: "VerifiedPdfBytes";
};

export const maximumOutboundPdfBytes = 16_777_216;

export const makeVerifiedPdfBytes = (bytes: Uint8Array): VerifiedPdfBytes => {
  if (bytes.byteLength < 8 || bytes.byteLength > maximumOutboundPdfBytes) {
    throw new RangeError(
      `PDF bytes must contain 8 through ${maximumOutboundPdfBytes} bytes`,
    );
  }
  const signature = String.fromCharCode(...bytes.subarray(0, 8));
  if (!/^%PDF-[1-9]\.[0-9]$/u.test(signature)) {
    throw new TypeError("PDF bytes must begin with a PDF version signature");
  }
  return bytes.slice() as VerifiedPdfBytes;
};

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
  /** Connection-keyed equality token shared with authenticated webhook items. */
  readonly identity: ContactLocator;
  readonly phoneNumber: string | null;
  /**
   * An adapter-produced routing token, never a raw provider contact identifier.
   */
  readonly recipient: ContactLocator;
}

export interface DirectoryGroup {
  readonly displayName: string | null;
  /** Connection-keyed equality token shared with authenticated webhook items. */
  readonly identity: GroupLocator;
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
 * the encrypted provider route belonging to the already-authorized Directory
 * recipient; it returns no route for any other locator.
 */
export interface WasenderTextSendingOptions {
  readonly authority: SessionAuthority;
  readonly identityKey: WasenderIdentityProtectionKey;
  readonly resolveRecipient: (
    recipient: RecipientLocator,
  ) => WasenderRecipientRoute | null;
  readonly telemetry: TextSendTelemetry;
}

export type PdfSendResult =
  | TextSendResult
  | {
      readonly outcome: "definitive_failure";
      readonly reason: "upload_failed";
      readonly retryAfterMs: BoundedRetryAfterMs | null;
    };

/** Uploads one verified PDF and performs at most one document-send attempt. */
export interface PdfSending {
  readonly sendPdf: (request: {
    readonly bytes: VerifiedPdfBytes;
    readonly fileName: string;
    readonly recipient: RecipientLocator;
  }) => Effect.Effect<PdfSendResult>;
}

export const PdfSending = Context.GenericTag<PdfSending>(
  "@whatsapp-mcp/wasender/PdfSending",
);

export interface PdfSendTelemetryEvent {
  readonly durationMs: number;
  readonly operationClass: "pdf-send";
  readonly outcome: PdfSendResult["outcome"];
  readonly responseBytes: number | null;
  readonly sendAttemptCount: 0 | 1;
  readonly uploadAttemptCount: 0 | 1;
  readonly uploadBytes: number;
}

export interface WasenderPdfSendingOptions {
  readonly authority: SessionAuthority;
  readonly identityKey: WasenderIdentityProtectionKey;
  readonly resolveRecipient: (
    recipient: RecipientLocator,
  ) => WasenderRecipientRoute | null;
  readonly telemetry: {
    readonly emit: (event: PdfSendTelemetryEvent) => void;
  };
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
  makeWasenderPdfSending,
  makeWasenderPdfSendingLayer,
} from "./pdf-send";
export {
  makeWasenderRecipientRoute,
  makeWasenderTextSending,
  makeWasenderTextSendingLayer,
} from "./text-send";
