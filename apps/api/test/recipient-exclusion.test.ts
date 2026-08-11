import type {
  PreparedRecipientTransition,
  RecipientDirectoryMaterial,
} from "@whatsapp-mcp/db/recipient-exclusion";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import { HumanIdentity } from "../src/auth/human-identity";
import {
  createRecipientExclusionHandler,
  RecipientExclusionClock,
  RecipientExclusionPersistence,
  RecipientExclusionPersistenceError,
  type RecipientExclusionPersistenceService,
  RecipientTransitionJournal,
} from "../src/recipient-exclusion";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const origin = "https://app.example.test";
const connectionPublicId = "con_000000000000000000070";
const contactPublicId = "ctc_000000000000000000070";
const listEndpoint = `https://api.example.test/v1/whatsapp-connections/${connectionPublicId}/recipients`;
const exclusionEndpoint = `${listEndpoint}/${contactPublicId}/exclusion`;

const material: RecipientDirectoryMaterial = {
  accountKey: {
    ciphertext: "AA==",
    keyVersion: 1,
    kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content",
    personalAccountId: "10000000-0000-4000-8000-000000000070",
    version: 1,
  },
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: "AA==",
    connectionId: "20000000-0000-4000-8000-000000000070",
    keyVersion: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    personalAccountId: "10000000-0000-4000-8000-000000000070",
    version: 1,
  },
  identityKey: {
    ciphertext: "AA==",
    keyVersion: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    version: 1,
  },
  personalAccountId: "10000000-0000-4000-8000-000000000070",
  projection: { asOf: "2026-08-01T00:00:00.000Z", partial: true, stale: false },
  whatsappConnectionId: "20000000-0000-4000-8000-000000000070",
};

const harness = (overrides?: {
  readonly journalFails?: boolean;
  readonly prepared?: PreparedRecipientTransition | null;
}) => {
  const events: SafeTelemetryEvent[] = [];
  const journalled: Array<string> = [];
  const finalized: Array<string> = [];
  const listed: Array<unknown> = [];
  const persistence: RecipientExclusionPersistenceService = {
    finalize: (input) =>
      Effect.sync(() => {
        finalized.push(input.transitionId);
        return {
          effectiveAt: "2026-08-11T00:00:00.000Z",
          excluded: true,
          purgeCutoffAt: "2026-08-11T00:00:00.000Z",
        };
      }),
    list: (input) =>
      Effect.sync(() => {
        listed.push(input);
        return {
          material,
          recipients: [
            {
              displayNameCiphertext: null,
              excluded: false,
              phoneCiphertext: null,
              publicId: contactPublicId,
              recordId: `di1_${"A".repeat(43)}`,
            },
          ],
        };
      }),
    open: (input) =>
      Effect.succeed(
        input.recipients.map((recipient) => ({
          displayName: "Ada",
          excluded: recipient.excluded,
          phoneLastFour: "0123",
          publicId: recipient.publicId,
        })),
      ),
    prepare: () =>
      Effect.succeed(
        overrides?.prepared === undefined
          ? {
              effectiveAt: "2026-08-11T00:00:00.000Z",
              excluded: true,
              outcome: "prepared" as const,
              personalAccountId: material.personalAccountId,
              purgeCutoffAt: "2026-08-11T00:00:00.000Z",
              recipientKind: "contact" as const,
              recipientLocator: `di1_${"A".repeat(43)}`,
              transitionId: "30000000-0000-4000-8000-000000000070",
              whatsappConnectionId: material.whatsappConnectionId,
            }
          : overrides.prepared,
      ),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: () => Effect.succeed("user_exclusion70"),
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(RecipientExclusionPersistence, persistence),
    Layer.succeed(RecipientExclusionClock, {
      now: Effect.succeed("2026-08-11T00:00:00.000Z"),
    }),
    Layer.succeed(RecipientTransitionJournal, {
      append: (input) =>
        overrides?.journalFails === true
          ? Effect.fail(new RecipientExclusionPersistenceError())
          : Effect.sync(() => {
              journalled.push(input.transitionId);
            }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) => Effect.sync(() => events.push(event)),
    }),
  );
  return {
    events,
    finalized,
    handler: createRecipientExclusionHandler(layer, origin),
    journalled,
    listed,
  };
};

const get = (query: string, headers?: Record<string, string>) =>
  new Request(`${listEndpoint}${query}`, {
    headers: { authorization: "Bearer token", origin, ...headers },
    method: "GET",
  });

const put = (body: unknown, contentType = "application/json") =>
  new Request(exclusionEndpoint, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      authorization: "Bearer token",
      "content-type": contentType,
      origin,
    },
    method: "PUT",
  });

