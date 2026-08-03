import { describe, expect, test, vi } from "vitest";
import { createProductionScheduledHandler } from "../src/production";

describe("Personal Account purge schedule", () => {
  test("reports deadline risk without emitting tenant identifiers", async () => {
    const marker = "c".repeat(64);
    const purges: Array<unknown> = [];
    const events: Array<string> = [];
    const info = vi.spyOn(console, "info").mockImplementation((event) => {
      events.push(String(event));
    });
    let candidatePage = 0;
    let expiryPage = 0;
    const handler = createProductionScheduledHandler(
      {
        HYPERDRIVE: { connectionString: "test-connection-string" },
      },
      {
        makeGroupRepository: () => ({ claim: async () => [] }),
        makePersonalAccountRepository: () => ({
          listDeletionPurgeCandidates: async () =>
            candidatePage++ === 0
              ? [
                  {
                    deadlineAt: "2026-08-04T01:00:00.000Z",
                    deadlineRisk: true,
                    deletionMarkerId: marker,
                    requestedAt: "2026-08-03T01:00:00.000Z",
                  },
                ]
              : [],
          purgeDeletion: async (input) => {
            purges.push(input);
            return true;
          },
          purgeExpiredDeletionRecords: async () =>
            expiryPage++ === 0 ? 500 : 0,
        }),
        purgeExpiredMessages: async () => 0,
        purgeExpiredToolCallLogs: async () => 0,
        retainWebhookSources: async () => undefined,
      },
    );

    try {
      await handler({
        cron: "0 * * * *",
        scheduledTime: Date.parse("2026-08-04T00:00:00.000Z"),
      } as ScheduledController);
    } finally {
      info.mockRestore();
    }

    expect(purges).toEqual([
      {
        completedAt: "2026-08-04T00:00:00.000Z",
        deletionMarkerId: marker,
      },
    ]);
    expect(events).toContain(
      JSON.stringify({
        deadlineAt: "2026-08-04T01:00:00.000Z",
        event: "personal_account.deletion.deadline_risk",
        marker,
        service: "api",
      }),
    );
  });
});
