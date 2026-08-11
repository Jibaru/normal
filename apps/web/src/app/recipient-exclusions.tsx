"use client";

import { makeIdempotencyKey } from "@whatsapp-mcp/contracts/handles";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

export interface RecipientConnection {
  readonly displayName: string | null;
  readonly id: string;
  readonly numberSuffix: string;
}

type RecipientKind = "contact" | "group";

interface Recipient {
  readonly displayName: string | null;
  readonly excluded: boolean;
  readonly id: string;
  readonly kind: RecipientKind;
  readonly phoneLastFour: string | null;
}

interface RecipientPage {
  readonly directory: {
    readonly asOf: string;
    readonly partial: boolean;
    readonly stale: boolean;
  };
  readonly nextCursor: string | null;
  readonly recipients: ReadonlyArray<Recipient>;
}

type ListState = "idle" | "loading" | "ok" | "unavailable";

const handlePattern = /^(?:ctc|grp)_[A-Za-z0-9_-]{21}$/u;

const decodeRecipientPage = (value: unknown): RecipientPage | null => {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const directory = body.directory as Record<string, unknown> | undefined;
  const nextCursor = body.next_cursor;
  if (
    typeof directory?.as_of !== "string" ||
    typeof directory.partial !== "boolean" ||
    typeof directory.stale !== "boolean" ||
    !Array.isArray(body.recipients) ||
    (nextCursor !== null &&
      (typeof nextCursor !== "string" || !handlePattern.test(nextCursor)))
  ) {
    return null;
  }
  const recipients: Recipient[] = [];
  for (const candidate of body.recipients) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const recipient = candidate as Record<string, unknown>;
    if (
      typeof recipient.id !== "string" ||
      !handlePattern.test(recipient.id) ||
      (recipient.kind !== "contact" && recipient.kind !== "group") ||
      typeof recipient.excluded !== "boolean" ||
      (recipient.display_name !== null &&
        typeof recipient.display_name !== "string") ||
      (recipient.phone_last_four !== null &&
        typeof recipient.phone_last_four !== "string")
    ) {
      return null;
    }
    recipients.push({
      displayName: recipient.display_name as string | null,
      excluded: recipient.excluded,
      id: recipient.id,
      kind: recipient.kind,
      phoneLastFour: recipient.phone_last_four as string | null,
    });
  }
  return {
    directory: {
      asOf: directory.as_of,
      partial: directory.partial,
      stale: directory.stale,
    },
    nextCursor: nextCursor as string | null,
    recipients,
  };
};

const recipientLabel = (recipient: Recipient) =>
  recipient.displayName ??
  (recipient.kind === "contact" ? "Unnamed contact" : "Unnamed group");

