import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { TEST_CLERK_JWT_PUBLIC_KEY } from "./test/support/clerk.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/support/public-boundary-worker.ts",
      miniflare: {
        bindings: {
          AWS_ACCESS_KEY_ID: "test-temporary-access-key",
          AWS_SECRET_ACCESS_KEY: "test-temporary-secret",
          AWS_SESSION_TOKEN: "test-temporary-session-token",
          CLERK_API_AUDIENCE: "https://api.example.test",
          CLERK_AUTHORIZED_PARTY: "https://app.example.test",
          CLERK_ISSUER: "https://clerk.example.test",
          CLERK_JWT_KEY: TEST_CLERK_JWT_PUBLIC_KEY,
          DECRYPTED_MEDIA_BYTES_PER_DAY: "268435456",
          DELETION_MARKER_HMAC_SECRET:
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
          DEPLOYMENT_ENVIRONMENT: "production",
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
          OAUTH_PROTOCOL_ENCRYPTION_KEY:
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
          OAUTH_RESOURCE: "https://api.example.test/mcp",
          MCP_REQUESTS_PER_HOUR: "600",
          MCP_REQUESTS_PER_MINUTE: "60",
          MESSAGE_RETENTION_DAY_OPTIONS: "7,30,90",
          MCP_CURSOR_HMAC_SECRET:
            "3939393939393939393939393939393939393939393939393939393939393939",
          READ_MESSAGE_RECORDS_PER_DAY: "10000",
          SEND_FINGERPRINT_HMAC_SECRET:
            "3838383838383838383838383838383838383838383838383838383838383838",
          SENDS_PER_DAY: "200",
          SENDS_PER_MINUTE: "10",
          PROVIDER_APPROVED_SESSION_CAPACITY: "3",
          WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET:
            "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
        },
        serviceBindings: {
          PROVIDER_CONTROL: () =>
            new Response(
              JSON.stringify({
                service: "provider-control",
                status: "ok",
              }),
              {
                headers: {
                  "content-type": "application/json; charset=utf-8",
                },
              },
            ),
        },
      },
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
  test: {
    include: ["test/public-boundary-runtime.test.ts"],
    testTimeout: 30_000,
  },
});
