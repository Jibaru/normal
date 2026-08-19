import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          DEPLOYMENT_ENVIRONMENT: "production",
          QUARTERLY_RECEIPT_SECRET: "a".repeat(64),
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: { testTimeout: 30_000 },
});
