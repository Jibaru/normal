import type { DeploymentEnvironment } from "@whatsapp-mcp/domain/deployment";
import { Data, Effect, Redacted } from "effect";
import { hasExactKeys } from "../record";
import { isCanonicalTimestamp } from "../timestamp";

// A purpose specific HMAC domain. This key is never shared with deletion
// markers, provider references, webhooks, cursors, OAuth, WhatsApp Numbers, or
// content encryption.
const journalKeyDomain = "whatsapp-mcp/recipient-transition-key/v1";
const journalPrefix = "recipient-transitions/v1/";
const journalVersion = 1 as const;

export type RecipientKind = "contact" | "group";

export type RecipientJournalOperation =
  | "append-transition"
  | "derive-prefix"
  | "enumerate-transitions";

export class RecipientJournalError extends Data.TaggedError(
  "RecipientJournalError",
)<{ readonly operation: RecipientJournalOperation }> {}

// The stored object carries no tenant ID, connection ID, public handle,
// provider identifier, name, phone data, content, or credential.
export interface RecipientTransition {
  readonly effectiveAt: string;
  readonly excluded: boolean;
  readonly purgeCutoffAt: string | null;
  readonly transitionId: string;
  readonly version: typeof journalVersion;
}

export interface RecipientTransitionReference {
  readonly objectKey: string;
  readonly prefix: string;
  readonly transition: RecipientTransition;
}

export interface RecipientJournalBucket {
  readonly get: (
    key: string,
  ) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly list: (options: {
    readonly cursor?: string | undefined;
    readonly prefix: string;
  }) => Promise<{
    readonly cursor?: string | undefined;
    readonly objects: ReadonlyArray<{ readonly key: string }>;
    readonly truncated: boolean;
  }>;
  readonly put: (
    key: string,
    value: string,
    options?: {
      readonly onlyIf?: { readonly etagDoesNotMatch?: string | undefined };
    },
  ) => Promise<unknown | null>;
}

export interface RecipientJournalStore {
  readonly append: (input: {
    readonly connectionId: string;
    readonly effectiveAt: string;
    readonly excluded: boolean;
    readonly purgeCutoffAt: string | null;
    readonly recipientKind: RecipientKind;
    readonly recipientLocator: string;
    readonly transitionId: string;
  }) => Effect.Effect<RecipientTransitionReference, RecipientJournalError>;
  readonly enumerate: (input: {
    readonly connectionId: string;
    readonly recipientKind: RecipientKind;
    readonly recipientLocator: string;
  }) => Effect.Effect<
    ReadonlyArray<RecipientTransition>,
    RecipientJournalError
  >;
}

const operationError = (operation: RecipientJournalOperation) =>
  new RecipientJournalError({ operation });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const parseTransition = (
  value: string,
  operation: RecipientJournalOperation,
): RecipientTransition => {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "effectiveAt",
      "excluded",
      "purgeCutoffAt",
      "transitionId",
      "version",
    ]) ||
    parsed.version !== journalVersion ||
    typeof parsed.excluded !== "boolean" ||
    typeof parsed.transitionId !== "string" ||
    !uuidPattern.test(parsed.transitionId) ||
    !isCanonicalTimestamp(parsed.effectiveAt) ||
    (parsed.purgeCutoffAt !== null &&
      !isCanonicalTimestamp(parsed.purgeCutoffAt)) ||
    (parsed.excluded && parsed.purgeCutoffAt === null) ||
    (typeof parsed.purgeCutoffAt === "string" &&
      parsed.purgeCutoffAt > parsed.effectiveAt)
  ) {
    throw operationError(operation);
  }
  return {
    effectiveAt: parsed.effectiveAt,
    excluded: parsed.excluded,
    purgeCutoffAt: parsed.purgeCutoffAt,
    transitionId: parsed.transitionId,
    version: journalVersion,
  };
};

// Byte stable so a retry of the same transition is an idempotent replay and any
// other bytes at the same key are an integrity failure.
const serializeTransition = (transition: RecipientTransition) =>
  JSON.stringify({
    effectiveAt: transition.effectiveAt,
    excluded: transition.excluded,
    purgeCutoffAt: transition.purgeCutoffAt,
    transitionId: transition.transitionId,
    version: transition.version,
  });

const decodeHex = (
  value: string,
  operation: RecipientJournalOperation,
): Uint8Array<ArrayBuffer> => {
  if (!/^[a-f0-9]{64}$/iu.test(value)) throw operationError(operation);
  const pairs = value.match(/.{2}/gu) ?? [];
  const decoded = new Uint8Array(new ArrayBuffer(pairs.length));
  pairs.forEach((pair, index) => {
    decoded[index] = Number.parseInt(pair, 16);
  });
  return decoded;
};

