"use client";

import { Clerk } from "@clerk/clerk-js";

export interface BrowserClerkClient {
  readonly loaded: boolean;
  readonly session:
    | {
        readonly getToken: (options: {
          readonly template: string;
        }) => Promise<string | null>;
      }
    | null
    | undefined;
  readonly openSignIn?: (() => void) | undefined;
}

let loading: Promise<BrowserClerkClient> | undefined;

const clerkFromWindow = (): BrowserClerkClient | undefined =>
  (window as unknown as { readonly Clerk?: BrowserClerkClient }).Clerk;

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
    await clerk.load();
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
