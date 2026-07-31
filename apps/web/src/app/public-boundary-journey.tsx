"use client";

import { makeIdempotencyKey } from "@whatsapp-mcp/contracts/handles";
import { type FormEvent, useRef, useState } from "react";
import { loadBrowserClerk } from "../clerk/browser";

interface PublicBoundaryJourneyProps {
  readonly clerkJwtTemplate: string;
  readonly clerkPublishableKey: string;
  readonly connectionSetupEndpoint: string;
  readonly personalAccountEndpoint: string;
}

type JourneyState =
  | "idle"
  | "loading"
  | "signed_out"
  | "unavailable"
  | "waitlisted"
  | "ok";

type SetupState =
  | "idle"
  | "loading"
  | "pending"
  | "replayed"
  | "invalid"
  | "number_unavailable"
  | "connection_limit_reached"
  | "unavailable";

export function PublicBoundaryJourney({
  clerkJwtTemplate,
  clerkPublishableKey,
  connectionSetupEndpoint,
  personalAccountEndpoint,
}: PublicBoundaryJourneyProps) {
  const [state, setState] = useState<JourneyState>("idle");
  const [setupState, setSetupState] = useState<SetupState>("idle");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const setupIntent = useRef<{
    readonly idempotencyKey: string;
    readonly whatsappNumber: string;
  } | null>(null);

  const getToken = async () => {
    const clerk = await loadBrowserClerk(clerkPublishableKey);
    const token = await clerk.session?.getToken({
      template: clerkJwtTemplate,
    });
    if (token === undefined || token === null) {
      clerk.openSignIn?.();
      return null;
    }
    return token;
  };

  const checkBoundary = async () => {
    setState("loading");

    try {
      const token = await getToken();
      if (token === null) {
        setState("signed_out");
        return;
      }

      const response = await fetch(personalAccountEndpoint, {
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
        readonly admission?: {
          readonly state?: unknown;
        };
        readonly personal_account?: {
          readonly message_retention_days?: unknown;
          readonly state?: unknown;
          readonly stored_media_limit_bytes?: unknown;
          readonly whatsapp_connection_limit?: unknown;
        };
      };
      if (body.admission?.state === "waitlisted") {
        setState("waitlisted");
        return;
      }
      if (
        body.personal_account?.state !== "active" ||
        body.personal_account.message_retention_days !== 30 ||
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

  const startSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSetupState("loading");

    const intent =
      setupIntent.current?.whatsappNumber === whatsappNumber
        ? setupIntent.current
        : {
            idempotencyKey: String(makeIdempotencyKey()),
            whatsappNumber,
          };
    setupIntent.current = intent;

    try {
      const token = await getToken();
      if (token === null) {
        setSetupState("unavailable");
        return;
      }
      const response = await fetch(connectionSetupEndpoint, {
        body: JSON.stringify({
          idempotency_key: intent.idempotencyKey,
          whatsapp_number: intent.whatsappNumber,
        }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = (await response.json()) as {
        readonly connection_setup?: {
          readonly expires_at?: unknown;
          readonly id?: unknown;
          readonly idempotent_replay?: unknown;
          readonly state?: unknown;
        };
        readonly error?: unknown;
      };
      if (
        response.ok &&
        body.connection_setup?.state === "pending" &&
        typeof body.connection_setup.expires_at === "string" &&
        typeof body.connection_setup.id === "string" &&
        /^cst_[A-Za-z0-9_-]{21}$/u.test(body.connection_setup.id)
      ) {
        setSetupState(
          body.connection_setup.idempotent_replay === true
            ? "replayed"
            : "pending",
        );
        return;
      }
      if (body.error === "invalid_request") {
        setSetupState("invalid");
        return;
      }
      if (
        body.error === "whatsapp_number_unavailable" ||
        body.error === "connection_limit_reached"
      ) {
        setSetupState(
          body.error === "whatsapp_number_unavailable"
            ? "number_unavailable"
            : body.error,
        );
        return;
      }
      setSetupState("unavailable");
    } catch {
      setSetupState("unavailable");
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
        {state === "ok"
          ? "Personal Account ready"
          : state === "waitlisted"
            ? "You’re on the private-beta waitlist"
            : state}
      </p>
      {state === "ok" ? (
        <form
          className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4"
          onSubmit={startSetup}
        >
          <div className="space-y-1">
            <label
              className="block text-sm font-medium"
              htmlFor="whatsapp-number"
            >
              WhatsApp Number
            </label>
            <input
              autoComplete="tel"
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2"
              id="whatsapp-number"
              inputMode="tel"
              onChange={(event) => {
                setWhatsappNumber(event.target.value);
                setSetupState("idle");
              }}
              placeholder="+1 555 012 3456"
              required
              type="tel"
              value={whatsappNumber}
            />
            <p className="text-sm text-zinc-400">
              Include the country code. Your setup expires after 15 minutes.
            </p>
          </div>
          <button
            className="rounded bg-emerald-400 px-4 py-2 font-medium text-zinc-950 disabled:opacity-60"
            disabled={setupState === "loading"}
            type="submit"
          >
            Start Connection Setup
          </button>
          <p aria-live="polite" data-testid="connection-setup-status">
            {setupState === "pending"
              ? "Connection Setup started. Preparing your QR code."
              : setupState === "replayed"
                ? "Connection Setup already started. Preparing your QR code."
                : setupState === "number_unavailable"
                  ? "That WhatsApp Number is already in use."
                  : setupState === "connection_limit_reached"
                    ? "Your Personal Account already has three active setup or Connection slots."
                    : setupState === "invalid"
                      ? "Enter a valid international WhatsApp Number."
                      : setupState}
          </p>
        </form>
      ) : null}
    </section>
  );
}
