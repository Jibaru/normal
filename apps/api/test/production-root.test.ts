import { describe, expect, test } from "vitest";
import { createProductionHandler } from "../src/production";
import { TEST_CLERK_JWT_PUBLIC_KEY } from "./support/clerk";

const validEnvironment = () => ({
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
  OAUTH_KV: {
    delete: async () => undefined,
    get: async () => null,
    put: async () => undefined,
  },
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

describe("API production root", () => {
  test("accepts valid production configuration", async () => {
    const response = await createProductionHandler(validEnvironment())(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(200);
  });

  test.each([
    "DELETION_CAPSULES",
    "DELETION_MARKERS",
    "INGESTION_QUEUE",
    "OAUTH_KV",
    "STORED_MEDIA",
    "WEBHOOK_INGRESS",
  ] as const)("fails closed when the %s binding is absent", async (binding) => {
    const { [binding]: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test("fails closed when the provider-control binding is absent", async () => {
    const { PROVIDER_CONTROL: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test("fails closed when the provider-control binding lacks RPC lifecycle authority", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      PROVIDER_CONTROL: {
        fetch: async () => new Response(null, { status: 204 }),
      },
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed when Stored Media cannot start multipart uploads", async () => {
    const environment = validEnvironment();
    const { createMultipartUpload: _missing, ...storedMediaWithoutMultipart } =
      environment.STORED_MEDIA;

    const response = await createProductionHandler({
      ...environment,
      STORED_MEDIA: storedMediaWithoutMultipart,
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed before data-plane traffic when Hyperdrive is absent", async () => {
    const { HYPERDRIVE: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/ready"),
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      service: "api",
      status: "unavailable",
    });
  });

  test("fails closed when deployment configuration is invalid", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      DEPLOYMENT_ENVIRONMENT: "test",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      service: "api",
      status: "unavailable",
    });
  });

  test("fails closed without temporary KMS role credentials", async () => {
    const { AWS_SESSION_TOKEN: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test.each([
    "CLERK_API_AUDIENCE",
    "CLERK_AUTHORIZED_PARTY",
    "CLERK_ISSUER",
    "CLERK_JWT_KEY",
  ] as const)("fails closed when %s is absent", async (configuration) => {
    const { [configuration]: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test.each([
    ["CLERK_API_AUDIENCE", "http://api.example.test"],
    ["CLERK_AUTHORIZED_PARTY", "https://app.example.test/path"],
    ["CLERK_ISSUER", "https://user@clerk.example.test"],
    ["CLERK_JWT_KEY", "not-a-public-key"],
    [
      "CLERK_JWT_KEY",
      "-----BEGIN PUBLIC KEY-----\ncHJvZHVjdGlvbi1wdWJsaWMta2V5\n-----END PUBLIC KEY-----",
    ],
  ] as const)(
    "fails closed when %s is invalid",
    async (configuration, value) => {
      const response = await createProductionHandler({
        ...validEnvironment(),
        [configuration]: value,
      })(new Request("https://api.example.test/health"));

      expect(response.status).toBe(503);
    },
  );

  test("fails closed for a KMS root outside us-east-1", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      KMS_CONTENT_ROOT_KEY_ARN:
        "arn:aws:kms:us-west-2:111122223333:key/00000000-0000-0000-0000-000000000001",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed without the dedicated marker HMAC secret", async () => {
    const { DELETION_MARKER_HMAC_SECRET: _missing, ...environment } =
      validEnvironment();

    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test("fails closed when the Deletion Capsule key is not a separate us-east-1 key", async () => {
    const environment = validEnvironment();
    const response = await createProductionHandler({
      ...environment,
      KMS_DELETION_COORDINATOR_KEY_ARN: environment.KMS_CONTENT_ROOT_KEY_ARN,
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });
});
