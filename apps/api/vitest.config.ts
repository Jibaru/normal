import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { sharedTestBindings } from "./vitest.shared.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          ...sharedTestBindings,
          WEBHOOK_HYPERDRIVE: {
            connectionString:
              "postgresql://webhook-runtime@hyperdrive.test/database",
          },
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
    setupFiles: ["./test/support/database-readiness.ts"],
    server: {
      deps: {
        inline: ["pg"],
      },
    },
    testTimeout: 30_000,
  },
});
