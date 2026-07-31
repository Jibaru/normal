import { expect, test } from "@playwright/test";

test("drives the signed-in browser-to-API boundary over real HTTP", async ({
  page,
  request,
}) => {
  let apiMethod: string | undefined;
  const setupBodies: Array<{
    readonly idempotency_key: string;
    readonly whatsapp_number: string;
  }> = [];
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
    apiMethod = original.method();
    if (new URL(original.url()).pathname === "/v1/connection-setups") {
      setupBodies.push(original.postDataJSON());
    }
    const localUrl = new URL(original.url());
    localUrl.protocol = "http:";
    localUrl.hostname = "127.0.0.1";
    localUrl.port = "8787";

    const response = await request.fetch(localUrl.toString(), {
      data: original.postDataBuffer(),
      headers: original.headers(),
      method: original.method(),
    });
    await route.fulfill({
      body: await response.body(),
      headers: response.headers(),
      status: response.status(),
    });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "Clerk", {
      configurable: false,
      value: {
        loaded: true,
        session: {
          getToken: async (options: unknown) => {
            Object.defineProperty(window, "__requestedTokenTemplate", {
              configurable: true,
              value: options,
            });
            return "signed-test-user";
          },
        },
      },
      writable: false,
    });
  });
  await page.goto("/");

  await expect(page.getByText("Up to 3 WhatsApp Connections")).toBeVisible();
  await expect(page.getByText("5 GB Stored Media")).toBeVisible();
  await expect(
    page.getByText("30-day default Message Retention Policy"),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Bootstrap Personal Account" })
    .click();

  await expect(page.getByTestId("api-boundary-status")).toHaveText(
    "Personal Account ready",
  );
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            readonly __requestedTokenTemplate?: unknown;
          }
        ).__requestedTokenTemplate,
    ),
  ).toEqual({ template: "whatsapp-api" });
  expect(apiMethod).toBe("POST");

  await page.getByLabel("WhatsApp Number").fill("+1 (555) 012-3456");
  await page.getByRole("button", { name: "Start Connection Setup" }).click();
  await expect(page.getByTestId("connection-setup-status")).toHaveText(
    "Connection Setup started. Preparing your QR code.",
  );
  await page.getByRole("button", { name: "Start Connection Setup" }).click();
  await expect(page.getByTestId("connection-setup-status")).toHaveText(
    "Connection Setup already started. Preparing your QR code.",
  );
  expect(setupBodies).toHaveLength(2);
  expect(setupBodies[0]?.whatsapp_number).toBe("+1 (555) 012-3456");
  expect(setupBodies[0]?.idempotency_key).toMatch(/^[A-Za-z0-9_-]{21}$/);
  expect(setupBodies[1]?.idempotency_key).toBe(setupBodies[0]?.idempotency_key);
});

test("waitlists a signed-in User when private-beta capacity is exhausted", async ({
  page,
  request,
}) => {
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
    const localUrl = new URL(original.url());
    localUrl.protocol = "http:";
    localUrl.hostname = "127.0.0.1";
    localUrl.port = "8787";

    const response = await request.fetch(localUrl.toString(), {
      data: original.postDataBuffer(),
      headers: original.headers(),
      method: original.method(),
    });
    await route.fulfill({
      body: await response.body(),
      headers: response.headers(),
      status: response.status(),
    });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "Clerk", {
      configurable: false,
      value: {
        loaded: true,
        session: {
          getToken: async () => "signed-waitlisted-user",
        },
      },
      writable: false,
    });
  });
  await page.goto("/");

  await page
    .getByRole("button", { name: "Bootstrap Personal Account" })
    .click();

  await expect(page.getByTestId("api-boundary-status")).toHaveText(
    "You’re on the private-beta waitlist",
  );
});

test("recovers when the external identity token lookup fails", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Clerk", {
      configurable: false,
      value: {
        loaded: true,
        session: {
          getToken: async () => {
            throw new Error("identity unavailable");
          },
        },
      },
      writable: false,
    });
  });
  await page.goto("/");

  const button = page.getByRole("button", {
    name: "Bootstrap Personal Account",
  });
  await button.click();

  await expect(page.getByTestId("api-boundary-status")).toHaveText(
    "unavailable",
  );
  await expect(button).toBeEnabled();
});

test("opens the real Clerk sign-in flow when no browser session exists", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Clerk", {
      configurable: false,
      value: {
        loaded: true,
        openSignIn: () => {
          Object.defineProperty(window, "__openedClerkSignIn", {
            configurable: true,
            value: true,
          });
        },
        session: null,
      },
      writable: false,
    });
  });
  await page.goto("/");

  await page
    .getByRole("button", { name: "Bootstrap Personal Account" })
    .click();

  await expect(page.getByTestId("api-boundary-status")).toHaveText(
    "signed_out",
  );
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            readonly __openedClerkSignIn?: boolean;
          }
        ).__openedClerkSignIn,
    ),
  ).toBe(true);
});
