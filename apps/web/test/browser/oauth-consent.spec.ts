import { expect, type Page, test } from "@playwright/test";

const handoff = "R".repeat(43);
const connectionId = "con_123456789012345678901";

const installClerk = async (
  page: Page,
  factorAge: number,
  onReverification = () => undefined,
) => {
  await page.exposeFunction("__recordReverification", onReverification);
  await page.addInitScript((initialFactorAge: number) => {
    const session = {
      clearCache: () => undefined,
      factorVerificationAge: [initialFactorAge, -1] as [number, number],
      getToken: async () => "signed-test-user",
    };
    Object.defineProperty(window, "Clerk", {
      configurable: false,
      value: {
        __internal_openReverification: (options: {
          readonly afterVerification?: () => void;
        }) => {
          void (
            window as unknown as {
              __recordReverification: () => Promise<void>;
            }
          ).__recordReverification();
          session.factorVerificationAge = [0, -1];
          options.afterVerification?.();
        },
        loaded: true,
        session,
      },
      writable: false,
    });
  }, factorAge);
};

test("approves only explicit authority after recent Clerk reverification", async ({
  page,
}) => {
  let decision: Record<string, unknown> | undefined;
  let reverificationOpened = false;
  await installClerk(page, 10, () => {
    reverificationOpened = true;
  });
  await page.route("https://api.example.test/**", async (route) => {
    const request = route.request();
    if (request.url().endsWith("/inspect")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          client: { name: "Approved MCP Client" },
          connections: [
            { connection_id: connectionId, label: "Personal WhatsApp" },
          ],
          presentation: "presentation",
          requested_scopes: ["connections:read", "messages:send"],
        }),
      });
      return;
    }
    decision = request.postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        redirect_to: "http://127.0.0.1:3000/?oauth=approved",
      }),
    });
  });

  await page.goto(`/oauth/consent?request=${handoff}`);
  await expect(
    page.getByRole("heading", { name: "Approved MCP Client" }),
  ).toBeVisible();
  await expect(page.getByLabel("Share selected read data")).not.toBeChecked();
  await expect(page.getByLabel("Allow outbound sends")).not.toBeChecked();
  await expect(page.getByLabel("Personal WhatsApp")).not.toBeChecked();

  await page.getByLabel("Personal WhatsApp").check();
  await page.getByLabel("Send messages").check();
  await page.getByLabel("Allow outbound sends").check();
  await page.getByRole("button", { name: "Approve" }).click();

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
  expect(reverificationOpened).toBe(true);
});

test("denies without selecting a Connection or scope", async ({ page }) => {
  let decision: Record<string, unknown> | undefined;
  await installClerk(page, 0);
  await page.route("https://api.example.test/**", async (route) => {
    if (route.request().url().endsWith("/inspect")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          client: { name: "Approved MCP Client" },
          connections: [
            { connection_id: connectionId, label: "Personal WhatsApp" },
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
        redirect_to:
          "http://127.0.0.1:3000/?error=access_denied&state=client-state",
      }),
    });
  });

  await page.goto(`/oauth/consent?request=${handoff}`);
  await page.getByRole("button", { name: "Deny" }).click();

  await expect
    .poll(() => decision)
    .toEqual({
      decision: "deny",
      presentation: "presentation",
      request: handoff,
    });
});
