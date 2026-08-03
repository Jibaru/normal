"use client";

import { Clerk } from "@clerk/clerk-js";

type ClerkUi = NonNullable<
  NonNullable<
    NonNullable<Parameters<InstanceType<typeof Clerk>["load"]>[0]>["ui"]
  >["ClerkUI"]
>;

interface ClerkUiWindow extends Window {
  readonly __internal_ClerkUICtor?: ClerkUi;
}

export interface BrowserClerkClient {
  readonly addListener?: ((listener: () => void) => () => void) | undefined;
  readonly loaded: boolean;
  readonly session:
    | {
        readonly clearCache?: (() => void) | undefined;
        readonly factorVerificationAge?: [number, number] | null | undefined;
        readonly getToken: (options: {
          readonly template: string;
        }) => Promise<string | null>;
      }
    | null
    | undefined;
  readonly __internal_openReverification?:
    | ((options: {
        readonly afterVerification: () => void;
        readonly afterVerificationCancelled: () => void;
        readonly level: "first_factor";
      }) => void)
    | undefined;
  readonly openSignIn?: (() => void) | undefined;
}

let loading: Promise<BrowserClerkClient> | undefined;
let uiLoading: Promise<ClerkUi> | undefined;

const clerkFromWindow = (): BrowserClerkClient | undefined =>
  (window as unknown as { readonly Clerk?: BrowserClerkClient }).Clerk;

const loadClerkUi = async (publishableKey: string): Promise<ClerkUi> => {
  const clerkWindow = window as ClerkUiWindow;
  if (clerkWindow.__internal_ClerkUICtor !== undefined) {
    return clerkWindow.__internal_ClerkUICtor;
  }
  if (uiLoading !== undefined) return uiLoading;

  const encodedDomain = publishableKey
    .replace(/^pk_(?:test|live)_/u, "")
    .replace(/\$$/u, "")
    .replace(/-/gu, "+")
    .replace(/_/gu, "/");
  const paddedDomain = encodedDomain.padEnd(
    Math.ceil(encodedDomain.length / 4) * 4,
    "=",
  );
  const clerkDomain = atob(paddedDomain).replace(/\$$/u, "");
  if (!/^[a-z0-9.-]+$/u.test(clerkDomain)) {
    throw new Error("Invalid Clerk frontend domain");
  }

  const request = new Promise<ClerkUi>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = `https://${clerkDomain}/npm/@clerk/ui@1/dist/ui.browser.js`;
    script.onload = () => {
      const clerkUi = clerkWindow.__internal_ClerkUICtor;
      if (clerkUi === undefined) {
        reject(new Error("Clerk UI bundle did not initialize"));
        return;
      }
      resolve(clerkUi);
    };
    script.onerror = () => reject(new Error("Failed to load Clerk UI bundle"));
    document.head.appendChild(script);
  });
  uiLoading = request;
  try {
    return await request;
  } catch (error) {
    if (uiLoading === request) uiLoading = undefined;
    throw error;
  }
};

export const loadBrowserClerk = async (
  publishableKey: string,
): Promise<BrowserClerkClient> => {
  const existing = clerkFromWindow();
  if (existing?.loaded) {
    return existing;
  }
  if (loading) {
    return loading;
  }

  const request = (async () => {
    const clerk = new Clerk(publishableKey);
    const clerkUi = await loadClerkUi(publishableKey);
    await clerk.load({ ui: { ClerkUI: clerkUi } });
    (
      window as unknown as {
        Clerk: BrowserClerkClient;
      }
    ).Clerk = clerk;
    return clerk;
  })();
  loading = request;
  try {
    return await request;
  } catch (error) {
    if (loading === request) {
      loading = undefined;
    }
    throw error;
  }
};
