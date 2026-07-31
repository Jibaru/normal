import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          AWS_ACCESS_KEY_ID: "test-temporary-access-key",
          AWS_SECRET_ACCESS_KEY: "test-temporary-secret",
          AWS_SESSION_TOKEN: "test-temporary-session-token",
          DELETION_MARKER_HMAC_SECRET:
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
          KMS_CONTENT_ROOT_KEY_ARN:
            "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
          KMS_DELETION_COORDINATOR_KEY_ARN:
            "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002",
        },
        serviceBindings: {
          PROVIDER_CONTROL: () => new Response(null, { status: 204 }),
        },
      },
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
  test: {
    server: {
      deps: {
        inline: ["pg"],
      },
    },
    testTimeout: 30_000,
  },
});
