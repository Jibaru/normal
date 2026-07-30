import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted, Stream } from "effect";
import {
  type LifecycleSession,
  type LifecycleSessionLocator,
  type SessionAuthority,
  SessionLifecycle,
  type SetupMarker,
} from "../src/control";
import {
  type ContactLocator,
  type DirectoryContact,
  type DirectoryGroup,
  type DirectoryObservation,
  type GroupLocator,
  MediaRetrieval,
  type MediaSource,
  makeBoundedRetryAfterMs,
  makeMediaDownloadByteLimit,
  SessionDirectory,
  type StableMessageIdentity,
  TextSending,
} from "../src/session";
import {
  type NormalizedWebhookDelivery,
  type NormalizedWebhookItem,
  WebhookNormalization,
} from "../src/webhook";

const setupMarker = "setup-marker" as SetupMarker;
const session = "sealed-session" as LifecycleSessionLocator;
const sessionAuthority = Redacted.make("session-authority") as SessionAuthority;
const contact = "sealed-contact" as ContactLocator;
const group = "sealed-group" as GroupLocator;
const messageIdentity = "keyed-message-identity" as StableMessageIdentity;
const mediaSource = Redacted.make("media-source") as MediaSource;

const lifecycleSession: LifecycleSession = {
  authority: sessionAuthority,
  connectionState: "connecting",
  session,
};

const contactEntry: DirectoryContact = {
  active: true,
  displayName: "Ada",
  phoneNumber: "+15550199",
  recipient: contact,
};

const contacts: DirectoryObservation<DirectoryContact> = {
  completeness: "complete",
  entries: [contactEntry],
  observedAt: "2026-07-30T12:00:00Z",
  stale: false,
};

const webhookDelivery: NormalizedWebhookDelivery = {
  items: [
    {
      direction: "outbound",
      evidence: {
        occurredAt: "2026-07-30T12:00:00Z",
        version: null,
      },
      itemIdentity: null,
      itemIndex: 0,
      kind: "send_evidence",
      messageIdentity,
      status: "delivered",
    },
    {
      classification: "unsupported_item_kind",
      itemIndex: 1,
      kind: "unsupported",
    },
  ],
};

const evidence = {
  occurredAt: "2026-07-30T12:00:00Z",
  version: null,
} as const;

const normalizedItemKinds = [
  {
    content: {
      mediaSource: null,
      text: "hello",
      type: "text",
    },
    direction: "inbound",
    evidence,
    itemIdentity: null,
    itemIndex: 0,
    kind: "message_upsert",
    messageIdentity,
    recipient: contact,
    sender: contact,
    sentAt: "2026-07-30T12:00:00Z",
  },
  {
    content: {
      mediaSource: null,
      text: "edited",
      type: "text",
    },
    editedAt: "2026-07-30T12:01:00Z",
    evidence,
    itemIdentity: null,
    itemIndex: 1,
    kind: "message_edit",
    messageIdentity,
  },
  {
    deletedAt: "2026-07-30T12:02:00Z",
    evidence,
    itemIdentity: null,
    itemIndex: 2,
    kind: "message_delete",
    messageIdentity,
  },
  {
    direction: "outbound",
    evidence,
    itemIdentity: null,
    itemIndex: 3,
    kind: "send_evidence",
    messageIdentity,
    status: "delivered",
  },
  {
    contact: contactEntry,
    evidence,
    itemIdentity: null,
    itemIndex: 4,
    kind: "directory_contact",
  },
  {
    evidence,
    group: {
      displayName: "Family",
      joined: true,
      recipient: group,
    } satisfies DirectoryGroup,
    itemIdentity: null,
    itemIndex: 5,
    kind: "directory_group",
  },
  {
    evidence,
    itemIdentity: null,
    itemIndex: 6,
    kind: "connection_state",
    state: "connected",
  },
  {
    classification: "unsupported_item_kind",
    itemIndex: 7,
    kind: "unsupported",
  },
  {
    classification: "invalid_item_shape",
    itemIndex: 8,
    kind: "malformed",
  },
] satisfies ReadonlyArray<NormalizedWebhookItem>;

