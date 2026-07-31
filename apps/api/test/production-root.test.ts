import { describe, expect, test } from "vitest";
import { createProductionHandler } from "../src/production";

const validEnvironment = () => ({
  AWS_ACCESS_KEY_ID: "temporary-access-key",
  AWS_KMS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "temporary-secret",
  AWS_SESSION_TOKEN: "temporary-session-token",
  DELETION_MARKERS: {
    delete: async () => undefined,
    get: async () => null,
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

  test("fails closed for a KMS root outside us-east-1", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      KMS_CONTENT_ROOT_KEY_ARN:
        "arn:aws:kms:us-west-2:111122223333:key/00000000-0000-0000-0000-000000000001",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });
});
