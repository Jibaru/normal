import { describe, expect, test } from "vitest";
import { createProductionHandler } from "../src/production";

describe("API production root", () => {
  test("accepts valid production configuration", async () => {
    const response = await createProductionHandler({
      AWS_ACCESS_KEY_ID: "temporary-access-key",
      AWS_KMS_REGION: "us-east-1",
      AWS_SECRET_ACCESS_KEY: "temporary-secret",
      AWS_SESSION_TOKEN: "temporary-session-token",
      DEPLOYMENT_ENVIRONMENT: "production",
      HYPERDRIVE: {
        connectionString: "postgresql://runtime@hyperdrive.internal/database",
      },
      KMS_CONTENT_ROOT_KEY_ARN:
        "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
      PROVIDER_CONTROL: {
        fetch: async () => new Response(null, { status: 204 }),
      },
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(200);
  });

  test("fails closed when the provider-control binding is absent", async () => {
    const response = await createProductionHandler({
      AWS_ACCESS_KEY_ID: "temporary-access-key",
      AWS_KMS_REGION: "us-east-1",
      AWS_SECRET_ACCESS_KEY: "temporary-secret",
      AWS_SESSION_TOKEN: "temporary-session-token",
      DEPLOYMENT_ENVIRONMENT: "production",
      HYPERDRIVE: {
        connectionString: "postgresql://runtime@hyperdrive.internal/database",
      },
      KMS_CONTENT_ROOT_KEY_ARN:
        "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed before data-plane traffic when Hyperdrive is absent", async () => {
    const response = await createProductionHandler({
      AWS_ACCESS_KEY_ID: "temporary-access-key",
      AWS_KMS_REGION: "us-east-1",
      AWS_SECRET_ACCESS_KEY: "temporary-secret",
      AWS_SESSION_TOKEN: "temporary-session-token",
      DEPLOYMENT_ENVIRONMENT: "production",
      KMS_CONTENT_ROOT_KEY_ARN:
        "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
      PROVIDER_CONTROL: {
        fetch: async () => new Response(null, { status: 204 }),
      },
    })(new Request("https://api.example.test/ready"));

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      service: "api",
      status: "unavailable",
    });
  });

  test("fails closed when deployment configuration is invalid", async () => {
    const response = await createProductionHandler({
      DEPLOYMENT_ENVIRONMENT: "test",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      service: "api",
      status: "unavailable",
    });
  });

  test("fails closed without temporary KMS role credentials", async () => {
    const response = await createProductionHandler({
      AWS_ACCESS_KEY_ID: "temporary-access-key",
      AWS_KMS_REGION: "us-east-1",
      AWS_SECRET_ACCESS_KEY: "temporary-secret",
      DEPLOYMENT_ENVIRONMENT: "production",
      KMS_CONTENT_ROOT_KEY_ARN:
        "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
      PROVIDER_CONTROL: {
        fetch: async () => new Response(null, { status: 204 }),
      },
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed for a KMS root outside us-east-1", async () => {
    const response = await createProductionHandler({
      AWS_ACCESS_KEY_ID: "temporary-access-key",
      AWS_KMS_REGION: "us-east-1",
      AWS_SECRET_ACCESS_KEY: "temporary-secret",
      AWS_SESSION_TOKEN: "temporary-session-token",
      DEPLOYMENT_ENVIRONMENT: "production",
      KMS_CONTENT_ROOT_KEY_ARN:
        "arn:aws:kms:us-west-2:111122223333:key/00000000-0000-0000-0000-000000000001",
      PROVIDER_CONTROL: {
        fetch: async () => new Response(null, { status: 204 }),
      },
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });
});
