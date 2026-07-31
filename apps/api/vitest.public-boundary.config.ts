import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/support/public-boundary-worker.ts",
      miniflare: {
        bindings: {
          AWS_ACCESS_KEY_ID: "test-temporary-access-key",
          AWS_SECRET_ACCESS_KEY: "test-temporary-secret",
          AWS_SESSION_TOKEN: "test-temporary-session-token",
          DEPLOYMENT_ENVIRONMENT: "production",
          KMS_CONTENT_ROOT_KEY_ARN:
            "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
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
