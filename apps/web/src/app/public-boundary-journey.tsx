"use client";

import { makeIdempotencyKey } from "@whatsapp-mcp/contracts/handles";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { loadBrowserClerk } from "../clerk/browser";

interface PublicBoundaryJourneyProps {
  readonly clerkJwtTemplate: string;
  readonly clerkPublishableKey: string;
  readonly connectionsEndpoint: string;
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
  | "connecting"
  | "qr_available"
  | "connected"
  | "provisioned"
  | "provisioning_failed"
  | "provisioning_quarantined"
  | "replayed"
  | "invalid"
  | "number_unavailable"
  | "connection_limit_reached"
  | "unavailable";

interface SafeWhatsAppConnection {
  readonly displayName: string | null;
  readonly id: string;
  readonly numberSuffix: string;
  readonly state:
    | "connected"
    | "connecting"
    | "degraded"
    | "deleting"
    | "disconnected"
    | "reconnect_required";
  readonly stateChangedAt: string;
}

export function PublicBoundaryJourney({
  clerkJwtTemplate,
  clerkPublishableKey,
  connectionsEndpoint,
  connectionSetupEndpoint,
  personalAccountEndpoint,
}: PublicBoundaryJourneyProps) {
  const [state, setState] = useState<JourneyState>("idle");
  const [setupState, setSetupState] = useState<SetupState>("idle");
  const [connections, setConnections] = useState<
    ReadonlyArray<SafeWhatsAppConnection>
  >([]);
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const setupIntent = useRef<{
    readonly idempotencyKey: string;
    readonly whatsappNumber: string;
  } | null>(null);
  const activeQrImageUrl = useRef<string | null>(null);
  const observationGeneration = useRef(0);
  const observationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      observationGeneration.current += 1;
      if (observationTimer.current !== null) {
        clearTimeout(observationTimer.current);
      }
      if (activeQrImageUrl.current !== null) {
        URL.revokeObjectURL(activeQrImageUrl.current);
      }
    },
    [],
  );

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

  const replaceQrImage = (next: string | null) => {
    if (activeQrImageUrl.current !== null) {
      URL.revokeObjectURL(activeQrImageUrl.current);
    }
    activeQrImageUrl.current = next;
    setQrImageUrl(next);
  };

  const stopObserving = () => {
    observationGeneration.current += 1;
    if (observationTimer.current !== null) {
      clearTimeout(observationTimer.current);
      observationTimer.current = null;
    }
    replaceQrImage(null);
  };

  const loadConnections = async (token: string) => {
    const response = await fetch(connectionsEndpoint, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      readonly whatsapp_connections?: ReadonlyArray<{
        readonly display_name?: unknown;
        readonly id?: unknown;
        readonly number_suffix?: unknown;
        readonly state?: unknown;
        readonly state_changed_at?: unknown;
      }>;
    };
    if (!Array.isArray(body.whatsapp_connections)) return false;
    const parsed: SafeWhatsAppConnection[] = [];
    for (const connection of body.whatsapp_connections) {
      if (
        (connection.display_name !== null &&
          typeof connection.display_name !== "string") ||
        typeof connection.id !== "string" ||
        !/^con_[A-Za-z0-9_-]{21}$/u.test(connection.id) ||
        typeof connection.number_suffix !== "string" ||
        !/^[0-9]{4}$/u.test(connection.number_suffix) ||
        (connection.state !== "connected" &&
          connection.state !== "connecting" &&
          connection.state !== "degraded" &&
          connection.state !== "deleting" &&
          connection.state !== "disconnected" &&
          connection.state !== "reconnect_required") ||
        typeof connection.state_changed_at !== "string"
      ) {
        return false;
      }
      parsed.push({
        displayName: connection.display_name,
        id: connection.id,
        numberSuffix: connection.number_suffix,
        state: connection.state,
        stateChangedAt: connection.state_changed_at,
      });
    }
    setConnections(parsed);
    return true;
  };

  const observeSetup = async (
    setupId: string,
    generation: number,
  ): Promise<void> => {
    const isCurrent = () => observationGeneration.current === generation;
    const observeAgain = () => {
      observationTimer.current = setTimeout(() => {
        observationTimer.current = null;
        void observeSetup(setupId, generation);
      }, 750);
    };

    try {
      const token = await getToken();
      if (!isCurrent()) return;
      if (token === null) {
        replaceQrImage(null);
        setSetupState("unavailable");
        return;
      }
      const response = await fetch(`${connectionSetupEndpoint}/${setupId}/qr`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!isCurrent()) return;
      if (response.status === 200) {
        const image = await response.blob();
        if (!isCurrent()) return;
        replaceQrImage(URL.createObjectURL(image));
        setSetupState("qr_available");
        observeAgain();
        return;
      }
      if (response.status === 202) {
        replaceQrImage(null);
        setSetupState(
          response.headers.get("x-connection-setup-state") === "connecting"
            ? "connecting"
            : "pending",
        );
        observeAgain();
        return;
      }
      if (response.status === 204) {
        replaceQrImage(null);
        setSetupState("connected");
        if (!(await loadConnections(token))) {
          if (isCurrent()) setSetupState("unavailable");
        }
        return;
      }
      const body = (await response.json()) as { readonly error?: unknown };
      if (!isCurrent()) return;
      replaceQrImage(null);
      if (
        body.error === "provisioning_failed" ||
        body.error === "provisioning_quarantined"
      ) {
        setSetupState(body.error);
        return;
      }
      setSetupState("unavailable");
    } catch {
      if (isCurrent()) {
        replaceQrImage(null);
        setSetupState("unavailable");
      }
    }
  };

  const startObserving = (setupId: string) => {
    stopObserving();
    void observeSetup(setupId, observationGeneration.current);
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
      if (!(await loadConnections(token))) {
        setState("unavailable");
      }
    } catch {
      setState("unavailable");
    }
  };

  const startSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    stopObserving();
    const requestGeneration = observationGeneration.current;
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
      if (observationGeneration.current !== requestGeneration) return;
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
      if (observationGeneration.current !== requestGeneration) return;
      const body = (await response.json()) as {
        readonly connection_setup?: {
          readonly expires_at?: unknown;
          readonly id?: unknown;
          readonly idempotent_replay?: unknown;
          readonly state?: unknown;
        };
        readonly error?: unknown;
      };
      if (response.ok && body.connection_setup !== undefined) {
        const setup = body.connection_setup;
        if (
          typeof setup.expires_at === "string" &&
          typeof setup.id === "string" &&
          /^cst_[A-Za-z0-9_-]{21}$/u.test(setup.id)
        ) {
          if (setup.state === "pending") {
            setSetupState(
              setup.idempotent_replay === true ? "replayed" : "pending",
            );
            startObserving(setup.id);
            return;
          }
          if (
            setup.state === "provisioned" ||
            setup.state === "activated" ||
            setup.state === "provisioning_failed" ||
            setup.state === "provisioning_quarantined"
          ) {
            setSetupState(
              setup.state === "activated" ? "connected" : setup.state,
            );
            if (setup.state === "provisioned") {
              startObserving(setup.id);
            } else if (
              setup.state === "activated" &&
              !(await loadConnections(token)) &&
              observationGeneration.current === requestGeneration
            ) {
              setSetupState("unavailable");
            }
            return;
          }
        }
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
              disabled={setupState === "loading"}
              id="whatsapp-number"
              inputMode="tel"
              onChange={(event) => {
                stopObserving();
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
                : setupState === "qr_available"
                  ? "Scan this QR code with WhatsApp."
                  : setupState === "connecting"
                    ? "Waiting for WhatsApp to finish connecting."
                    : setupState === "connected"
                      ? "WhatsApp Connection active."
                      : setupState === "provisioned"
                        ? "Connection Setup is ready."
                        : setupState === "provisioning_failed"
                          ? "Connection Setup could not be prepared."
                          : setupState === "provisioning_quarantined"
                            ? "Connection Setup needs support review."
                            : setupState === "number_unavailable"
                              ? "That WhatsApp Number is already in use."
                              : setupState === "connection_limit_reached"
                                ? "Your Personal Account already has three active setup or Connection slots."
                                : setupState === "invalid"
                                  ? "Enter a valid international WhatsApp Number."
                                  : setupState}
          </p>
          {qrImageUrl === null ? null : (
            // The object URL is created from the authenticated, non-persisted
            // SVG response and is revoked as soon as setup completes.
            // biome-ignore lint/performance/noImgElement: QR bytes are already a complete generated SVG.
            <img
              alt="Scan this WhatsApp QR code"
              className="h-64 w-64 rounded bg-white p-3"
              src={qrImageUrl}
            />
          )}
        </form>
      ) : null}
      {state === "ok" ? (
        <section aria-label="WhatsApp Connections" className="space-y-3">
          <h2 className="text-xl font-semibold">WhatsApp Connections</h2>
          {connections.length === 0 ? (
            <p className="text-sm text-zinc-400">
              No WhatsApp Connections yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {connections.map((connection) => (
                <li
                  className="rounded-lg border border-zinc-800 bg-zinc-900 p-4"
                  data-testid="whatsapp-connection"
                  key={connection.id}
                >
                  <p className="font-medium">
                    {connection.displayName ?? "WhatsApp Connection"}
                  </p>
                  <p className="text-sm text-zinc-300">
                    Number ending {connection.numberSuffix}
                  </p>
                  <p className="text-sm capitalize text-emerald-400">
                    {connection.state.replace("_", " ")}
                  </p>
                  <time
                    className="text-xs text-zinc-500"
                    dateTime={connection.stateChangedAt}
                  >
                    State changed {connection.stateChangedAt}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </section>
  );
}
