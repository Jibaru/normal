import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          RECOVERY_CONTROL_TOKEN: "a".repeat(32),
        },
        serviceBindings: {
          RECOVERY_VERIFIER: () =>
            Response.json({ status: "failed" }, { status: 503 }),
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: { testTimeout: 30_000 },
});
