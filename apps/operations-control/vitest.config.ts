import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          API_ORIGIN: "https://api.example.test",
          DEPLOYMENT_ENVIRONMENT: "production",
        },
        kvNamespaces: ["ALERT_RECEIPTS"],
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: { testTimeout: 30_000 },
});
