import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          DEPLOYMENT_ENVIRONMENT: "production",
          RECOVERY_EVIDENCE_TOKEN: "a".repeat(32),
          RECOVERY_VERIFIER_DATABASE_PASSWORD: "b".repeat(64),
        },
        serviceBindings: {
          RECOVERY_GAME_DAY: () =>
            Response.json({ status: "failed" }, { status: 503 }),
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: { testTimeout: 30_000 },
});
