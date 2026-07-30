/**
 * Provider payloads enter this module as unknown and may leave it only after
 * normalization into a caller-supplied provider-neutral type.
 */
export interface WasenderWebhookNormalizer<NormalizedItem> {
  readonly normalize: (
    providerPayload: unknown,
  ) => ReadonlyArray<NormalizedItem>;
}
