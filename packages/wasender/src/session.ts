/**
 * Operation-specific policies prevent a generic retry wrapper from turning an
 * ambiguous provider result into a repeated side effect.
 */
export const jsonReadPolicy = {
  attemptTimeoutMs: 10_000,
  jittered: true,
  maxAttempts: 3,
  retryHttpStatuses: [408, 429, "5xx"],
  retryNetworkErrors: true,
  totalTimeoutMs: 25_000,
} as const;

export const textSendPolicy = {
  attemptTimeoutMs: 15_000,
  maxAttempts: 1,
  retryAmbiguousResult: false,
} as const;

export const mediaDecryptMetadataPolicy = {
  attemptTimeoutMs: 30_000,
} as const;

export const guardedMediaDownloadPolicy = {
  attemptTimeoutMs: 60_000,
} as const;