const toHex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const deriveRecipientJournalPrefix = async (
  environment: DeploymentEnvironment,
  hmacSecret: Redacted.Redacted<string>,
  connectionId: string,
  recipientKind: RecipientKind,
  recipientLocator: string,
) => {
  if (
    !uuidPattern.test(connectionId) ||
    (recipientKind !== "contact" && recipientKind !== "group") ||
    !/^(di1|wi1)_[A-Za-z0-9_-]{43}$/u.test(recipientLocator)
  ) {
    throw operationError("derive-prefix");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    decodeHex(Redacted.value(hmacSecret), "derive-prefix"),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const authenticatedIdentity = new TextEncoder().encode(
    `${journalKeyDomain}\u0000${environment}\u0000${connectionId}\u0000${recipientKind}\u0000${recipientLocator}`,
  );
  return toHex(await crypto.subtle.sign("HMAC", key, authenticatedIdentity));
};

const objectKeyFor = (prefix: string, transitionId: string) =>
  `${journalPrefix}${prefix}/${transitionId}.json`;

export const makeRecipientJournalStore = ({
  bucket,
  environment,
  hmacSecret,
}: {
  readonly bucket: RecipientJournalBucket;
  readonly environment: DeploymentEnvironment;
  readonly hmacSecret: Redacted.Redacted<string>;
}): RecipientJournalStore => ({
  append: (input) =>
    Effect.tryPromise({
      try: async () => {
        const transition = parseTransition(
          JSON.stringify({
            effectiveAt: input.effectiveAt,
            excluded: input.excluded,
            purgeCutoffAt: input.purgeCutoffAt,
            transitionId: input.transitionId,
            version: journalVersion,
          }),
          "append-transition",
        );
        const prefix = await deriveRecipientJournalPrefix(
          environment,
          hmacSecret,
          input.connectionId,
          input.recipientKind,
          input.recipientLocator,
        );
        const objectKey = objectKeyFor(prefix, transition.transitionId);
        const body = serializeTransition(transition);
        const stored = await bucket.put(objectKey, body, {
          onlyIf: { etagDoesNotMatch: "*" },
        });
        if (stored === null) {
          const existing = await bucket.get(objectKey);
          if (!existing) throw operationError("append-transition");
          const existingBody = await existing.text();
          if (existingBody !== body) throw operationError("append-transition");
          return { objectKey, prefix, transition };
        }
        return { objectKey, prefix, transition };
      },
      catch: () => operationError("append-transition"),
    }),
  enumerate: (input) =>
    Effect.tryPromise({
      try: async () => {
        const prefix = await deriveRecipientJournalPrefix(
          environment,
          hmacSecret,
          input.connectionId,
          input.recipientKind,
          input.recipientLocator,
        );
        return readTransitions(bucket, prefix);
      },
      catch: () => operationError("enumerate-transitions"),
    }),
});

// Every prefix the journal holds evidence for. Restore compares this against
// the prefixes it could derive from the restored snapshot; the remainder
// belongs to recipients the snapshot predates.
export const listJournalPrefixes = async (
  bucket: RecipientJournalBucket,
): Promise<ReadonlyArray<string>> => {
  const prefixes = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, prefix: journalPrefix });
    for (const object of page.objects) {
      const named =
        /^recipient-transitions\/v1\/([a-f0-9]{64})\/[0-9a-f-]{36}\.json$/u.exec(
          object.key,
        );
      if (named?.[1] === undefined) {
        throw operationError("enumerate-transitions");
      }
      prefixes.add(named[1]);
    }
    if (page.truncated) {
      if (!page.cursor || seenCursors.has(page.cursor)) {
        throw operationError("enumerate-transitions");
      }
      seenCursors.add(page.cursor);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return [...prefixes];
};

// Ordered oldest first by effective time so a replay applies the latest
// acknowledged state and the greatest purge cutoff.
export const readTransitions = async (
  bucket: RecipientJournalBucket,
  prefix: string,
): Promise<ReadonlyArray<RecipientTransition>> => {
  const transitions: RecipientTransition[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      cursor,
      prefix: `${journalPrefix}${prefix}/`,
    });
    for (const object of page.objects) {
      const named = new RegExp(
        `^recipient-transitions/v1/${prefix}/([0-9a-f-]{36})\\.json$`,
        "u",
      ).exec(object.key);
      const namedTransitionId = named?.[1];
      if (
        namedTransitionId === undefined ||
        !uuidPattern.test(namedTransitionId)
      ) {
        throw operationError("enumerate-transitions");
      }
      const stored = await bucket.get(object.key);
      if (!stored) throw operationError("enumerate-transitions");
      const transition = parseTransition(
        await stored.text(),
        "enumerate-transitions",
      );
      // An object stored under a name other than its own transition identity
      // is misplaced evidence, not authoritative state.
      if (transition.transitionId !== namedTransitionId) {
        throw operationError("enumerate-transitions");
      }
      transitions.push(transition);
    }
    if (page.truncated) {
      if (!page.cursor || seenCursors.has(page.cursor)) {
        throw operationError("enumerate-transitions");
      }
      seenCursors.add(page.cursor);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return [...transitions].sort((left, right) =>
    left.effectiveAt === right.effectiveAt
      ? left.transitionId.localeCompare(right.transitionId)
      : left.effectiveAt.localeCompare(right.effectiveAt),
  );
};
