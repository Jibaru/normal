/**
 * Lifecycle writes reconcile provider state before another side effect. The
 * concrete Wasender client remains private to this adapter subpath.
 */
export const lifecycleWritePolicy = {
  attemptTimeoutMs: 15_000,
  repeatStrategy: "reconcile-before-repeat",
} as const;
