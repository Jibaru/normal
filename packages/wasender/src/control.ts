/**
 * Account-level Wasender operations live behind this boundary and are only
 * implemented by the provider-control Worker.
 */
export interface WasenderControlClient {
  readonly createSession: (request: Request) => Promise<Response>;
  readonly connectSession: (request: Request) => Promise<Response>;
  readonly getQrCode: (request: Request) => Promise<Response>;
  readonly reconcileSession: (request: Request) => Promise<Response>;
  readonly deleteSession: (request: Request) => Promise<Response>;
}
