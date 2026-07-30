/**
 * Per-session operations use a WhatsApp Connection's narrower credential.
 * Account-level provisioning authority is intentionally absent.
 */
export interface WasenderSessionClient {
  readonly request: (request: Request) => Promise<Response>;
}
