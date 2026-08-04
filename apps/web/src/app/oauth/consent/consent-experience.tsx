"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
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
    readonly number_suffix: string | null;
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
    const token = await session.getToken({
      skipCache: true,
    });
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
    <main className="min-h-screen bg-background px-6 py-12 text-foreground">
      <section className="mx-auto flex max-w-2xl flex-col gap-8">
        <p className="font-mono text-sm uppercase tracking-[0.2em] text-primary">
          MCP Authorization
        </p>
        {inspection === null ? (
          state === "loading" ? (
            <div aria-live="polite" className="flex flex-col gap-3">
              <span className="sr-only">Loading authorization</span>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-10 w-72" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <Alert variant="destructive">
              <AlertDescription>
                Authorization is temporarily unavailable.
              </AlertDescription>
            </Alert>
          )
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">Allow this MCP Client?</p>
              <h1 className="text-3xl font-semibold">
                {inspection.client.name}
              </h1>
            </div>

            <FieldSet>
              <FieldLegend>WhatsApp Connections</FieldLegend>
              <FieldGroup>
                {inspection.connections.map((connection) => (
                  <FieldLabel
                    aria-label={
                      connection.number_suffix === null
                        ? connection.label
                        : `${connection.label}, ending in ${connection.number_suffix}`
                    }
                    key={connection.connection_id}
                  >
                    <Field orientation="horizontal">
                      <Checkbox
                        checked={connections.includes(connection.connection_id)}
                        onCheckedChange={(checked) =>
                          setConnections(
                            toggle(
                              connections,
                              connection.connection_id,
                              checked,
                            ),
                          )
                        }
                      />
                      <span>{connection.label}</span>
                      {connection.number_suffix === null ? null : (
                        <span className="font-mono text-sm text-muted-foreground">
                          ending in {connection.number_suffix}
                        </span>
                      )}
                    </Field>
                  </FieldLabel>
                ))}
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Permissions</FieldLegend>
              <FieldGroup>
                {inspection.requested_scopes.map((scope) => (
                  <FieldLabel key={scope}>
                    <Field orientation="horizontal">
                      <Checkbox
                        checked={scopes.includes(scope)}
                        onCheckedChange={(checked) =>
                          setScopes(toggle(scopes, scope, checked))
                        }
                      />
                      {scopeLabels[scope] ?? scope}
                    </Field>
                  </FieldLabel>
                ))}
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Confirm authority</FieldLegend>
              <FieldGroup>
                <FieldLabel>
                  <Field orientation="horizontal">
                    <Checkbox
                      checked={readConfirmed}
                      onCheckedChange={setReadConfirmed}
                    />
                    Share selected read data
                  </Field>
                </FieldLabel>
                <FieldLabel>
                  <Field orientation="horizontal">
                    <Checkbox
                      checked={sendConfirmed}
                      onCheckedChange={setSendConfirmed}
                    />
                    Allow outbound sends
                  </Field>
                </FieldLabel>
              </FieldGroup>
            </FieldSet>

            <div className="flex gap-3">
              <Button
                disabled={!canApprove}
                onClick={() => void submit("approve")}
                type="button"
              >
                {state === "submitting" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                Approve
              </Button>
              <Button
                disabled={state === "submitting"}
                onClick={() => void submit("deny")}
                type="button"
                variant="outline"
              >
                Deny
              </Button>
            </div>
            {state === "unavailable" ? (
              <Alert variant="destructive">
                <AlertDescription>
                  Authorization is temporarily unavailable.
                </AlertDescription>
              </Alert>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
