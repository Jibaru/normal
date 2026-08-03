import { deriveDeletionMarkerId } from "@whatsapp-mcp/api/deletion/marker";
import { Effect, Redacted } from "effect";
import { describe, expect, test, vi } from "vitest";
import { replayRestore } from "../src/replay";

describe("restore replay", () => {
  test("re-purges a matching locked marker, expiry, and objects before readiness", async () => {
    const secret = Redacted.make("ab".repeat(32));
    const markerId = await deriveDeletionMarkerId(
      "production",
      secret,
      "personal_account",
      "10000000-0000-4000-8000-000000000001",
    );
    const calls: string[] = [];
    const result = await replayRestore({
      branchId: "br-restored",
      environment: "production",
      hmacSecret: secret,
      observedAt: "2026-08-03T12:00:00.000Z",
      markers: {
        create: vi.fn(),
        enumerate: () =>
          Effect.succeed([
            {
              markerId,
              objectKey: `markers/v1/${markerId}.json`,
              marker: {
                version: 1,
                deletionKind: "personal_account",
                requestedAt: "2026-08-01T00:00:00.000Z",
                keyUnavailableAt: "2026-08-01T00:01:00.000Z",
              },
            },
          ]),
      },
      buckets: {
        stored_media: {
          delete: async () => {
            calls.push("delete-object");
          },
        },
        webhook_ingress: {
          delete: async () => {
            calls.push("delete-webhook");
          },
        },
      },
      repository: {
        begin: async () => [
          {
            deletionKind: "personal_account",
            opaqueEntityId: "10000000-0000-4000-8000-000000000001",
          },
        ],
        replayDeletion: async () => {
          calls.push("replay-marker");
          return true;
        },
        purgeExpired: async () => {
          calls.push("expire");
          return 2;
        },
        listObjectDeletions: async () =>
          calls.includes("delete-object")
            ? []
            : [{ bucket: "stored_media", objectKey: "opaque/object" }],
        finishObjectDeletion: async () => {
          calls.push("finish-object");
        },
        complete: async () => {
          calls.push("ready");
        },
      },
    });
    expect(result).toEqual({
      deletedEntityCount: 1,
      expiredRecordCount: 2,
      markerCount: 1,
    });
    expect(calls).toEqual([
      "replay-marker",
      "expire",
      "delete-object",
      "finish-object",
      "ready",
    ]);
  });
});