describe("provider-neutral capability seam", () => {
  test("keeps lifecycle authority separate and reconcile-before-write", async () => {
    let reconciliations = 0;
    let creates = 0;

    const layer = Layer.succeed(SessionLifecycle, {
      connectSession: () => Effect.succeed(lifecycleSession),
      createSession: () => {
        creates += 1;
        return Effect.succeed(lifecycleSession);
      },
      deleteSession: () => Effect.succeed({ state: "present" }),
      getQrCode: () => Effect.succeed({ state: "not_available" }),
      listSessions: () => Effect.succeed([]),
      reconcileSession: () => {
        reconciliations += 1;
        return Effect.succeed({ outcome: "absent" });
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* SessionLifecycle;
        const reconciliation = yield* lifecycle.reconcileSession({
          setupMarker,
        });
        if (reconciliation.outcome === "absent") {
          return yield* lifecycle.createSession({ setupMarker });
        }
        return null;
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual(lifecycleSession);
    expect(JSON.stringify(result)).not.toContain("session-authority");
    expect({ creates, reconciliations }).toEqual({
      creates: 1,
      reconciliations: 1,
    });
  });

  test("uses independent per-session Directory, send, and media capabilities", async () => {
    const byteLimit = makeMediaDownloadByteLimit(5_000_000);
    const layer = Layer.mergeAll(
      Layer.succeed(SessionDirectory, {
        readContacts: () => Effect.succeed(contacts),
        readGroups: () =>
          Effect.succeed({
            completeness: "complete",
            entries: [],
            observedAt: "2026-07-30T12:00:00Z",
            stale: false,
          }),
      }),
      Layer.succeed(TextSending, {
        sendText: ({ text }) =>
          Effect.succeed({
            messageIdentity,
            outcome: "identity_evidence",
            status: text === "hello" ? "sent" : "accepted",
          }),
      }),
      Layer.succeed(MediaRetrieval, {
        download: ({ maxBytes }) =>
          Effect.succeed({
            maxBytes,
            stream: Stream.empty,
          }),
        getMetadata: () =>
          Effect.succeed({
            expectedSizeBytes: 4,
            fileName: "photo.jpg",
            mimeType: "image/jpeg",
            source: mediaSource,
          }),
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* SessionDirectory;
        const sending = yield* TextSending;
        const media = yield* MediaRetrieval;
        const directoryResult = yield* directory.readContacts();
        const sendResult = yield* sending.sendText({
          recipient: contact,
          text: "hello",
        });
        const metadata = yield* media.getMetadata({
          source: mediaSource,
        });
        const download = yield* media.download({
          maxBytes: byteLimit,
          source: metadata.source,
        });
        return { directoryResult, download, metadata, sendResult };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.directoryResult).toEqual(contacts);
    expect(result.sendResult).toEqual({
      messageIdentity,
      outcome: "identity_evidence",
      status: "sent",
    });
    expect(Number(result.download.maxBytes)).toBe(5_000_000);
    expect(JSON.stringify(result.metadata)).not.toContain("media-source");
  });

  test("normalizes every webhook item independently", async () => {
    const layer = Layer.succeed(WebhookNormalization, {
      normalize: () => Effect.succeed(webhookDelivery),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const normalizer = yield* WebhookNormalization;
        return yield* normalizer.normalize({
          payload: new Uint8Array([123, 125]),
          receivedAt: "2026-07-30T12:00:01Z",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.kind)).toEqual([
      "send_evidence",
      "unsupported",
    ]);
    expect(JSON.stringify(result)).not.toContain("wasender");
  });

  test("fixes the supported provider-neutral webhook item kinds", () => {
    expect(normalizedItemKinds.map((item) => item.kind)).toEqual([
      "message_upsert",
      "message_edit",
      "message_delete",
      "send_evidence",
      "directory_contact",
      "directory_group",
      "connection_state",
      "unsupported",
      "malformed",
    ]);
  });

  test("rejects unbounded media download limits", () => {
    expect(() => makeMediaDownloadByteLimit(0)).toThrow(RangeError);
    expect(() => makeMediaDownloadByteLimit(100_000_001)).toThrow(RangeError);
    expect(() => makeMediaDownloadByteLimit(1.5)).toThrow(RangeError);
  });

  test("caps Retry-After within the safe-read policy", () => {
    expect(Number(makeBoundedRetryAfterMs(250))).toBe(250);
    expect(Number(makeBoundedRetryAfterMs(25_000))).toBe(5_000);
    expect(() => makeBoundedRetryAfterMs(-1)).toThrow(RangeError);
  });
});