export function RecipientExclusions({
  connections,
  connectionsEndpoint,
  getToken,
}: {
  readonly connections: ReadonlyArray<RecipientConnection>;
  readonly connectionsEndpoint: string;
  readonly getToken: () => Promise<string | null>;
}) {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [kind, setKind] = useState<RecipientKind>("contact");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<RecipientPage | null>(null);
  const [listState, setListState] = useState<ListState>("idle");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const selectedConnectionId = connectionId ?? connections[0]?.id ?? null;
  // The caller recreates its token reader on every render, so reading through
  // a ref keeps the load effect from restarting in a loop.
  const tokenReader = useRef(getToken);
  tokenReader.current = getToken;

  const load = useCallback(
    async (cursor: string | null) => {
      if (selectedConnectionId === null) return;
      setListState("loading");
      try {
        const token = await tokenReader.current();
        if (token === null) throw new Error("signed out");
        const url = new URL(
          `${connectionsEndpoint}/${selectedConnectionId}/recipients`,
        );
        url.searchParams.set("kind", kind);
        if (cursor !== null) url.searchParams.set("cursor", cursor);
        // A safe display-name prefix needs at least three characters.
        if (search.trim().length >= 3) {
          url.searchParams.set("search", search.trim());
        }
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
        });
        const decoded = decodeRecipientPage(await response.json());
        if (!response.ok || decoded === null) {
          throw new Error("recipients unavailable");
        }
        setPage((current) =>
          cursor === null || current === null
            ? decoded
            : {
                ...decoded,
                recipients: [...current.recipients, ...decoded.recipients],
              },
        );
        setListState("ok");
      } catch {
        setListState("unavailable");
      }
    },
    [connectionsEndpoint, kind, search, selectedConnectionId],
  );

  useEffect(() => {
    setPage(null);
    void load(null);
  }, [load]);

  const setExcluded = async (recipient: Recipient, excluded: boolean) => {
    if (selectedConnectionId === null || savingId !== null) return;
    setSavingId(recipient.id);
    setStatus(
      excluded
        ? `Saving. Normal will stop tracking ${recipientLabel(recipient)}.`
        : `Saving. Normal may track ${recipientLabel(recipient)} again.`,
    );
    try {
      const token = await tokenReader.current();
      if (token === null) throw new Error("signed out");
      const response = await fetch(
        `${connectionsEndpoint}/${selectedConnectionId}/recipients/${recipient.id}/exclusion`,
        {
          body: JSON.stringify({
            excluded,
            expected_excluded: recipient.excluded,
            // A retry reuses this key, so a network timeout cannot create
            // conflicting transitions.
            idempotency_key: makeIdempotencyKey(),
          }),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "PUT",
        },
      );
      const body = (await response.json()) as {
        readonly exclusion?: { readonly excluded?: unknown };
      };
      if (!response.ok || typeof body.exclusion?.excluded !== "boolean") {
        throw new Error("exclusion unavailable");
      }
      const saved = body.exclusion.excluded;
      setPage((current) =>
        current === null
          ? current
          : {
              ...current,
              recipients: current.recipients.map((entry) =>
                entry.id === recipient.id
                  ? { ...entry, excluded: saved }
                  : entry,
              ),
            },
      );
      setStatus(
        saved
          ? `Normal no longer tracks ${recipientLabel(recipient)}.`
          : `Normal may track ${recipientLabel(recipient)} again.`,
      );
    } catch {
      setStatus(
        `Could not save ${recipientLabel(recipient)}. Other settings still work.`,
      );
    } finally {
      setSavingId(null);
    }
  };

  if (connections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Connect WhatsApp to choose which recipients Normal may track.
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field className="sm:w-64">
          <FieldLabel htmlFor="recipient-connection">
            WhatsApp Connection
          </FieldLabel>
          <Select
            items={connections.map((connection) => ({
              label:
                connection.displayName ??
                `WhatsApp Connection ending ${connection.numberSuffix}`,
              value: connection.id,
            }))}
            onValueChange={(value) => {
              setConnectionId(String(value));
              setPage(null);
            }}
            value={selectedConnectionId ?? ""}
          >
            <SelectTrigger id="recipient-connection">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {connections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.displayName ??
                      `WhatsApp Connection ending ${connection.numberSuffix}`}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="sm:w-40">
          <FieldLabel htmlFor="recipient-kind">Recipient kind</FieldLabel>
          <Select
            items={[
              { label: "Contacts", value: "contact" },
              { label: "Groups", value: "group" },
            ]}
            onValueChange={(value) => {
              setKind(value === "group" ? "group" : "contact");
              setPage(null);
            }}
            value={kind}
          >
            <SelectTrigger id="recipient-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="contact">Contacts</SelectItem>
                <SelectItem value="group">Groups</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="sm:flex-1">
          <FieldLabel htmlFor="recipient-search">Search by name</FieldLabel>
          <Input
            id="recipient-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Start of a display name"
            type="search"
            value={search}
          />
          <FieldDescription>
            Enter at least three characters of a display name.
          </FieldDescription>
        </Field>
      </div>

      {page === null ? null : (
        <p className="text-xs text-muted-foreground">
          {page.directory.stale
            ? "This WhatsApp Directory projection may be out of date. "
            : ""}
          {page.directory.partial
            ? "Some recipients may be missing from this projection. "
            : ""}
          Directory as of {page.directory.asOf}.
        </p>
      )}

      {listState === "unavailable" ? (
        <p className="text-sm text-muted-foreground">
          Your WhatsApp Directory is temporarily unavailable.
        </p>
      ) : null}

      <ul className="flex flex-col gap-2" data-testid="recipient-exclusions">
        {(page?.recipients ?? []).map((recipient) => (
          <li
            className="flex items-center justify-between gap-3 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-foreground/10"
            data-testid="recipient-exclusion"
            key={recipient.id}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate font-medium">
                  {recipientLabel(recipient)}
                </p>
                <Badge variant="outline">
                  {recipient.kind === "contact" ? "Contact" : "Group"}
                </Badge>
              </div>
              {recipient.phoneLastFour === null ? null : (
                <p className="text-xs text-muted-foreground">
                  Ends in {recipient.phoneLastFour}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-sm">
              {savingId === recipient.id ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              <Checkbox
                checked={recipient.excluded}
                disabled={savingId !== null}
                id={`exclude-${recipient.id}`}
                onCheckedChange={(checked) =>
                  void setExcluded(recipient, checked === true)
                }
              />
              <Label htmlFor={`exclude-${recipient.id}`}>
                Do not track
                <span className="sr-only"> {recipientLabel(recipient)}</span>
              </Label>
            </div>
          </li>
        ))}
      </ul>

      {listState === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading recipients.</p>
      ) : null}

      {page?.nextCursor == null ? null : (
        <Button
          onClick={() => void load(page.nextCursor)}
          type="button"
          variant="outline"
        >
          Show more recipients
        </Button>
      )}

      <p aria-live="polite" data-testid="recipient-exclusion-status">
        {status}
      </p>
    </div>
  );
}
