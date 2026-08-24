import { resolve } from "node:path";
import type { Page } from "@playwright/test";

const clerkScript = resolve("test/support/clerk-test.js");
const clerkUiScript = resolve("test/support/clerk-ui-test.js");

interface ClerkBrowserOptions {
  readonly onReverification?: (() => void) | undefined;
  readonly onTokenRequest?: ((options: unknown) => void) | undefined;
  readonly reverifiedToken?: string | undefined;
  readonly renderReverification?: boolean | undefined;
  readonly sessionToken?: string | undefined;
  readonly signedIn?: boolean | undefined;
  readonly signInToken?: string | undefined;
  readonly token?: string | undefined;
  readonly tokenError?: string | undefined;
}

export const installClerkBrowser = async (
  page: Page,
  options: ClerkBrowserOptions = {},
) => {
  await page.route("**/clerk-test.js", (route) =>
    route.fulfill({ contentType: "text/javascript", path: clerkScript }),
  );
  await page.route("**/clerk-ui-test.js", (route) =>
    route.fulfill({ contentType: "text/javascript", path: clerkUiScript }),
  );
  await page.exposeFunction(
    "__clerkTestRecordReverification",
    options.onReverification ?? (() => undefined),
  );
  await page.exposeFunction(
    "__clerkTestRecordTokenRequest",
    options.onTokenRequest ?? (() => undefined),
  );
  await page.addInitScript((configuration) => {
    const makeSession = (token: string, tokenError?: string) => ({
      factorVerificationAge: [0, -1],
      id: "sess_playwright",
      lastActiveToken: {
        jwt: {
          claims: { sub: "user_playwright" },
        },
      },
      status: "active",
      getToken: async (tokenOptions: unknown) => {
        await (
          window as unknown as {
            __clerkTestRecordTokenRequest: (value: unknown) => Promise<void>;
          }
        ).__clerkTestRecordTokenRequest(tokenOptions);
        if (tokenError) throw new Error(tokenError);
        if (
          typeof tokenOptions === "object" &&
          tokenOptions !== null &&
          "template" in tokenOptions
        ) {
          return token;
        }
        return state.reverified
          ? (configuration.reverifiedToken ?? token)
          : (configuration.sessionToken ?? token);
      },
    });
    const state = {
      completeReverification: () => {
        state.reverified = true;
      },
      openReverification: () => {
        void (
          window as unknown as {
            __clerkTestRecordReverification: () => Promise<void>;
          }
        ).__clerkTestRecordReverification();
      },
      openSignIn: () => {
        Object.defineProperty(window, "__openedClerkSignIn", {
          configurable: true,
          value: true,
        });
        if (configuration.signInToken) {
          state.session = makeSession(configuration.signInToken);
        }
      },
      openWaitlist: () => {
        Object.defineProperty(window, "__openedClerkWaitlist", {
          configurable: true,
          value: true,
        });
      },
      renderReverification: configuration.renderReverification ?? false,
      reverified: false,
      session: configuration.signedIn
        ? makeSession(
            configuration.token ?? "signed-test-user",
            configuration.tokenError,
          )
        : null,
    };
    Object.defineProperty(window, "__clerkTestConfig", {
      configurable: false,
      value: state,
      writable: false,
    });
  }, options);
};
