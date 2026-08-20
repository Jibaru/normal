import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  makeOnboardingProfileRepository,
  type OnboardingProfileConnectionProvider,
} from "../src/onboarding-profile";
import { makePersonalAccountRepository } from "../src/personal-account";
import { createMigratedDatabase } from "./support/migrated-database";

const accountId = "10000000-0000-4000-8000-000000000010";
const otherAccountId = "10000000-0000-4000-8000-000000000011";
const clerkUserId = "user_onboardingprofile1";
const otherClerkUserId = "user_onboardingother2";

describe("Onboarding profile repository", () => {
  let database: PGlite;
  let provider: OnboardingProfileConnectionProvider;

  beforeEach(async () => {
    database = await createMigratedDatabase();
    provider = {
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    const accounts = makePersonalAccountRepository(provider);
    await accounts.create({
      clerkUserId,
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountId,
    });
    await accounts.create({
      clerkUserId: otherClerkUserId,
      keyCiphertext: new Uint8Array([4, 5, 6]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: otherAccountId,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("reads and upserts one completed profile per Personal Account", async () => {
    const repository = makeOnboardingProfileRepository(provider);

    await expect(repository.getForUser(clerkUserId)).resolves.toEqual({
      accessible: true,
      profile: null,
    });
    await expect(
      repository.isFirstConnectionSetupEligible(clerkUserId),
    ).resolves.toBe(false);

    const created = await repository.upsertForUser({
      clerkUserId,
      intendedMcpClient: "claude",
      primaryUseCase: "conversation_search",
      researchCallInterest: "yes",
      role: "engineer",
      updatedAt: "2026-08-13T12:00:00.000Z",
      whatsappUsageContext: "personal",
    });
    expect(created).toMatchObject({
      intendedMcpClient: "claude",
      primaryUseCase: "conversation_search",
      researchCallInterest: "yes",
      role: "engineer",
      whatsappUsageContext: "personal",
    });
    expect(created?.completedAt).toBe("2026-08-13T12:00:00.000Z");
    expect(created?.securityCompletedAt).toBeNull();
    await expect(
      repository.isFirstConnectionSetupEligible(clerkUserId),
    ).resolves.toBe(false);

    const securityCompleted = await repository.markSecurityCompletedForUser({
      clerkUserId,
      completedAt: "2026-08-13T12:30:00.000Z",
    });
    expect(securityCompleted?.securityCompletedAt).toBe(
      "2026-08-13T12:30:00.000Z",
    );
    await expect(
      repository.isFirstConnectionSetupEligible(clerkUserId),
    ).resolves.toBe(true);
    const replayedSecurity = await repository.markSecurityCompletedForUser({
      clerkUserId,
      completedAt: "2026-08-13T12:45:00.000Z",
    });
    expect(replayedSecurity?.securityCompletedAt).toBe(
      "2026-08-13T12:30:00.000Z",
    );

    const updated = await repository.upsertForUser({
      clerkUserId,
      intendedMcpClient: "chatgpt",
      primaryUseCase: "summaries",
      researchCallInterest: "no",
      role: "founder_or_owner",
      updatedAt: "2026-08-13T13:00:00.000Z",
      whatsappUsageContext: "work",
    });
    expect(updated).toMatchObject({
      intendedMcpClient: "chatgpt",
      primaryUseCase: "summaries",
      researchCallInterest: "no",
      role: "founder_or_owner",
      whatsappUsageContext: "work",
    });
    expect(updated?.completedAt).toBe("2026-08-13T12:00:00.000Z");
    expect(updated?.updatedAt).toBe("2026-08-13T13:00:00.000Z");
    expect(updated?.securityCompletedAt).toBe("2026-08-13T12:30:00.000Z");

    await expect(repository.getForUser(clerkUserId)).resolves.toEqual({
      accessible: true,
      profile: updated,
    });
    await expect(
      repository.isFirstConnectionSetupEligible(clerkUserId),
    ).resolves.toBe(true);
  });

  test("isolates profiles across Personal Accounts through RLS-backed functions", async () => {
    const repository = makeOnboardingProfileRepository(provider);
    await repository.upsertForUser({
      clerkUserId,
      intendedMcpClient: "claude",
      primaryUseCase: "exploration",
      researchCallInterest: "not_sure",
      role: "other",
      updatedAt: "2026-08-13T12:00:00.000Z",
      whatsappUsageContext: "both",
    });

    await expect(repository.getForUser(otherClerkUserId)).resolves.toEqual({
      accessible: true,
      profile: null,
    });
    await expect(
      repository.isFirstConnectionSetupEligible(otherClerkUserId),
    ).resolves.toBe(false);

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const visible = await database.query(
        "SELECT personal_account_id FROM public.personal_account_onboarding_profiles",
      );
      expect(visible.rows).toEqual([]);
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("purges the profile with Personal Account deletion", async () => {
    const accounts = makePersonalAccountRepository(provider);
    const repository = makeOnboardingProfileRepository(provider);
    await repository.upsertForUser({
      clerkUserId,
      intendedMcpClient: "other",
      primaryUseCase: "other",
      researchCallInterest: "no",
      role: "not_sure",
      updatedAt: "2026-08-13T12:00:00.000Z",
      whatsappUsageContext: "personal",
    });

    const prepared = await accounts.prepareDeletion({
      clerkUserId,
      observedAt: "2026-08-13T14:00:00.000Z",
    });
    expect(prepared?.state).toBe("deleting");
    await expect(repository.getForUser(clerkUserId)).resolves.toEqual({
      accessible: false,
    });

    const finished = await accounts.finishDeletion({
      clerkUserId,
      deletionMarkerId: "a".repeat(64),
      requestedAt: prepared?.requestedAt ?? "",
    });
    expect(finished).toBe(true);
    await accounts.purgeDeletion({
      completedAt: "2026-08-13T15:00:00.000Z",
      deletionMarkerId: "a".repeat(64),
    });

    const remaining = await database.query(
      "SELECT COUNT(*)::int AS count FROM public.personal_account_onboarding_profiles",
    );
    expect(remaining.rows[0]).toEqual({ count: 0 });
  });

  test("keeps a terminally deleted profile unreadable after restore replay", async () => {
    const repository = makeOnboardingProfileRepository(provider);
    await repository.upsertForUser({
      clerkUserId,
      intendedMcpClient: "claude",
      primaryUseCase: "follow_ups",
      researchCallInterest: "yes",
      role: "operations_or_support",
      updatedAt: "2026-08-13T12:00:00.000Z",
      whatsappUsageContext: "work",
    });
    await repository.upsertForUser({
      clerkUserId: otherClerkUserId,
      intendedMcpClient: "chatgpt",
      primaryUseCase: "draft_replies",
      researchCallInterest: "no",
      role: "product_or_design",
      updatedAt: "2026-08-13T12:00:00.000Z",
      whatsappUsageContext: "both",
    });

    await database.exec("SET ROLE whatsapp_restore_runtime");
    try {
      await database.query(
        "SELECT * FROM public.begin_restore_replay('br-onboarding-70','2026-08-13T16:00:00Z')",
      );
      const replay = await database.query<{ replayed: boolean }>(
        `SELECT public.replay_restore_deletion(
          'personal_account', $1, $2, '2026-08-13T16:00:00Z'
        ) AS replayed`,
        [accountId, "b".repeat(64)],
      );
      expect(replay.rows).toEqual([{ replayed: true }]);
    } finally {
      await database.exec("RESET ROLE");
    }

    await expect(repository.getForUser(clerkUserId)).resolves.toEqual({
      accessible: false,
    });
    const remaining = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM public.personal_account_onboarding_profiles
       WHERE personal_account_id = $1`,
      [accountId],
    );
    expect(remaining.rows[0]).toEqual({ count: 0 });
    await expect(
      repository.getForUser(otherClerkUserId),
    ).resolves.toMatchObject({
      accessible: true,
      profile: {
        intendedMcpClient: "chatgpt",
        primaryUseCase: "draft_replies",
      },
    });
  });
});
