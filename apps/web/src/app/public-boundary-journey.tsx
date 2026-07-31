"use client";

import { makeIdempotencyKey } from "@whatsapp-mcp/contracts/handles";
import { type FormEvent, useRef, useState } from "react";
import { loadBrowserClerk } from "../clerk/browser";

interface PublicBoundaryJourneyProps {
  readonly clerkJwtTemplate: string;
  readonly clerkPublishableKey: string;
  readonly connectionSetupEndpoint: string;
  readonly mcpAuthorizationsEndpoint: string;
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
  | "provisioned"
  | "provisioning_failed"
  | "provisioning_quarantined"
  | "replayed"
  | "invalid"
  | "number_unavailable"
  | "connection_limit_reached"
  | "unavailable";

interface McpAuthorization {
  readonly client: {
    readonly id: string;
    readonly name: string;
  };
  readonly connectionIds: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly expiryState: "active" | "expired";
  readonly id: string;
  readonly revocationState: "active" | "revoked";
  readonly revokedAt: string | null;
  readonly scopes: ReadonlyArray<
    "connections:read" | "directory:read" | "messages:read" | "messages:send"
  >;
}

type AuthorizationState = "idle" | "loading" | "ok" | "unavailable";

const scopeLabels: Record<McpAuthorization["scopes"][number], string> = {
  "connections:read": "Connection metadata",
  "directory:read": "WhatsApp Directory",
  "messages:read": "Stored Messages",
  "messages:send": "Send messages",
};

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const decodeMcpAuthorizations = (
  value: unknown,
): ReadonlyArray<McpAuthorization> | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Array.isArray(
      (value as { readonly mcp_authorizations?: unknown }).mcp_authorizations,
    )
  ) {
    return null;
  }
  const decoded: Array<McpAuthorization> = [];
  for (const candidate of (
    value as { readonly mcp_authorizations: ReadonlyArray<unknown> }
  ).mcp_authorizations) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const authorization = candidate as Record<string, unknown>;
    const client = authorization.client;
    const scopes = authorization.scopes;
    const connectionIds = authorization.connection_ids;
    if (
      typeof client !== "object" ||
      client === null ||
      Array.isArray(client) ||
      typeof (client as Record<string, unknown>).id !== "string" ||
      typeof (client as Record<string, unknown>).name !== "string" ||
      !Array.isArray(connectionIds) ||
      connectionIds.some(
        (connectionId) =>
          typeof connectionId !== "string" ||
          !/^con_[A-Za-z0-9_-]{21}$/u.test(connectionId),
      ) ||
      !Array.isArray(scopes) ||
      scopes.some(
        (scope) =>
          typeof scope !== "string" || !Object.hasOwn(scopeLabels, scope),
      ) ||
      typeof authorization.id !== "string" ||
      !/^mca_[A-Za-z0-9_-]{21}$/u.test(authorization.id) ||
      !isIsoDate(authorization.created_at) ||
      !isIsoDate(authorization.expires_at) ||
      (authorization.expiry_state !== "active" &&
        authorization.expiry_state !== "expired") ||
      (authorization.revocation_state !== "active" &&
        authorization.revocation_state !== "revoked") ||
      (authorization.revoked_at !== null &&
        !isIsoDate(authorization.revoked_at))
    ) {
      return null;
    }
    decoded.push({
      client: {
        id: (client as { readonly id: string }).id,
        name: (client as { readonly name: string }).name,
      },
      connectionIds: connectionIds as ReadonlyArray<string>,
      createdAt: authorization.created_at,
      expiresAt: authorization.expires_at,
      expiryState: authorization.expiry_state,
      id: authorization.id,
      revocationState: authorization.revocation_state,
      revokedAt: authorization.revoked_at,
      scopes: scopes as McpAuthorization["scopes"],
    });
  }
  return decoded;
};

const displayTime = (value: string): string =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));

