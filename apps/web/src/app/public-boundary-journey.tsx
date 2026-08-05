"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import { makeIdempotencyKey } from "@whatsapp-mcp/contracts/handles";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

interface PublicBoundaryJourneyProps {
  readonly clerkJwtTemplate: string;
  readonly connectionsEndpoint: string;
  readonly connectionSetupEndpoint: string;
  readonly mcpAuthorizationsEndpoint: string;
  readonly personalAccountEndpoint: string;
  readonly personalAccountDeletionEndpoint: string;
  readonly toolCallLogsEndpoint: string;
}

type JourneyState =
  | "idle"
  | "loading"
  | "signed_out"
  | "unavailable"
  | "waitlisted"
  | "ok";

type SetupState =
  | "cancelled"
  | "cancelling"
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
  | "expired"
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

interface ToolCallLog {
  readonly capability: string;
  readonly client: { readonly id: string; readonly name: string };
  readonly completedAt: string | null;
  readonly counts: {
    readonly mediaBytes: number;
    readonly results: number | null;
  };
  readonly errorCode: string | null;
  readonly latencyMs: number | null;
  readonly outcome:
    | "started"
    | "success"
    | "execution_error"
    | "rate_limited"
    | "authorization_denied";
  readonly references: ReadonlyArray<string>;
  readonly startedAt: string;
}

interface ToolCallLogPage {
  readonly logs: ReadonlyArray<ToolCallLog>;
  readonly nextCursor: string | null;
}

const decodeToolCallLogs = (value: unknown): ToolCallLogPage | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { tool_call_logs?: unknown }).tool_call_logs)
  ) {
    return null;
  }
  const nextCursor = (value as { next_cursor?: unknown }).next_cursor;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== "string" ||
      !/^tcl_[A-Za-z0-9_-]{21}$/u.test(nextCursor))
  ) {
    return null;
  }
  const decoded: ToolCallLog[] = [];
  for (const candidate of (value as { tool_call_logs: unknown[] })
    .tool_call_logs) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const log = candidate as Record<string, unknown>;
    const client = log.client as Record<string, unknown> | undefined;
    const counts = log.counts as Record<string, unknown> | undefined;
    const references = log.references as Record<string, unknown> | undefined;
    if (
      typeof log.capability !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(log.capability) ||
      typeof client?.id !== "string" ||
      typeof client.name !== "string" ||
      (log.completed_at !== null && !isIsoDate(log.completed_at)) ||
      typeof counts?.media_bytes !== "number" ||
      (counts.results !== null && typeof counts.results !== "number") ||
      (log.error_code !== null && typeof log.error_code !== "string") ||
      (log.latency_ms !== null && typeof log.latency_ms !== "number") ||
      (log.outcome !== "started" &&
        log.outcome !== "success" &&
        log.outcome !== "execution_error" &&
        log.outcome !== "rate_limited" &&
        log.outcome !== "authorization_denied") ||
      typeof references !== "object" ||
      references === null ||
      typeof references.mcp_authorization_id !== "string" ||
      !/^mca_[A-Za-z0-9_-]{21}$/u.test(references.mcp_authorization_id) ||
      (references.whatsapp_connection_id !== null &&
        (typeof references.whatsapp_connection_id !== "string" ||
          !/^con_[A-Za-z0-9_-]{21}$/u.test(
            references.whatsapp_connection_id,
          ))) ||
      (references.send_id !== null &&
        (typeof references.send_id !== "string" ||
          !/^snd_[A-Za-z0-9_-]{21}$/u.test(references.send_id))) ||
      !isIsoDate(log.started_at)
    ) {
      return null;
    }
    decoded.push({
      capability: log.capability,
      client: { id: client.id, name: client.name },
      completedAt: log.completed_at,
      counts: { mediaBytes: counts.media_bytes, results: counts.results },
      errorCode: log.error_code,
      latencyMs: log.latency_ms,
      outcome: log.outcome,
      references: [
        references.mcp_authorization_id,
        ...(typeof references.whatsapp_connection_id === "string"
          ? [references.whatsapp_connection_id]
          : []),
        ...(typeof references.send_id === "string" ? [references.send_id] : []),
      ],
      startedAt: log.started_at,
    });
  }
  return { logs: decoded, nextCursor };
};

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

type SetupCleanupState = "complete" | "pending" | "retrying";

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
  readonly retentionDays: number | null;
  readonly retentionOptions: ReadonlyArray<number>;
}