describe("WhatsApp Recipient Exclusion HTTP boundary", () => {
  test("returns one page of manageable recipients with Directory qualifiers", async () => {
    const fixture = harness();
    const response = await fixture.handler(get("?kind=contact&limit=1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      directory: {
        as_of: "2026-08-01T00:00:00.000Z",
        partial: true,
        stale: false,
      },
      next_cursor: null,
      recipients: [
        {
          display_name: "Ada",
          excluded: false,
          id: contactPublicId,
          kind: "contact",
          phone_last_four: "0123",
        },
      ],
    });
    // One extra row is requested so the page boundary is known.
    expect(fixture.listed).toEqual([
      {
        clerkUserId: "user_exclusion70",
        connectionPublicId,
        cursorPublicId: null,
        kind: "contact",
        limit: 2,
        search: null,
      },
    ]);
    expect(fixture.events).toEqual([
      {
        event: "recipient_exclusion.list.completed",
        outcome: "success",
        recipientCount: 1,
        service: "api",
      },
    ]);
  });

  test("rejects a duplicate, unknown, or mismatched list parameter", async () => {
    const fixture = harness();
    for (const query of [
      "",
      "?kind=everything",
      "?kind=contact&kind=group",
      "?kind=contact&unexpected=1",
      "?kind=contact&limit=0",
      "?kind=contact&limit=51",
      "?kind=contact&cursor=grp_000000000000000000070",
      "?kind=contact&search=ab",
      "?kind=contact&search=%2B15550123456",
    ]) {
      const response = await fixture.handler(get(query));
      expect([query, response.status]).toEqual([query, 400]);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
  });

  test("answers a foreign Origin with constant-shape not found and no CORS grant", async () => {
    const response = await harness().handler(
      new Request(`${listEndpoint}?kind=contact`, {
        headers: {
          authorization: "Bearer token",
          origin: "https://attacker.example",
        },
        method: "GET",
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  test("journals a transition before acknowledging it", async () => {
    const fixture = harness();
    const response = await fixture.handler(
      put({
        excluded: true,
        expected_excluded: false,
        idempotency_key: "idem-0123456789abcdef",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      exclusion: {
        effective_at: "2026-08-11T00:00:00.000Z",
        excluded: true,
      },
      recipient: { id: contactPublicId, kind: "contact" },
    });
    expect(fixture.journalled).toEqual([
      "30000000-0000-4000-8000-000000000070",
    ]);
    expect(fixture.finalized).toEqual(["30000000-0000-4000-8000-000000000070"]);
    expect(fixture.events).toEqual([
      {
        event: "recipient_exclusion.transition.completed",
        outcome: "success",
        service: "api",
        transitionKind: "exclude",
      },
    ]);
  });

  test("does not acknowledge or finalize when the journal append fails", async () => {
    const fixture = harness({ journalFails: true });
    const response = await fixture.handler(
      put({
        excluded: true,
        expected_excluded: false,
        idempotency_key: "idem-0123456789abcdef",
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(fixture.finalized).toEqual([]);
  });

  test("reports an unchanged request without journalling a transition", async () => {
    const fixture = harness({
      prepared: {
        effectiveAt: null,
        excluded: false,
        outcome: "unchanged",
        personalAccountId: material.personalAccountId,
        purgeCutoffAt: null,
        recipientKind: "contact",
        recipientLocator: `di1_${"A".repeat(43)}`,
        transitionId: null,
        whatsappConnectionId: material.whatsappConnectionId,
      },
    });
    const response = await fixture.handler(
      put({
        excluded: false,
        expected_excluded: false,
        idempotency_key: "idem-0123456789abcdef",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      exclusion: { effective_at: null, excluded: false },
      recipient: { id: contactPublicId, kind: "contact" },
    });
    expect(fixture.journalled).toEqual([]);
    expect(fixture.finalized).toEqual([]);
  });

  test("reports stale expected state as a conflict", async () => {
    const fixture = harness({
      prepared: {
        effectiveAt: "2026-08-11T00:00:00.000Z",
        excluded: true,
        outcome: "conflict",
        personalAccountId: material.personalAccountId,
        purgeCutoffAt: null,
        recipientKind: "contact",
        recipientLocator: `di1_${"A".repeat(43)}`,
        transitionId: null,
        whatsappConnectionId: material.whatsappConnectionId,
      },
    });
    const response = await fixture.handler(
      put({
        excluded: true,
        expected_excluded: false,
        idempotency_key: "idem-0123456789abcdef",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "exclusion_conflict" });
    expect(fixture.journalled).toEqual([]);
  });

  test("returns constant-shape not found for an unresolvable recipient handle", async () => {
    const fixture = harness({ prepared: null });
    const response = await fixture.handler(
      put({
        excluded: true,
        expected_excluded: false,
        idempotency_key: "idem-0123456789abcdef",
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  test("fails closed on an unknown field, bad key, or unsupported content type", async () => {
    const fixture = harness();
    for (const body of [
      {
        excluded: true,
        expected_excluded: false,
        idempotency_key: "idem-0123456789abcdef",
        unexpected: 1,
      },
      { excluded: true, expected_excluded: false },
      { excluded: true, expected_excluded: false, idempotency_key: "short" },
      {
        excluded: "yes",
        expected_excluded: false,
        idempotency_key: "a".repeat(20),
      },
    ]) {
      const response = await fixture.handler(put(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    const wrongType = await fixture.handler(
      put(
        {
          excluded: true,
          expected_excluded: false,
          idempotency_key: "idem-0123456789abcdef",
        },
        "text/plain",
      ),
    );
    expect(wrongType.status).toBe(400);
    expect(fixture.journalled).toEqual([]);
  });

  test("answers preflight with the exact browser Origin", async () => {
    const response = await harness().handler(
      new Request(exclusionEndpoint, {
        headers: { origin },
        method: "OPTIONS",
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET,OPTIONS,PUT",
    );
  });
});
