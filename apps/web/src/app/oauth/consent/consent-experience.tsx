"use client";

import { useEffect, useState } from "react";
import { loadBrowserClerk } from "../../../clerk/browser";

interface ConsentExperienceProps {
  readonly clerkJwtTemplate: string;
  readonly clerkPublishableKey: string;
  readonly decisionEndpoint: string;
  readonly inspectEndpoint: string;
  readonly request: string;
}

interface Inspection {
  readonly client: { readonly name: string };
  readonly connections: ReadonlyArray<{
    readonly connection_id: string;
    readonly label: string;
  }>;
  readonly presentation: string;
  readonly requested_scopes: ReadonlyArray<string>;
}

const scopeLabels: Readonly<Record<string, string>> = {
  "connections:read": "Read connection details",
  "directory:read": "Read WhatsApp Directory",
  "messages:read": "Read Stored Messages",
  "messages:send": "Send messages",
};

const recentFirstFactor = (
  factorVerificationAge: [number, number] | null | undefined,
): boolean =>
  factorVerificationAge !== null &&
  factorVerificationAge !== undefined &&
  Number.isSafeInteger(factorVerificationAge[0]) &&
  factorVerificationAge[0] >= 0 &&
  factorVerificationAge[0] < 5;

export function ConsentExperience({
  clerkJwtTemplate,
  clerkPublishableKey,
  decisionEndpoint,
  inspectEndpoint,
  request,
}: ConsentExperienceProps) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [connections, setConnections] = useState<ReadonlyArray<string>>([]);
  const [scopes, setScopes] = useState<ReadonlyArray<string>>([]);
  const [readConfirmed, setReadConfirmed] = useState(false);
  const [sendConfirmed, setSendConfirmed] = useState(false);
  const [state, setState] = useState<
    "loading" | "ready" | "submitting" | "unavailable"
  >("loading");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const clerk = await loadBrowserClerk(clerkPublishableKey);
        const token = await clerk.session?.getToken({
          template: clerkJwtTemplate,
        });
        if (!token) {
          clerk.openSignIn?.();
          throw new Error("signed out");
        }
        const response = await fetch(inspectEndpoint, {
          body: JSON.stringify({ request }),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "POST",
        });
        if (!response.ok) throw new Error("inspection unavailable");
        const body = (await response.json()) as Inspection;
        if (
          typeof body.client?.name !== "string" ||
          typeof body.presentation !== "string" ||
          !Array.isArray(body.connections) ||
          !Array.isArray(body.requested_scopes)
        ) {
          throw new Error("invalid inspection");
        }
        if (active) {
          setInspection(body);
          setState("ready");
        }
      } catch {
        if (active) setState("unavailable");
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [clerkJwtTemplate, clerkPublishableKey, inspectEndpoint, request]);

  const tokenAfterRecentVerification = async (): Promise<string> => {
    const clerk = await loadBrowserClerk(clerkPublishableKey);
    const session = clerk.session;
    if (!session) throw new Error("signed out");
    if (!recentFirstFactor(session.factorVerificationAge)) {
      if (!clerk.__internal_openReverification) {
        throw new Error("reverification unavailable");
      }
      await new Promise<void>((resolve, reject) => {
        clerk.__internal_openReverification?.({
          afterVerification: resolve,
          afterVerificationCancelled: () =>
            reject(new Error("reverification cancelled")),
          level: "first_factor",
        });
      });
    }
    session.clearCache?.();
    const token = await session.getToken({ template: clerkJwtTemplate });
    if (!token) throw new Error("token unavailable");
    return token;
  };

  const submit = async (decision: "approve" | "deny") => {
    if (!inspection) return;
    setState("submitting");
    try {
      const clerk = await loadBrowserClerk(clerkPublishableKey);
      const token =
        decision === "approve"
          ? await tokenAfterRecentVerification()
          : await clerk.session?.getToken({ template: clerkJwtTemplate });
      if (!token) throw new Error("token unavailable");
      const response = await fetch(decisionEndpoint, {
        body: JSON.stringify(
          decision === "deny"
            ? {
                decision,
                presentation: inspection.presentation,
                request,
              }
            : {
                connection_ids: connections,
                decision,
                presentation: inspection.presentation,
                read_confirmed: readConfirmed,
                request,
                scopes,
                send_confirmed: sendConfirmed,
              },
        ),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = (await response.json()) as {
        readonly redirect_to?: unknown;
      };
      if (!response.ok || typeof body.redirect_to !== "string") {
        throw new Error("decision unavailable");
      }
      window.location.assign(body.redirect_to);
    } catch {
      setState("unavailable");
    }
  };

  const toggle = (
    selected: ReadonlyArray<string>,
    value: string,
    checked: boolean,
  ): ReadonlyArray<string> =>
    checked ? [...selected, value] : selected.filter((item) => item !== value);
  const hasRead = scopes.some((scope) => scope !== "messages:send");
  const hasSend = scopes.includes("messages:send");
  const canApprove =
    state === "ready" &&
    connections.length > 0 &&
    scopes.length > 0 &&
    (!hasRead || readConfirmed) &&
    (!hasSend || sendConfirmed);

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <section className="mx-auto max-w-2xl space-y-8">
        <p className="font-mono text-sm uppercase tracking-[0.2em] text-emerald-400">
          MCP Authorization
        </p>
        {inspection === null ? (
          <p aria-live="polite">
            {state === "loading" ? "Loading authorization…" : "unavailable"}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-zinc-400">Allow this MCP Client?</p>
              <h1 className="text-3xl font-semibold">
                {inspection.client.name}
              </h1>
            </div>

            <fieldset className="space-y-3">
              <legend className="text-lg font-medium">
                WhatsApp Connections
              </legend>
              {inspection.connections.map((connection) => (
                <label
                  className="flex gap-3 rounded border border-zinc-800 p-4"
                  key={connection.connection_id}
                >
                  <input
                    checked={connections.includes(connection.connection_id)}
                    onChange={(event) =>
                      setConnections(
                        toggle(
                          connections,
                          connection.connection_id,
                          event.currentTarget.checked,
                        ),
                      )
                    }
                    type="checkbox"
                  />
                  {connection.label}
                </label>
              ))}
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-lg font-medium">Permissions</legend>
              {inspection.requested_scopes.map((scope) => (
                <label
                  className="flex gap-3 rounded border border-zinc-800 p-4"
                  key={scope}
                >
                  <input
                    checked={scopes.includes(scope)}
                    onChange={(event) =>
                      setScopes(
                        toggle(scopes, scope, event.currentTarget.checked),
                      )
                    }
                    type="checkbox"
                  />
                  {scopeLabels[scope] ?? scope}
                </label>
              ))}
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-lg font-medium">Confirm authority</legend>
              <label className="flex gap-3 rounded border border-zinc-800 p-4">
                <input
                  checked={readConfirmed}
                  onChange={(event) =>
                    setReadConfirmed(event.currentTarget.checked)
                  }
                  type="checkbox"
                />
                Share selected read data
              </label>
              <label className="flex gap-3 rounded border border-zinc-800 p-4">
                <input
                  checked={sendConfirmed}
                  onChange={(event) =>
                    setSendConfirmed(event.currentTarget.checked)
                  }
                  type="checkbox"
                />
                Allow outbound sends
              </label>
            </fieldset>

            <div className="flex gap-3">
              <button
                className="rounded bg-emerald-400 px-5 py-2 font-medium text-zinc-950 disabled:opacity-50"
                disabled={!canApprove}
                onClick={() => void submit("approve")}
                type="button"
              >
                Approve
              </button>
              <button
                className="rounded border border-zinc-700 px-5 py-2 disabled:opacity-50"
                disabled={state === "submitting"}
                onClick={() => void submit("deny")}
                type="button"
              >
                Deny
              </button>
            </div>
            <p aria-live="polite">{state === "unavailable" ? state : ""}</p>
          </>
        )}
      </section>
    </main>
  );
}
