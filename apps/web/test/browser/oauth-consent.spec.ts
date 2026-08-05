import { expect, type Page, test } from "@playwright/test";
import { installClerkBrowser } from "../support/clerk-browser";

const webPort = process.env.PLAYWRIGHT_WEB_PORT ?? "3000";
const handoff = "R".repeat(43);
const connectionId = "con_123456789012345678901";

const installClerk = async (
  page: Page,
  _factorAge: number,
  onReverification = () => undefined,
  onTokenRequest = (_options: unknown) => undefined,
) => {
  await installClerkBrowser(page, {
    onReverification,
    onTokenRequest,
    signedIn: true,
  });
};

test("approves only explicit authority after recent Clerk reverification", async ({
  page,
}) => {
  let decision: Record<string, unknown> | undefined;
  let reverificationOpened = false;
  let approvalAttempts = 0;
  const tokenRequests: Array<unknown> = [];
  await installClerk(
    page,
    10,
    () => {
      reverificationOpened = true;
    },
    (options) => {
      tokenRequests.push(options);
    },
  );
  await page.route("**/v1/oauth/consent/**", async (route) => {
    const request = route.request();
    if (request.url().endsWith("/inspect")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          client: { name: "Approved MCP Client" },
          connections: [
            {
              connection_id: connectionId,
              label: "Personal WhatsApp",
              number_suffix: "3456",
            },
          ],
          presentation: "presentation",
          requested_scopes: ["connections:read", "messages:send"],
        }),
      });
      return;
    }
    decision = request.postDataJSON() as Record<string, unknown>;
    if (decision.decision === "approve" && approvalAttempts++ === 0) {
      await route.fulfill({
        contentType: "application/json",
        status: 403,
        body: JSON.stringify({
          clerk_error: {
            metadata: {
              reverification: {
                afterMinutes: 5,
                level: "first_factor",
              },
            },
            reason: "reverification-error",
            type: "forbidden",
          },
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        redirect_to: `http://127.0.0.1:${webPort}/?oauth=approved`,
      }),
    });
  });

  await page.goto(`/oauth/consent?request=${handoff}`);
  await expect(
    page.getByRole("heading", {
      name: "Let Approved MCP Client use WhatsApp?",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "I’m okay with this app sending WhatsApp messages for me",
    }),
  ).not.toBeVisible();
  await expect(
    page.getByLabel("Personal WhatsApp, ending in 3456"),
  ).not.toBeChecked();

  await page
    .getByRole("checkbox", { name: "Personal WhatsApp, ending in 3456" })
    .check();
  await page
    .getByRole("checkbox", { name: "Send WhatsApp messages for you" })
    .check();
  await page
    .getByRole("checkbox", {
      name: "I’m okay with this app sending WhatsApp messages for me",
    })
    .check();
  await page.getByRole("button", { name: "Allow access" }).click();

  await expect
    .poll(() => decision)
    .toMatchObject({
      connection_ids: [connectionId],
      decision: "approve",
      read_confirmed: false,
      request: handoff,
      scopes: ["messages:send"],
      send_confirmed: true,
    });
  await expect.poll(() => reverificationOpened).toBe(true);
  await expect
    .poll(() => tokenRequests)
    .toContainEqual({
      skipCache: true,
      template: "whatsapp-api",
    });
  await expect(page).toHaveURL(/\?oauth=approved$/u);
});

test("denies without selecting a Connection or scope", async ({ page }) => {
  let decision: Record<string, unknown> | undefined;
  await installClerk(page, 0);
  await page.route("**/v1/oauth/consent/**", async (route) => {
    if (route.request().url().endsWith("/inspect")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          client: { name: "Approved MCP Client" },
          connections: [
            {
              connection_id: connectionId,
              label: "Personal WhatsApp",
              number_suffix: null,
            },
          ],
          presentation: "presentation",
          requested_scopes: ["connections:read"],
        }),
      });
      return;
    }
    decision = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        redirect_to: `http://127.0.0.1:${webPort}/?error=access_denied&state=client-state`,
      }),
    });
  });

  await page.goto(`/oauth/consent?request=${handoff}`);
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect
    .poll(() => decision)
    .toEqual({
      decision: "deny",
      presentation: "presentation",
      request: handoff,
    });
});
