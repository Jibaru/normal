import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/migrations";
import {
  makePersonalAccountRepository,
  type PersonalAccountConnectionProvider,
} from "../src/personal-account";

const accountId = "10000000-0000-4000-8000-000000000010";

describe("Personal Account repository", () => {
  let database: PGlite;
  let provider: PersonalAccountConnectionProvider;

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
  });

  afterEach(async () => {
    await database.close();
  });

  test("resolves, creates, and recovers through restricted bootstrap functions", async () => {
    const repository = makePersonalAccountRepository(provider);

    await expect(repository.resolve("user_repository123")).resolves.toBeNull();
    await expect(
      repository.create({
        clerkUserId: "user_repository123",
        keyCiphertext: new Uint8Array([1, 2, 3]),
        keyVersion: 1,
        kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
        personalAccountId: accountId,
        providerApprovedSessionCapacity: 3,
      }),
    ).resolves.toEqual({
      admissionState: "active",
      created: true,
      messageRetentionDays: 30,
      personalAccountId: accountId,
      storedMediaLimitBytes: 5_368_709_120,
      whatsappConnectionLimit: 3,
    });
    await expect(repository.resolve("user_repository123")).resolves.toEqual({
      admissionState: "active",
      keyAvailable: true,
      messageRetentionDays: 30,
      personalAccountId: accountId,
      storedMediaLimitBytes: 5_368_709_120,
      whatsappConnectionLimit: 3,
    });
    await expect(
      repository.create({
        clerkUserId: "user_repository123",
        keyCiphertext: new Uint8Array([4, 5, 6]),
        keyVersion: 1,
        kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
        personalAccountId: "10000000-0000-4000-8000-000000000011",
        providerApprovedSessionCapacity: 3,
      }),
    ).resolves.toEqual({
      admissionState: "active",
      created: false,
      messageRetentionDays: 30,
      personalAccountId: accountId,
      storedMediaLimitBytes: 5_368_709_120,
      whatsappConnectionLimit: 3,
    });
  });

  test("returns one safe absence for a deleting identity", async () => {
    const repository = makePersonalAccountRepository(provider);
    await repository.create({
      clerkUserId: "user_repository123",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountId,
      providerApprovedSessionCapacity: 3,
    });
    await database.query(
      "UPDATE app.personal_accounts SET state = 'deleting' WHERE id = $1",
      [accountId],
    );

    await expect(repository.resolve("user_repository123")).resolves.toBeNull();
    await expect(
      repository.create({
        clerkUserId: "user_repository123",
        keyCiphertext: new Uint8Array([4, 5, 6]),
        keyVersion: 1,
        kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
        personalAccountId: "10000000-0000-4000-8000-000000000011",
        providerApprovedSessionCapacity: 3,
      }),
    ).resolves.toBeNull();
  });

  test("creates and resolves one idempotent waitlist entry at capacity", async () => {
    const repository = makePersonalAccountRepository(provider);
    await repository.create({
      clerkUserId: "user_admitted",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountId,
      providerApprovedSessionCapacity: 3,
    });

    const first = await repository.create({
      clerkUserId: "user_waitlisted",
      keyCiphertext: new Uint8Array([4, 5, 6]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: "10000000-0000-4000-8000-000000000011",
      providerApprovedSessionCapacity: 3,
    });
    const replay = await repository.create({
      clerkUserId: "user_waitlisted",
      keyCiphertext: new Uint8Array([7, 8, 9]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: "10000000-0000-4000-8000-000000000012",
      providerApprovedSessionCapacity: 3,
    });

    expect(first).toEqual({ admissionState: "waitlisted" });
    expect(replay).toEqual({ admissionState: "waitlisted" });
    await expect(repository.resolve("user_waitlisted")).resolves.toEqual({
      admissionState: "waitlisted",
    });

    const persisted = await database.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM app_private.private_beta_waitlist
       WHERE clerk_user_id = 'user_waitlisted'`,
    );
    expect(persisted.rows).toEqual([{ count: 1 }]);
  });
});
