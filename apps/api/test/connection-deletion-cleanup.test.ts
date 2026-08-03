import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { makeConnectionDeletionActiveDataPurger } from "../src/deletion/connection-cleanup";

describe("Connection Deletion active-data purge", () => {
  test("deletes objects before releasing media quota and finalizing Neon cleanup", async () => {
    const calls: Array<string> = [];
    const purge = makeConnectionDeletionActiveDataPurger({
      clock: () => "2026-08-01T12:00:00.000Z",
      persistence: {
        prepare: async () => ({
          personalAccountId: "10000000-0000-4000-8000-000000000001",
          storedMediaObjectKeys: ["media/one"],
          webhookSourceObjectKeys: ["webhook-events/two"],
        }),
        finishStoredMediaObjectDeletion: async ({ objectKey }) => {
          calls.push(`quota:${objectKey}`);
        },
        finishWebhookSourceDeletion: async ({ objectKey }) => {
          calls.push(`webhook-db:${objectKey}`);
          return true;
        },
        finish: async () => {
          calls.push("neon");
          return true;
        },
      },
      storedMedia: {
        delete: async (key) => {
          calls.push(`stored:${key}`);
        },
      },
      webhookSources: {
        delete: async (key) => {
          calls.push(`webhook:${key}`);
        },
      },
    });

    const result = await Effect.runPromise(
      purge({ deletionMarkerId: "a".repeat(64) }),
    );

    expect(result).toEqual({ state: "complete" });
    expect(calls).toEqual([
      "stored:media/one",
      "quota:media/one",
      "webhook:webhook-events/two",
      "webhook-db:webhook-events/two",
      "neon",
    ]);
  });

  test("does not release quota or finalize when object deletion fails", async () => {
    const calls: Array<string> = [];
    const purge = makeConnectionDeletionActiveDataPurger({
      clock: () => "2026-08-01T12:00:00.000Z",
      persistence: {
        prepare: async () => ({
          personalAccountId: "10000000-0000-4000-8000-000000000001",
          storedMediaObjectKeys: ["media/one"],
          webhookSourceObjectKeys: [],
        }),
        finishStoredMediaObjectDeletion: async () => {
          calls.push("quota");
        },
        finishWebhookSourceDeletion: async () => true,
        finish: async () => {
          calls.push("neon");
          return true;
        },
      },
      storedMedia: {
        delete: async () => {
          throw new Error("R2 unavailable");
        },
      },
      webhookSources: { delete: async () => undefined },
    });

    await expect(
      Effect.runPromise(purge({ deletionMarkerId: "a".repeat(64) })),
    ).rejects.toThrow("R2 unavailable");
    expect(calls).toEqual([]);
  });
});
