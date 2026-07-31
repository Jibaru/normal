import { describe, expect, test } from "vitest";
import { createProductionHandler } from "../src/production";
import { validEnvironment } from "./support/production";

describe("API production root", () => {
  test("accepts valid production configuration", async () => {
    const response = await createProductionHandler(validEnvironment())(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(200);
  });

  test.each([
    "CONNECTION_SETUP_PROVISIONING_QUEUE",
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
    "OAUTH_CLIENT_REGISTRY",
    "OAUTH_ISSUER",
    "OAUTH_PROTOCOL_ENCRYPTION_KEY",
    "OAUTH_RESOURCE",
    "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
  ] as const)("fails closed when %s is absent", async (configuration) => {
    const { [configuration]: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test("fails closed when provider-approved capacity is missing", async () => {
    const { PROVIDER_APPROVED_SESSION_CAPACITY: _missing, ...environment } =
      validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test("fails closed when the WhatsApp Number reservation secret is malformed", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET: "not-a-32-byte-key",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test.each(["0", "2", "3.5", "replace-with-approved-capacity"])(
    "fails closed when provider-approved capacity is %s",
    async (capacity) => {
      const response = await createProductionHandler({
        ...validEnvironment(),
        PROVIDER_APPROVED_SESSION_CAPACITY: capacity,
      })(new Request("https://api.example.test/health"));

      expect(response.status).toBe(503);
    },
  );

  test.each([
    ["CLERK_API_AUDIENCE", "http://api.example.test"],
    ["CLERK_AUTHORIZED_PARTY", "https://app.example.test/path"],
    ["CLERK_ISSUER", "https://user@clerk.example.test"],
    ["CLERK_JWT_KEY", "not-a-public-key"],
    [
      "CLERK_JWT_KEY",
      "-----BEGIN PUBLIC KEY-----\ncHJvZHVjdGlvbi1wdWJsaWMta2V5\n-----END PUBLIC KEY-----",
    ],
    ["OAUTH_ISSUER", "http://api.example.test"],
    ["OAUTH_ISSUER", "https://other-api.example.test"],
    ["OAUTH_RESOURCE", "https://api.example.test/other"],
    ["OAUTH_PROTOCOL_ENCRYPTION_KEY", "not-a-32-byte-key"],
    ["OAUTH_CLIENT_REGISTRY", "not-json"],
    ["OAUTH_CLIENT_REGISTRY", "[]"],
    [
      "OAUTH_CLIENT_REGISTRY",
      JSON.stringify([
        {
          clientClass: "approved",
          clientId: "approved-client",
          clientName: "Approved MCP Client",
          redirectUris: ["https://client.example.test/callback#fragment"],
        },
      ]),
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
