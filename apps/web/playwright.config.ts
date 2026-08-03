import { defineConfig } from "@playwright/test";

const webOrigin = "http://127.0.0.1:3000";
const apiOrigin = "http://127.0.0.1:8787";

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  retries: process.env.CI ? 2 : 0,
  testDir: "./test/browser",
  use: {
    baseURL: webOrigin,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command:
        "bun x wrangler dev --config test/wrangler.browser.jsonc --ip 127.0.0.1 --port 8787",
      cwd: "../api",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      url: `${apiOrigin}/test/ready`,
    },
    {
      command:
        "DEPLOYMENT_ENVIRONMENT=development NEXT_PUBLIC_API_ORIGIN=https://api.example.test NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA bun run build && bun run start --hostname 127.0.0.1 --port 3000",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      url: webOrigin,
    },
  ],
});
