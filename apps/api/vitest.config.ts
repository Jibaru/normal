import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
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
