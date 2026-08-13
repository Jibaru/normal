import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/migrations";
import {
  makeOnboardingProfileRepository,
  type OnboardingProfileConnectionProvider,
} from "../src/onboarding-profile";
import { makePersonalAccountRepository } from "../src/personal-account";

const accountId = "10000000-0000-4000-8000-000000000010";
const otherAccountId = "10000000-0000-4000-8000-000000000011";
const clerkUserId = "user_onboardingprofile1";
const otherClerkUserId = "user_onboardingother2";

describe("Onboarding profile repository", () => {
  let database: PGlite;
  let provider: OnboardingProfileConnectionProvider;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE neon_superuser NOLOGIN BYPASSRLS;
      CREATE ROLE whatsapp_api_runtime LOGIN;
      CREATE ROLE whatsapp_webhook_runtime LOGIN;
      GRANT neon_superuser TO whatsapp_api_runtime;
      GRANT neon_superuser TO whatsapp_webhook_runtime;
    `);
    await runMigrations(database);
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
});
