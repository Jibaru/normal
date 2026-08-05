import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { sharedTestBindings, sharedTestOptions } from "./vitest.shared.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/support/public-boundary-worker.ts",
      miniflare: {
        bindings: {
          ...sharedTestBindings,
          DEPLOYMENT_ENVIRONMENT: "production",
          EXTERNAL_ONBOARDING_GATE: "closed",
          SMOKE_CHECK_SECRET:
            "3737373737373737373737373737373737373737373737373737373737373737",
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
    ...sharedTestOptions,
    include: ["test/public-boundary-runtime.test.ts"],
  },
});