const decodeSafeWhatsAppConnection = (
  connection: Record<string, unknown>,
): SafeWhatsAppConnection | null => {
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
    return null;
  }
  return {
    displayName: connection.display_name,
    id: connection.id,
    numberSuffix: connection.number_suffix,
    state: connection.state,
    stateChangedAt: connection.state_changed_at,
    retentionDays: 30,
    retentionOptions: [],
  };
};

export function PublicBoundaryJourney({
  clerkJwtTemplate,
  connectionsEndpoint,
  connectionSetupEndpoint,
  mcpAuthorizationsEndpoint,
  personalAccountEndpoint,
  personalAccountDeletionEndpoint,
  toolCallLogsEndpoint,
}: PublicBoundaryJourneyProps) {
  const { getToken: getClerkToken, isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const [identityUnavailable, setIdentityUnavailable] = useState(false);
  const identityState = identityUnavailable
    ? "unavailable"
    : !isLoaded
      ? "loading"
      : isSignedIn
        ? "signed_in"
        : "signed_out";
  const [state, setState] = useState<JourneyState>("idle");
  const [setupState, setSetupState] = useState<SetupState>("idle");
  const [authorizationState, setAuthorizationState] =
    useState<AuthorizationState>("idle");
  const [authorizations, setAuthorizations] = useState<
    ReadonlyArray<McpAuthorization>
  >([]);
  const [toolCallLogState, setToolCallLogState] =
    useState<AuthorizationState>("idle");
  const [toolCallLogs, setToolCallLogs] = useState<ReadonlyArray<ToolCallLog>>(
    [],
  );
  const [toolCallLogCursor, setToolCallLogCursor] = useState<string | null>(
    null,
  );
  const [toolCallLogPageState, setToolCallLogPageState] = useState<
    "idle" | "loading" | "unavailable"
  >("idle");
  const [revokingAuthorization, setRevokingAuthorization] = useState<
    string | null
  >(null);
  const [setupCleanupState, setSetupCleanupState] =
    useState<SetupCleanupState | null>(null);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [connections, setConnections] = useState<
    ReadonlyArray<SafeWhatsAppConnection>
  >([]);
  const [connectionLifecycleAction, setConnectionLifecycleAction] = useState<
    string | null
  >(null);
  const [connectionLifecycleStatus, setConnectionLifecycleStatus] = useState<
    Readonly<Record<string, string>>
  >({});
  const [retentionDrafts, setRetentionDrafts] = useState<
    Readonly<Record<string, string>>
  >({});
  const [retentionAcknowledgements, setRetentionAcknowledgements] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [retentionStatus, setRetentionStatus] = useState<
    Readonly<Record<string, string>>
  >({});
  const [reconnectQr, setReconnectQr] = useState<{
    readonly connectionId: string;
    readonly url: string;
  } | null>(null);
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [deletionState, setDeletionState] = useState<
    "idle" | "deleting" | "unavailable"
  >("idle");
  const setupIntent = useRef<{
    readonly idempotencyKey: string;
    readonly whatsappNumber: string;
  } | null>(null);
  const activeQrImageUrl = useRef<string | null>(null);
  const activeReconnectQrUrl = useRef<string | null>(null);
  const lifecycleGeneration = useRef(0);
  const lifecycleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      lifecycleGeneration.current += 1;
      if (lifecycleTimer.current !== null) {
        clearTimeout(lifecycleTimer.current);
      }
      if (activeReconnectQrUrl.current !== null) {
        URL.revokeObjectURL(activeReconnectQrUrl.current);
      }
    },
    [],
  );

  const getToken = () => getClerkToken({ template: clerkJwtTemplate });

  const openSignIn = async () => {
    try {
      await clerk.openSignIn();
    } catch {
      setIdentityUnavailable(true);
    }
  };

  const openWaitlist = async () => {
    try {
      await clerk.openWaitlist();
    } catch {
      setIdentityUnavailable(true);
    }
  };

  const loadMoreToolCallLogs = async () => {
    if (toolCallLogCursor === null || toolCallLogPageState === "loading")
      return;
    setToolCallLogPageState("loading");
    try {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      const nextPageUrl = new URL(toolCallLogsEndpoint);
      nextPageUrl.searchParams.set("cursor", toolCallLogCursor);
      const response = await fetch(nextPageUrl, {
        headers: { authorization: `Bearer ${token}` },
      });
      const page = decodeToolCallLogs(await response.json());
      if (!response.ok || page === null) throw new Error("logs unavailable");
      setToolCallLogs((current) => [...current, ...page.logs]);
      setToolCallLogCursor(page.nextCursor);
      setToolCallLogPageState("idle");
    } catch {
      setToolCallLogPageState("unavailable");
    }
  };

  const deletePersonalAccount = async () => {
    if (
      !window.confirm(
        "Permanently delete your Personal Account and every WhatsApp Connection? This cannot be undone.",
      )
    )
      return;
    setDeletionState("deleting");
    try {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      const deletion = await fetch(personalAccountDeletionEndpoint, {
        headers: { authorization: `Bearer ${token}` },
        method: "DELETE",
      });
      const body = (await deletion.json()) as {
        readonly personal_account?: { readonly state?: unknown };
      };
      if (
        deletion.status !== 202 ||
        body.personal_account?.state !== "deleting"
      ) {
        throw new Error("deletion unavailable");
      }
      setState("signed_out");
    } catch {
      setDeletionState("unavailable");
    }
  };

  const replaceQrImage = (next: string | null) => {
    if (activeQrImageUrl.current !== null) {
      URL.revokeObjectURL(activeQrImageUrl.current);
    }
    activeQrImageUrl.current = next;
    setQrImageUrl(next);
  };

  const replaceReconnectQr = (
    next: { readonly connectionId: string; readonly url: string } | null,
  ) => {
    if (activeReconnectQrUrl.current !== null) {
      URL.revokeObjectURL(activeReconnectQrUrl.current);
    }
    activeReconnectQrUrl.current = next?.url ?? null;
    setReconnectQr(next);
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
      const decoded = decodeSafeWhatsAppConnection(connection);
      if (decoded === null) return false;
      parsed.push(decoded);
    }
    const withPolicies = await Promise.all(
      parsed.map(async (connection) => {
        const response = await fetch(
          `${connectionsEndpoint}/${encodeURIComponent(connection.id)}/retention-policy`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (!response.ok) throw new Error("retention unavailable");
        const body = (await response.json()) as {
          readonly allowed_days?: unknown;
          readonly policy?: { readonly days?: unknown };
        };
        if (
          !Array.isArray(body.allowed_days) ||
          body.allowed_days.some((day) => typeof day !== "number") ||
          (body.policy?.days !== null && typeof body.policy?.days !== "number")
        )
          throw new Error("invalid retention policy");
        return {
          ...connection,
          retentionDays: body.policy.days as number | null,
          retentionOptions: body.allowed_days as number[],
        };
      }),
    );
    setConnections(withPolicies);
    setRetentionDrafts(
      Object.fromEntries(
        withPolicies.map((connection) => [
          connection.id,
          connection.retentionDays === null
            ? "until-deletion"
            : String(connection.retentionDays),
        ]),
      ),
    );
    return true;
  };

  const updateRetention = async (connection: SafeWhatsAppConnection) => {
    const draft = retentionDrafts[connection.id];
    const days = draft === "until-deletion" ? null : Number(draft);
    const broadens =
      days === null ||
      (connection.retentionDays !== null && days > connection.retentionDays);
    setRetentionStatus((current) => ({
      ...current,
      [connection.id]: "Saving Message Retention Policy…",
    }));
    try {
      const token = await getToken();
      if (token === null) throw new Error("signed out");
      const response = await fetch(
        `${connectionsEndpoint}/${encodeURIComponent(connection.id)}/retention-policy`,
        {
          body: JSON.stringify({
            acknowledge_extension: broadens
              ? retentionAcknowledgements[connection.id] === true
              : undefined,
            days,
            expected_days: connection.retentionDays,
          }),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "PUT",
        },
      );
      if (!response.ok) throw new Error("update failed");
      const body = (await response.json()) as {
        readonly policy?: { readonly days?: number | null };
      };
      if (body.policy?.days !== null && typeof body.policy?.days !== "number")
        throw new Error("invalid policy");
      setConnections((current) =>
        current.map((candidate) =>
          candidate.id === connection.id
            ? { ...candidate, retentionDays: body.policy?.days ?? null }
            : candidate,
        ),
      );
      setRetentionAcknowledgements((current) => ({
        ...current,
        [connection.id]: false,
      }));
      setRetentionStatus((current) => ({
        ...current,
        [connection.id]: `Message Retention Policy saved. Current policy: ${body.policy?.days === null ? "retain until Connection Deletion" : `${body.policy?.days} days`}. Shorter policies apply promptly to retained content.`,
      }));
    } catch {
      setRetentionStatus((current) => ({
        ...current,
        [connection.id]: "Message Retention Policy could not be saved.",
      }));
    }
  };

  const reconcileConnectionLifecycle = async (
    connectionId: string,
    action: "disconnect" | "reconnect",
    generation: number,
  ): Promise<void> => {
    const isCurrent = () => lifecycleGeneration.current === generation;
    const observeAgain = () => {
      lifecycleTimer.current = setTimeout(() => {
        lifecycleTimer.current = null;
        void reconcileConnectionLifecycle(connectionId, action, generation);
      }, 750);
    };

    try {
      const token = await getToken();
      if (!isCurrent()) return;
      if (token === null) {
        setConnectionLifecycleStatus((current) => ({
          ...current,
          [connectionId]: "Connection lifecycle is temporarily unavailable.",
        }));
        setConnectionLifecycleAction(null);
        return;
      }
      const response = await fetch(
        `${connectionsEndpoint}/${encodeURIComponent(connectionId)}/${action}`,
        {
          headers: { authorization: `Bearer ${token}` },
          method: "POST",
        },
      );
      if (!isCurrent()) return;
      if (
        response.ok &&
        response.headers.get("content-type")?.startsWith("image/svg+xml")
      ) {
        const image = await response.blob();
        if (!isCurrent()) return;
        replaceReconnectQr({
          connectionId,
          url: URL.createObjectURL(image),
        });
        setConnectionLifecycleStatus((current) => ({
          ...current,
          [connectionId]: "Scan the QR code to reconnect.",
        }));
        observeAgain();
        return;
      }

      const body = (await response.json()) as {
        readonly lifecycle?: {
          readonly action?: unknown;
          readonly outcome?: unknown;
        };
        readonly whatsapp_connection?: Record<string, unknown>;
      };
      const connection =
        body.whatsapp_connection === undefined
          ? null
          : decodeSafeWhatsAppConnection(body.whatsapp_connection);
      if (
        connection === null ||
        body.lifecycle?.action !== action ||
        (body.lifecycle.outcome !== "complete" &&
          body.lifecycle.outcome !== "in_progress" &&
          body.lifecycle.outcome !== "recovery_required")
      ) {
        throw new Error("invalid lifecycle response");
      }
      setConnections((current) =>
        current.map((candidate) =>
          candidate.id === connectionId
            ? {
                ...connection,
                retentionDays: candidate.retentionDays,
                retentionOptions: candidate.retentionOptions,
              }
            : candidate,
        ),
      );
      if (body.lifecycle.outcome === "in_progress") {
        setConnectionLifecycleStatus((current) => ({
          ...current,
          [connectionId]:
            action === "disconnect"
              ? "Disconnecting WhatsApp Connection."
              : "Reconnecting WhatsApp Connection.",
        }));
        observeAgain();
        return;
      }

      replaceReconnectQr(null);
      setConnectionLifecycleAction(null);
      setConnectionLifecycleStatus((current) => ({
        ...current,
        [connectionId]:
          body.lifecycle?.outcome === "complete"
            ? action === "disconnect"
              ? "WhatsApp Connection disconnected."
              : "WhatsApp Connection reconnected."
            : "WhatsApp Connection needs recovery before new side effects.",
      }));
    } catch {
      if (isCurrent()) {
        replaceReconnectQr(null);
        setConnectionLifecycleAction(null);
        setConnectionLifecycleStatus((current) => ({
          ...current,
          [connectionId]: "Connection lifecycle is temporarily unavailable.",
        }));
      }
    }
  };

  const startConnectionLifecycle = (
    connection: SafeWhatsAppConnection,
    action: "disconnect" | "reconnect",
  ) => {
    lifecycleGeneration.current += 1;
    if (lifecycleTimer.current !== null) {
      clearTimeout(lifecycleTimer.current);
      lifecycleTimer.current = null;
    }
    replaceReconnectQr(null);
    const generation = lifecycleGeneration.current;
    setConnectionLifecycleAction(`${connection.id}:${action}`);
    setConnectionLifecycleStatus((current) => ({
      ...current,
      [connection.id]:
        action === "disconnect"
          ? "Disconnecting WhatsApp Connection."
          : "Reconnecting WhatsApp Connection.",
    }));
    void reconcileConnectionLifecycle(connection.id, action, generation);
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
      if (!(await loadConnections(token))) {
        setState("unavailable");
        return;
      }
      setState("ok");
      setAuthorizationState("loading");
      setToolCallLogState("loading");
      try {
        const [authorizationsResponse, logsResponse] = await Promise.all([
          fetch(mcpAuthorizationsEndpoint, {
            headers: { authorization: `Bearer ${token}` },
          }),
          fetch(toolCallLogsEndpoint, {
            headers: { authorization: `Bearer ${token}` },
          }),
        ]);
        const [authorizationsBody, logsBody] = await Promise.all([
          authorizationsResponse.json(),
          logsResponse.json(),
        ]);
        const decodedAuthorizations =
          decodeMcpAuthorizations(authorizationsBody);
        const decodedLogs = decodeToolCallLogs(logsBody);
        if (!authorizationsResponse.ok || decodedAuthorizations === null) {
          setAuthorizationState("unavailable");
        } else {
          setAuthorizations(decodedAuthorizations);
          setAuthorizationState("ok");
        }
        if (!logsResponse.ok || decodedLogs === null) {
          setToolCallLogState("unavailable");
        } else {
          setToolCallLogs(decodedLogs.logs);
          setToolCallLogCursor(decodedLogs.nextCursor);
          setToolCallLogPageState("idle");
          setToolCallLogState("ok");
        }
      } catch {
        setAuthorizationState("unavailable");
        setToolCallLogState("unavailable");
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
    stopObserving();
    const requestGeneration = observationGeneration.current;
    setSetupState("loading");
    setSetupCleanupState(null);

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
          setSetupId(setup.id);
          if (setup.state === "pending") {
            setSetupState(
              setup.idempotent_replay === true ? "replayed" : "pending",
            );
            startObserving(setup.id);
            return;
          }
          if (
            setup.state === "cancelled" ||
            setup.state === "expired" ||
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

  const cancelSetup = async () => {
    if (setupId === null) return;
    stopObserving();
    setSetupState("cancelling");

    try {
      const token = await getToken();
      if (token === null) {
        setSetupState("unavailable");
        return;
      }
      const response = await fetch(`${connectionSetupEndpoint}/${setupId}`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
        method: "DELETE",
      });
      const body = (await response.json()) as {
        readonly connection_setup?: {
          readonly cleanup_state?: unknown;
          readonly id?: unknown;
          readonly state?: unknown;
        };
      };
      if (
        response.ok &&
        body.connection_setup?.id === setupId &&
        (body.connection_setup.cleanup_state === "pending" ||
          body.connection_setup.cleanup_state === "retrying" ||
          body.connection_setup.cleanup_state === "complete") &&
        (body.connection_setup.state === "cancelled" ||
          body.connection_setup.state === "expired")
      ) {
        setupIntent.current = null;
        setSetupCleanupState(body.connection_setup.cleanup_state);
        setSetupState(body.connection_setup.state);
        return;
      }
      setSetupState("unavailable");
    } catch {
      setSetupState("unavailable");
    }
  };

  return (
    <section
      aria-label="Signed-in API boundary"
      className="flex flex-col gap-3"
    >
      {identityState === "signed_in" ? (
        <Button
          disabled={state === "loading"}
          onClick={checkBoundary}
          type="button"
        >
          {state === "loading" ? <Spinner data-icon="inline-start" /> : null}
          Continue to Personal Account
        </Button>
      ) : identityState === "signed_out" ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={openWaitlist} type="button">
            Join the waitlist
          </Button>
          <Button onClick={openSignIn} type="button" variant="outline">
            Sign in
          </Button>
        </div>
      ) : null}
      <p aria-live="polite" data-testid="api-boundary-status">
        {identityState === "loading"
          ? "Checking sign-in status…"
          : identityState === "unavailable"
            ? "Sign-in is temporarily unavailable. Please refresh and try again."
            : identityState === "signed_out"
              ? "Join the private-beta waitlist, or sign in if you’re approved."
              : state === "ok"
                ? "Personal Account ready"
                : state === "waitlisted"
                  ? "You’re on the private-beta waitlist"
                  : state === "loading"
                    ? "Preparing your Personal Account…"
                    : state === "unavailable"
                      ? "Your Personal Account is temporarily unavailable. Please try again."
                      : "Signed in. Continue to create or open your Personal Account."}
      </p>
      {state === "ok" ? (
        <>
          <section
            aria-label="MCP Authorizations"
            className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground"
          >
            <div>
              <h2 className="text-lg font-medium">MCP Authorizations</h2>
              <p className="text-sm text-muted-foreground">
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
              <ul className="flex flex-col gap-3">
                {authorizations.map((authorization) => {
                  const stateLabel =
                    authorization.revocationState === "revoked"
                      ? "Revoked"
                      : authorization.expiryState === "expired"
                        ? "Expired"
                        : "Active";
                  return (
                    <li
                      className="flex flex-col gap-3 rounded-lg border bg-background p-4"
                      key={authorization.id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-medium">
                            {authorization.client.name}
                          </h3>
                          <p className="font-mono text-xs text-muted-foreground">
                            {authorization.client.id}
                          </p>
                        </div>
                        <Badge
                          data-testid="mcp-authorization-state"
                          variant="outline"
                        >
                          {stateLabel}
                        </Badge>
                      </div>
                      <dl className="grid gap-2 text-sm sm:grid-cols-2">
                        <div>
                          <dt className="text-muted-foreground">Created</dt>
                          <dd>
                            <time dateTime={authorization.createdAt}>
                              {displayTime(authorization.createdAt)} UTC
                            </time>
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Expires</dt>
                          <dd>
                            <time dateTime={authorization.expiresAt}>
                              {displayTime(authorization.expiresAt)} UTC
                            </time>
                          </dd>
                        </div>
                      </dl>
                      <div className="flex flex-col gap-1">
                        <p className="text-sm text-muted-foreground">
                          WhatsApp Connections
                        </p>
                        <ul className="flex flex-col gap-1 font-mono text-xs">
                          {authorization.connectionIds.map((connectionId) => (
                            <li key={connectionId}>{connectionId}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="flex flex-col gap-1">
                        <p className="text-sm text-muted-foreground">
                          Permissions
                        </p>
                        <ul className="flex flex-wrap gap-2 text-xs">
                          {authorization.scopes.map((scope) => (
                            <li key={scope}>
                              <Badge variant="secondary">
                                {scopeLabels[scope]}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <Button
                        aria-label={`Revoke ${authorization.client.name}`}
                        disabled={
                          authorization.revocationState === "revoked" ||
                          revokingAuthorization === authorization.id
                        }
                        onClick={() => revokeAuthorization(authorization)}
                        type="button"
                        variant="destructive"
                      >
                        {revokingAuthorization === authorization.id ? (
                          <Spinner data-icon="inline-start" />
                        ) : null}
                        {revokingAuthorization === authorization.id
                          ? "Revoking…"
                          : "Revoke access"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section
            aria-label="Tool Call Logs"
            className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground"
          >
            <div>
              <h2 className="text-lg font-medium">Tool Call Logs</h2>
              <p className="text-sm text-muted-foreground">
                Metadata-only activity from the last 90 days. Message content,
                full numbers, credentials, and provider data are never shown.
              </p>
            </div>
            {toolCallLogState === "loading" ? (
              <p aria-live="polite">Loading Tool Call Logs…</p>
            ) : toolCallLogState === "unavailable" ? (
              <p aria-live="polite">
                Tool Call Logs are temporarily unavailable.
              </p>
            ) : toolCallLogs.length === 0 ? (
              <p>No tool activity in the last 90 days.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {toolCallLogs.map((log, index) => (
                  <li
                    className="flex flex-col gap-3 rounded-lg border bg-background p-4"
                    data-testid="tool-call-log"
                    key={`${log.startedAt}:${log.references[0]}:${index}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-medium">
                          {log.capability.replaceAll("_", " ")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          {log.client.name}
                        </p>
                      </div>
                      <Badge className="capitalize" variant="outline">
                        {log.outcome.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    <dl className="grid gap-2 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-muted-foreground">Started</dt>
                        <dd>
                          <time dateTime={log.startedAt}>
                            {displayTime(log.startedAt)} UTC
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Results</dt>
                        <dd>{log.counts.results ?? "Pending"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Latency</dt>
                        <dd>
                          {log.latencyMs === null
                            ? "Pending"
                            : `${log.latencyMs} ms`}
                        </dd>
                      </div>
                    </dl>
                    <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
                      {log.references.map((reference) => (
                        <li key={reference}>{reference}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {toolCallLogState === "ok" && toolCallLogCursor !== null ? (
              <Button
                disabled={toolCallLogPageState === "loading"}
                onClick={loadMoreToolCallLogs}
                type="button"
                variant="outline"
              >
                {toolCallLogPageState === "loading" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {toolCallLogPageState === "loading"
                  ? "Loading more…"
                  : "Load more"}
              </Button>
            ) : null}
            {toolCallLogPageState === "unavailable" ? (
              <p aria-live="polite">More Tool Call Logs are unavailable.</p>
            ) : null}
          </section>
          <form
            className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground"
            onSubmit={startSetup}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="whatsapp-number">
                  WhatsApp Number
                </FieldLabel>
                <Input
                  autoComplete="tel"
                  disabled={setupState === "loading"}
                  id="whatsapp-number"
                  inputMode="tel"
                  onChange={(event) => {
                    stopObserving();
                    setWhatsappNumber(event.target.value);
                    setSetupCleanupState(null);
                    setSetupId(null);
                    setSetupState("idle");
                  }}
                  placeholder="+1 555 012 3456"
                  required
                  type="tel"
                  value={whatsappNumber}
                />
                <FieldDescription>
                  Include the country code. Your setup expires after 15 minutes.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <div className="flex flex-wrap gap-2">
              <Button disabled={setupState === "loading"} type="submit">
                {setupState === "loading" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                Start Connection Setup
              </Button>
              {setupId !== null &&
              (setupState === "pending" ||
                setupState === "replayed" ||
                setupState === "qr_available" ||
                setupState === "connecting" ||
                setupState === "provisioned" ||
                setupState === "provisioning_failed" ||
                setupState === "provisioning_quarantined") ? (
                <Button onClick={cancelSetup} type="button" variant="outline">
                  Cancel Connection Setup
                </Button>
              ) : null}
            </div>
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
                              : setupState === "cancelling"
                                ? "Cancelling Connection Setup."
                                : setupState === "cancelled"
                                  ? setupCleanupState === "complete"
                                    ? "Connection Setup cancelled. Provider cleanup is complete."
                                    : setupCleanupState === "retrying"
                                      ? "Connection Setup cancelled. Provider cleanup is retrying."
                                      : "Connection Setup cancelled. Provider cleanup is in progress."
                                  : setupState === "expired"
                                    ? setupCleanupState === "complete"
                                      ? "Connection Setup expired. Provider cleanup is complete."
                                      : setupCleanupState === "retrying"
                                        ? "Connection Setup expired. Provider cleanup is retrying."
                                        : "Connection Setup expired. Provider cleanup is in progress."
                                    : setupState === "number_unavailable"
                                      ? "That WhatsApp Number is already in use."
                                      : setupState ===
                                          "connection_limit_reached"
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
        </>
      ) : null}
      {state === "ok" ? (
        <section
          aria-label="WhatsApp Connections"
          className="flex flex-col gap-3"
        >
          <h2 className="text-xl font-semibold">WhatsApp Connections</h2>
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No WhatsApp Connections yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {connections.map((connection) => (
                <li
                  className="rounded-lg border bg-card p-4 text-card-foreground"
                  data-testid="whatsapp-connection"
                  key={connection.id}
                >
                  <p className="font-medium">
                    {connection.displayName ?? "WhatsApp Connection"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Number ending {connection.numberSuffix}
                  </p>
                  <p className="text-sm capitalize text-emerald-400">
                    {connection.state.replace("_", " ")}
                  </p>
                  <time
                    className="text-xs text-muted-foreground"
                    dateTime={connection.stateChangedAt}
                  >
                    State changed {connection.stateChangedAt}
                  </time>
                  <div className="mt-3 flex flex-col gap-2 rounded border p-3">
                    <Field>
                      <FieldLabel htmlFor={`retention-${connection.id}`}>
                        Message Retention Policy
                      </FieldLabel>
                      <Select
                        items={[
                          ...connection.retentionOptions.map((days) => ({
                            label: `${days} days`,
                            value: String(days),
                          })),
                          {
                            label: "Retain until Connection Deletion",
                            value: "until-deletion",
                          },
                        ]}
                        onValueChange={(value) => {
                          if (value === null) return;
                          setRetentionDrafts((current) => ({
                            ...current,
                            [connection.id]: value,
                          }));
                          setRetentionAcknowledgements((current) => ({
                            ...current,
                            [connection.id]: false,
                          }));
                        }}
                        value={
                          retentionDrafts[connection.id] ??
                          (connection.retentionDays === null
                            ? "until-deletion"
                            : String(connection.retentionDays))
                        }
                      >
                        <SelectTrigger id={`retention-${connection.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {connection.retentionOptions.map((days) => (
                              <SelectItem key={days} value={String(days)}>
                                {days} days
                              </SelectItem>
                            ))}
                            <SelectItem value="until-deletion">
                              Retain until Connection Deletion
                            </SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    {(() => {
                      const draft = retentionDrafts[connection.id];
                      const next =
                        draft === "until-deletion"
                          ? null
                          : Number(draft ?? connection.retentionDays);
                      const broadens =
                        next === null ||
                        (connection.retentionDays !== null &&
                          next > connection.retentionDays);
                      return broadens ? (
                        <Field orientation="horizontal">
                          <Checkbox
                            checked={
                              retentionAcknowledgements[connection.id] === true
                            }
                            id={`retention-acknowledgement-${connection.id}`}
                            onCheckedChange={(checked) =>
                              setRetentionAcknowledgements((current) => ({
                                ...current,
                                [connection.id]: checked,
                              }))
                            }
                          />
                          <FieldLabel
                            htmlFor={`retention-acknowledgement-${connection.id}`}
                          >
                            I explicitly choose to retain message content for
                            longer.
                          </FieldLabel>
                        </Field>
                      ) : null;
                    })()}
                    <Button
                      disabled={(() => {
                        const draft = retentionDrafts[connection.id];
                        const next =
                          draft === "until-deletion"
                            ? null
                            : Number(draft ?? connection.retentionDays);
                        return (
                          (next === null ||
                            (connection.retentionDays !== null &&
                              next > connection.retentionDays)) &&
                          retentionAcknowledgements[connection.id] !== true
                        );
                      })()}
                      onClick={() => void updateRetention(connection)}
                      type="button"
                      variant="outline"
                    >
                      Save retention policy
                    </Button>
                    <p
                      aria-live="polite"
                      className="text-sm text-muted-foreground"
                    >
                      {retentionStatus[connection.id] ??
                        `Current policy: ${connection.retentionDays === null ? "retain until Connection Deletion" : `${connection.retentionDays} days`}.`}
                    </p>
                  </div>
                  {connection.state === "disconnected" ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Retained history remains available under your Message
                      Retention Policy.
                    </p>
                  ) : connection.state === "degraded" ||
                    connection.state === "reconnect_required" ? (
                    <p className="mt-2 text-sm text-amber-300">
                      New side effects are blocked until this WhatsApp
                      Connection recovers.
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {connection.state === "connected" ? (
                      <Button
                        aria-label={`Disconnect WhatsApp Connection ending ${connection.numberSuffix}`}
                        disabled={connectionLifecycleAction !== null}
                        onClick={() =>
                          startConnectionLifecycle(connection, "disconnect")
                        }
                        type="button"
                        variant="destructive"
                      >
                        Disconnect
                      </Button>
                    ) : connection.state === "connecting" ||
                      connection.state === "disconnected" ||
                      connection.state === "degraded" ||
                      connection.state === "reconnect_required" ? (
                      <Button
                        aria-label={`Reconnect WhatsApp Connection ending ${connection.numberSuffix}`}
                        disabled={connectionLifecycleAction !== null}
                        onClick={() =>
                          startConnectionLifecycle(connection, "reconnect")
                        }
                        type="button"
                        variant="outline"
                      >
                        Reconnect
                      </Button>
                    ) : null}
                  </div>
                  <p
                    aria-live="polite"
                    className="mt-2 text-sm text-muted-foreground"
                    data-testid="connection-lifecycle-status"
                  >
                    {connectionLifecycleStatus[connection.id] ?? ""}
                  </p>
                  {reconnectQr?.connectionId === connection.id ? (
                    // The object URL contains only the authenticated ephemeral
                    // provider QR response and is revoked after reconciliation.
                    // biome-ignore lint/performance/noImgElement: QR bytes are already a complete generated SVG.
                    <img
                      alt="Reconnect this WhatsApp Connection QR code"
                      className="mt-3 h-64 w-64 rounded bg-white p-3"
                      src={reconnectQr.url}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {state === "ok" ? (
        <section
          aria-label="Personal Account Deletion"
          className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-4"
        >
          <h2 className="text-xl font-semibold">Delete Personal Account</h2>
          <p className="text-sm text-muted-foreground">
            Permanently revoke access, cancel incomplete Connection Setups, and
            delete every WhatsApp Connection.
          </p>
          <Button
            disabled={deletionState === "deleting"}
            onClick={() => void deletePersonalAccount()}
            type="button"
            variant="destructive"
          >
            {deletionState === "deleting" ? (
              <Spinner data-icon="inline-start" />
            ) : null}
            Delete Personal Account
          </Button>
          <p aria-live="polite">
            {deletionState === "deleting"
              ? "Personal Account Deletion is starting."
              : deletionState === "unavailable"
                ? "Personal Account Deletion is temporarily unavailable."
                : ""}
          </p>
        </section>
      ) : null}
    </section>
  );
}
