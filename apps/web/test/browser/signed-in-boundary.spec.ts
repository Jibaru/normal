import { expect, test } from "@playwright/test";

test("drives the signed-in browser-to-API boundary over real HTTP", async ({
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
        session: {
          getToken: async () => "signed-test-user",
        },
      },
      writable: false,
    });
  });
  await page.goto("/");

  await page
    .getByRole("button", { name: "Check signed-in API access" })
    .click();

  await expect(page.getByTestId("api-boundary-status")).toHaveText(
    "Connected as user_test_public_boundary",
  );
});

test("recovers when the external identity token lookup fails", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Clerk", {
      configurable: false,
      value: {
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
    name: "Check signed-in API access",
  });
  await button.click();

  await expect(page.getByTestId("api-boundary-status")).toHaveText(
    "unavailable",
  );
  await expect(button).toBeEnabled();
});
