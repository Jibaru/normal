import { TEST_CLERK_JWT_PUBLIC_KEY } from "./clerk";

export const validEnvironment = () => ({
  AWS_ACCESS_KEY_ID: "temporary-access-key",
  AWS_KMS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "temporary-secret",
  AWS_SESSION_TOKEN: "temporary-session-token",
  CLERK_API_AUDIENCE: "https://api.example.test",
  CLERK_AUTHORIZED_PARTY: "https://app.example.test",
  CLERK_ISSUER: "https://clerk.example.test",
  CLERK_JWT_KEY: TEST_CLERK_JWT_PUBLIC_KEY,
  DELETION_CAPSULES: {
    get: async () => null,
    put: async () => null,
  },
  DELETION_MARKER_HMAC_SECRET:
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  DELETION_MARKERS: {
    get: async () => null,
    list: async () => ({ objects: [], truncated: false }),
    put: async () => null,
  },
  DEPLOYMENT_ENVIRONMENT: "production",
  HYPERDRIVE: {
    connectionString: "postgresql://runtime@hyperdrive.internal/database",
  },
  INGESTION_QUEUE: {
    send: async () => undefined,
  },
  KMS_CONTENT_ROOT_KEY_ARN:
    "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
  KMS_DELETION_COORDINATOR_KEY_ARN:
    "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002",
  OAUTH_CLIENT_REGISTRY: JSON.stringify([
    {
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      redirectUris: ["https://client.example.test/callback"],
    },
  ]),
  OAUTH_ISSUER: "https://api.example.test",
  OAUTH_KV: {
    delete: async () => undefined,
    get: async () => null,
    put: async () => undefined,
  },
  OAUTH_PROTOCOL_ENCRYPTION_KEY:
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  OAUTH_RESOURCE: "https://api.example.test/mcp",
  PROVIDER_APPROVED_SESSION_CAPACITY: "3",
  PROVIDER_CONTROL: {
    connectSession: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    createSession: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    deleteSession: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    fetch: async () => new Response(null, { status: 204 }),
    getQrCode: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    listSessions: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    reconcileSession: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
  },
  STORED_MEDIA: {
    createMultipartUpload: async () => ({
      abort: async () => undefined,
      complete: async () => ({}),
      uploadPart: async (partNumber: number) => ({
        etag: "test-etag",
        partNumber,
      }),
    }),
    delete: async () => undefined,
    get: async () => null,
    put: async () => null,
  },
  WEBHOOK_INGRESS: {
    delete: async () => undefined,
    get: async () => null,
    put: async () => null,
  },
});
