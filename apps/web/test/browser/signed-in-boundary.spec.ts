import { expect, test } from "@playwright/test";

// A failed journey must not retain the ephemeral QR response in a trace.
test.use({ trace: "off" });

test("drives the signed-in browser-to-API boundary over real HTTP", async ({
  page,
  request,
}) => {
  const apiMethods: string[] = [];
  const setupBodies: Array<{
    readonly idempotency_key: string;
    readonly whatsapp_number: string;
  }> = [];
  let releaseFirstSetup: (() => void) | undefined;
  const firstSetupCanContinue = new Promise<void>((resolve) => {
    releaseFirstSetup = resolve;
  });
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
    apiMethods.push(original.method());
    if (new URL(original.url()).pathname === "/v1/connection-setups") {
      setupBodies.push(original.postDataJSON());
      if (setupBodies.length === 1) {
        await firstSetupCanContinue;
      }
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
  expect(apiMethods).toEqual(expect.arrayContaining(["POST", "GET"]));

  const whatsappNumber = page.getByLabel("WhatsApp Number");
  const startConnectionSetup = page.getByRole("button", {
    name: "Start Connection Setup",
  });
  await whatsappNumber.fill("+1 (555) 012-3456");
  await startConnectionSetup.click();
  await expect(whatsappNumber).toBeDisabled();
  await expect(startConnectionSetup).toBeDisabled();
  releaseFirstSetup?.();
  await expect(page.getByTestId("connection-setup-status")).toHaveText(
    "Connection Setup started. Preparing your QR code.",
  );
  await expect(
    page.getByRole("img", { name: "Scan this WhatsApp QR code" }),
  ).toBeVisible();
  await expect(page.getByTestId("connection-setup-status")).toHaveText(
    "Scan this QR code with WhatsApp.",
  );
  await expect(page.getByTestId("connection-setup-status")).toHaveText(
    "WhatsApp Connection active.",
  );
  await expect(
    page.getByRole("img", { name: "Scan this WhatsApp QR code" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("whatsapp-connection")).toContainText(
    "Number ending 3456",
  );
  await expect(page.getByTestId("whatsapp-connection")).toContainText(
    "connected",
  );
  await expect(page.getByTestId("whatsapp-connection")).not.toContainText(
    "session-authority",
  );
  expect(setupBodies).toHaveLength(1);
  expect(setupBodies[0]?.whatsapp_number).toBe("+1 (555) 012-3456");
  expect(setupBodies[0]?.idempotency_key).toMatch(/^[A-Za-z0-9_-]{21}$/);
  const providerObservations = await request.get(
    "http://127.0.0.1:8787/test/provider-observations",
  );
  expect(await providerObservations.json()).toEqual([
    "reconcileSession",
    "connectSession",
    "getQrCode",
    "reconcileSession",
  ]);
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
