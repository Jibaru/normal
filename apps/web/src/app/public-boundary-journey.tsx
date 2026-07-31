"use client";

import { useState } from "react";

declare global {
  interface Window {
    readonly Clerk?: {
      readonly session?: {
        readonly getToken: () => Promise<string | null>;
      };
    };
  }
}

interface PublicBoundaryJourneyProps {
  readonly endpoint: string;
}

type JourneyState = "idle" | "loading" | "signed_out" | "unavailable" | "ok";

export function PublicBoundaryJourney({
  endpoint,
}: PublicBoundaryJourneyProps) {
  const [state, setState] = useState<JourneyState>("idle");
  const [userId, setUserId] = useState<string | null>(null);

  const checkBoundary = async () => {
    setState("loading");

    try {
      const token = await window.Clerk?.session?.getToken();
      if (token === undefined || token === null) {
        setState("signed_out");
        return;
      }

      const response = await fetch(endpoint, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        setState("unavailable");
        return;
      }
      const body = (await response.json()) as { readonly user_id?: unknown };
      if (typeof body.user_id !== "string") {
        setState("unavailable");
        return;
      }
      setUserId(body.user_id);
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
        Check signed-in API access
      </button>
      <p aria-live="polite" data-testid="api-boundary-status">
        {state === "ok" ? `Connected as ${userId}` : state}
      </p>
    </section>
  );
}
