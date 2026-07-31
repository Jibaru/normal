"use client";

import { useState } from "react";
import { loadBrowserClerk } from "../clerk/browser";

interface PublicBoundaryJourneyProps {
  readonly clerkJwtTemplate: string;
  readonly clerkPublishableKey: string;
  readonly endpoint: string;
}

type JourneyState = "idle" | "loading" | "signed_out" | "unavailable" | "ok";

export function PublicBoundaryJourney({
  clerkJwtTemplate,
  clerkPublishableKey,
  endpoint,
}: PublicBoundaryJourneyProps) {
  const [state, setState] = useState<JourneyState>("idle");
  const checkBoundary = async () => {
    setState("loading");

    try {
      const clerk = await loadBrowserClerk(clerkPublishableKey);
      const token = await clerk.session?.getToken({
        template: clerkJwtTemplate,
      });
      if (token === undefined || token === null) {
        clerk.openSignIn?.();
        setState("signed_out");
        return;
      }

      const response = await fetch(endpoint, {
        headers: {
          authorization: `Bearer ${token}`,
        },
        method: "POST",
      });
      if (!response.ok) {
        setState("unavailable");
        return;
      }
      const body = (await response.json()) as {
        readonly personal_account?: {
          readonly state?: unknown;
          readonly stored_media_limit_bytes?: unknown;
          readonly whatsapp_connection_limit?: unknown;
        };
      };
      if (
        body.personal_account?.state !== "active" ||
        body.personal_account.whatsapp_connection_limit !== 3 ||
        body.personal_account.stored_media_limit_bytes !== 5_368_709_120
      ) {
        setState("unavailable");
        return;
      }
      setState("ok");
    } catch {
      setState("unavailable");
    }
  };

  return (
    <section aria-label="Signed-in API boundary" className="space-y-3">
      <button
        className="rounded bg-emerald-400 px-4 py-2 font-medium text-zinc-950 disabled:opacity-60"
        disabled={state === "loading"}
        onClick={checkBoundary}
        type="button"
      >
        Bootstrap Personal Account
      </button>
      <p aria-live="polite" data-testid="api-boundary-status">
        {state === "ok" ? "Personal Account ready" : state}
      </p>
    </section>
  );
}