export function PublicBoundaryJourney({
  clerkJwtTemplate,
  clerkPublishableKey,
  connectionSetupEndpoint,
  mcpAuthorizationsEndpoint,
  personalAccountEndpoint,
}: PublicBoundaryJourneyProps) {
  const [state, setState] = useState<JourneyState>("idle");
  const [setupState, setSetupState] = useState<SetupState>("idle");
  const [authorizationState, setAuthorizationState] =
    useState<AuthorizationState>("idle");
  const [authorizations, setAuthorizations] = useState<
    ReadonlyArray<McpAuthorization>
  >([]);
  const [revokingAuthorization, setRevokingAuthorization] = useState<
    string | null
  >(null);
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
      setAuthorizationState("loading");
      try {
        const authorizationsResponse = await fetch(mcpAuthorizationsEndpoint, {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        const authorizationsBody = await authorizationsResponse.json();
        const decodedAuthorizations =
          decodeMcpAuthorizations(authorizationsBody);
        if (!authorizationsResponse.ok || decodedAuthorizations === null) {
          setAuthorizationState("unavailable");
          return;
        }
        setAuthorizations(decodedAuthorizations);
        setAuthorizationState("ok");
      } catch {
        setAuthorizationState("unavailable");
      }
    } catch {
      setState("unavailable");
      setAuthorizationState("unavailable");
    }
  };

  const revokeAuthorization = async (authorization: McpAuthorization) => {
    setRevokingAuthorization(authorization.id);
    try {
      const token = await getToken();
      if (token === null) {
        setAuthorizationState("unavailable");
        return;
      }
      const response = await fetch(
        `${mcpAuthorizationsEndpoint}/${encodeURIComponent(authorization.id)}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
          },
          method: "DELETE",
        },
      );
      const body = (await response.json()) as {
        readonly mcp_authorization?: {
          readonly id?: unknown;
          readonly revocation_state?: unknown;
          readonly revoked_at?: unknown;
        };
      };
      const revoked = body.mcp_authorization;
      if (
        !response.ok ||
        revoked?.id !== authorization.id ||
        revoked.revocation_state !== "revoked" ||
        !isIsoDate(revoked.revoked_at)
      ) {
        setAuthorizationState("unavailable");
        return;
      }
      setAuthorizations((current) =>
        current.map((item) =>
          item.id === authorization.id
            ? {
                ...item,
                revocationState: "revoked",
                revokedAt: revoked.revoked_at as string,
              }
            : item,
        ),
      );
    } catch {
      setAuthorizationState("unavailable");
    } finally {
      setRevokingAuthorization(null);
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
            return;
          }
          if (
            setup.state === "provisioned" ||
            setup.state === "provisioning_failed" ||
            setup.state === "provisioning_quarantined"
          ) {
            setSetupState(setup.state);
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
        <>
          <section
            aria-label="MCP Authorizations"
            className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4"
          >
            <div>
              <h2 className="text-lg font-medium">MCP Authorizations</h2>
              <p className="text-sm text-zinc-400">
                Review and revoke access held by approved MCP Clients.
              </p>
            </div>
            {authorizationState === "loading" ? (
              <p aria-live="polite">Loading MCP Authorizations…</p>
            ) : authorizationState === "unavailable" ? (
              <p aria-live="polite">
                MCP Authorizations are temporarily unavailable.
              </p>
            ) : authorizations.length === 0 ? (
              <p>No MCP Clients currently have access.</p>
            ) : (
              <ul className="space-y-3">
                {authorizations.map((authorization) => {
                  const stateLabel =
                    authorization.revocationState === "revoked"
                      ? "Revoked"
                      : authorization.expiryState === "expired"
                        ? "Expired"
                        : "Active";
                  return (
                    <li
                      className="space-y-3 rounded border border-zinc-700 bg-zinc-950 p-4"
                      key={authorization.id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-medium">
                            {authorization.client.name}
                          </h3>
                          <p className="font-mono text-xs text-zinc-500">
                            {authorization.client.id}
                          </p>
                        </div>
                        <span
                          className="rounded-full border border-zinc-700 px-2 py-1 text-xs"
                          data-testid="mcp-authorization-state"
                        >
                          {stateLabel}
                        </span>
                      </div>
                      <dl className="grid gap-2 text-sm sm:grid-cols-2">
                        <div>
                          <dt className="text-zinc-500">Created</dt>
                          <dd>
                            <time dateTime={authorization.createdAt}>
                              {displayTime(authorization.createdAt)} UTC
                            </time>
                          </dd>
                        </div>
                        <div>
                          <dt className="text-zinc-500">Expires</dt>
                          <dd>
                            <time dateTime={authorization.expiresAt}>
                              {displayTime(authorization.expiresAt)} UTC
                            </time>
                          </dd>
                        </div>
                      </dl>
                      <div className="space-y-1">
                        <p className="text-sm text-zinc-500">
                          WhatsApp Connections
                        </p>
                        <ul className="space-y-1 font-mono text-xs">
                          {authorization.connectionIds.map((connectionId) => (
                            <li key={connectionId}>{connectionId}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm text-zinc-500">Permissions</p>
                        <ul className="flex flex-wrap gap-2 text-xs">
                          {authorization.scopes.map((scope) => (
                            <li
                              className="rounded bg-zinc-800 px-2 py-1"
                              key={scope}
                            >
                              {scopeLabels[scope]}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <button
                        aria-label={`Revoke ${authorization.client.name}`}
                        className="rounded border border-red-500 px-3 py-2 text-sm text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={
                          authorization.revocationState === "revoked" ||
                          revokingAuthorization === authorization.id
                        }
                        onClick={() => revokeAuthorization(authorization)}
                        type="button"
                      >
                        {revokingAuthorization === authorization.id
                          ? "Revoking…"
                          : "Revoke access"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
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
          </form>
        </>
      ) : null}
    </section>
  );
}
