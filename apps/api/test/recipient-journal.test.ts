import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
  deriveRecipientJournalPrefix,
  makeRecipientJournalStore,
  type RecipientJournalBucket,
} from "../src/recipient/journal";

const secret = Redacted.make("cd".repeat(32));
const connectionId = "20000000-0000-4000-8000-000000000070";
const otherConnectionId = "20000000-0000-4000-8000-000000000071";
const contactLocator = `di1_${"A".repeat(43)}`;
const groupLocator = `wi1_${"B".repeat(43)}`;

const makeBucket = () => {
  const objects = new Map<string, string>();
  const bucket: RecipientJournalBucket = {
    get: async (key) => {
      const body = objects.get(key);
      return body === undefined ? null : { text: async () => body };
    },
    list: async ({ prefix }) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    }),
    // Create-if-absent: an existing key is never overwritten.
    put: async (key, value) => {
      if (objects.has(key)) return null;
      objects.set(key, value);
      return { key };
    },
  };
  return { bucket, objects };
};

const transition = {
  connectionId,
  effectiveAt: "2026-08-11T00:00:00.000Z",
  excluded: true,
  purgeCutoffAt: "2026-08-11T00:00:00.000Z",
  recipientKind: "contact" as const,
  recipientLocator: contactLocator,
  transitionId: "30000000-0000-4000-8000-000000000070",
};

describe("WhatsApp Recipient Exclusion transition journal", () => {
  test("derives a distinct prefix per environment, connection, kind, and recipient", async () => {
    const base = await deriveRecipientJournalPrefix(
      "production",
      secret,
      connectionId,
      "contact",
      contactLocator,
    );
    const variants = await Promise.all([
      deriveRecipientJournalPrefix(
        "preview",
        secret,
        connectionId,
        "contact",
        contactLocator,
      ),
      deriveRecipientJournalPrefix(
        "production",
        secret,
        otherConnectionId,
        "contact",
        contactLocator,
      ),
      deriveRecipientJournalPrefix(
        "production",
        secret,
        connectionId,
        "group",
        groupLocator,
      ),
    ]);
    expect(base).toMatch(/^[a-f0-9]{64}$/u);
    expect(new Set([base, ...variants]).size).toBe(4);
    // The prefix must not be reversible to the recipient it covers.
    expect(base).not.toContain(contactLocator);
    expect(base).not.toContain(connectionId);
  });

  test("treats a byte-identical append as an idempotent replay", async () => {
    const { bucket, objects } = makeBucket();
    const store = makeRecipientJournalStore({
      bucket,
      environment: "production",
      hmacSecret: secret,
    });
    const first = await Effect.runPromise(store.append(transition));
    const replay = await Effect.runPromise(store.append(transition));
    expect(replay.objectKey).toBe(first.objectKey);
    expect(objects.size).toBe(1);
    expect(JSON.parse(objects.get(first.objectKey) ?? "")).toEqual({
      effectiveAt: "2026-08-11T00:00:00.000Z",
      excluded: true,
      purgeCutoffAt: "2026-08-11T00:00:00.000Z",
      transitionId: "30000000-0000-4000-8000-000000000070",
      version: 1,
    });
  });

  test("treats different bytes at an existing key as an integrity failure", async () => {
    const { bucket } = makeBucket();
    const store = makeRecipientJournalStore({
      bucket,
      environment: "production",
      hmacSecret: secret,
    });
    await Effect.runPromise(store.append(transition));
    await expect(
      Effect.runPromise(
        store.append({
          ...transition,
          effectiveAt: "2026-08-12T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow();
  });

  test("enumerates only the transitions of the requested recipient, oldest first", async () => {
    const { bucket } = makeBucket();
    const store = makeRecipientJournalStore({
      bucket,
      environment: "production",
      hmacSecret: secret,
    });
    await Effect.runPromise(store.append(transition));
    await Effect.runPromise(
      store.append({
        ...transition,
        effectiveAt: "2026-08-12T00:00:00.000Z",
        excluded: false,
        transitionId: "30000000-0000-4000-8000-000000000071",
      }),
    );
    await Effect.runPromise(
      store.append({
        ...transition,
        connectionId: otherConnectionId,
        transitionId: "30000000-0000-4000-8000-000000000072",
      }),
    );
    const enumerated = await Effect.runPromise(
      store.enumerate({
        connectionId,
        recipientKind: "contact",
        recipientLocator: contactLocator,
      }),
    );
    expect(enumerated.map((entry) => entry.transitionId)).toEqual([
      "30000000-0000-4000-8000-000000000070",
      "30000000-0000-4000-8000-000000000071",
    ]);
  });

  test("rejects an exclusion recorded without a purge cutoff", async () => {
    const { bucket } = makeBucket();
    const store = makeRecipientJournalStore({
      bucket,
      environment: "production",
      hmacSecret: secret,
    });
    await expect(
      Effect.runPromise(store.append({ ...transition, purgeCutoffAt: null })),
    ).rejects.toThrow();
  });
});
