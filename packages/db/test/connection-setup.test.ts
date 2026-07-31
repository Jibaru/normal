import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type ConnectionSetupConnectionProvider,
  makeConnectionSetupRepository,
} from "../src/connection-setup";
import { runMigrations } from "../src/migrations";
import {
  makePersonalAccountRepository,
  type PersonalAccountConnectionProvider,
} from "../src/personal-account";

const accountA = "10000000-0000-4000-8000-000000000021";
const accountB = "10000000-0000-4000-8000-000000000022";
const createdAt = "2026-07-31T12:00:00.000Z";

describe("Connection Setup repository", () => {
  let database: PGlite;
  let provider: ConnectionSetupConnectionProvider &
    PersonalAccountConnectionProvider;

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
      clerkUserId: "user_setupa",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountA,
      providerApprovedSessionCapacity: 6,
    });
    await accounts.create({
      clerkUserId: "user_setupb",
      keyCiphertext: new Uint8Array([4, 5, 6]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountB,
      providerApprovedSessionCapacity: 6,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  const startInput = (
    personalAccountId: string,
    setupId: string,
    idempotencyKey: string,
    numberToken: number,
  ) => ({
    accountKeyVersion: 1,
    connectionKeyCiphertext: new Uint8Array(32).fill(numberToken),
    connectionKeyNonce: new Uint8Array(12).fill(numberToken),
    connectionKeyVersion: 1,
    createdAt,
    idempotencyKey,
    numberCiphertext: new Uint8Array(32).fill(numberToken),
    numberCiphertextNonce: new Uint8Array(12).fill(numberToken),
    numberCiphertextVersion: 1,
    numberKeyVersion: 1,
    numberToken: new Uint8Array(32).fill(numberToken),
    personalAccountId,
    setupId,
  });

  test("creates one durable 15-minute setup and returns its exact replay", async () => {
    const repository = makeConnectionSetupRepository(provider);
    const prepared = await repository.prepare({
      clerkUserId: "user_setupa",
      idempotencyKey: "123456789012345678901",
      numberToken: new Uint8Array(32).fill(1),
    });
    expect(prepared).toMatchObject({
      outcome: "unbound",
      whatsappConnectionLimit: 3,
    });

    const first = await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000001",
        "123456789012345678901",
        1,
      ),
    );
    const replay = await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000002",
        "123456789012345678901",
        1,
      ),
    );

    expect(first).toEqual({
      outcome: "created",
      setup: {
        createdAt,
        expiresAt: "2026-07-31T12:15:00.000Z",
        setupId: "cst_000000000000000000001",
        state: "provisioning_pending",
      },
    });
    if (!("setup" in first)) {
      throw new Error("expected a created Connection Setup");
    }
    expect(replay).toEqual({
      outcome: "replay",
      setup: first.setup,
    });

    const persisted = await database.query<{
      expires_at: Date;
      setup_count: number;
    }>(`
      SELECT
        count(*)::integer AS setup_count,
        max(expires_at) AS expires_at
      FROM app.connection_setups
    `);
    expect(persisted.rows[0]?.setup_count).toBe(1);
    expect(persisted.rows[0]?.expires_at).toEqual(
      new Date("2026-07-31T12:15:00.000Z"),
    );
  });

  test("rejects changed input, a globally reserved number, and excess retained Connections", async () => {
    const repository = makeConnectionSetupRepository(provider);
    const first = await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000001",
        "123456789012345678901",
        1,
      ),
    );
    expect(first.outcome).toBe("created");

    await expect(
      repository.start(
        startInput(
          accountA,
          "cst_000000000000000000002",
          "123456789012345678901",
          2,
        ),
      ),
    ).resolves.toEqual({ outcome: "idempotency_conflict" });
    await expect(
      repository.start(
        startInput(
          accountB,
          "cst_000000000000000000003",
          "223456789012345678901",
          1,
        ),
      ),
    ).resolves.toEqual({ outcome: "number_unavailable" });

    for (let index = 2; index <= 3; index += 1) {
      await repository.start(
        startInput(
          accountA,
          `cst_${String(index).padStart(21, "0")}`,
          `${index}23456789012345678901`,
          index,
        ),
      );
    }
    await expect(
      repository.start(
        startInput(
          accountA,
          "cst_000000000000000000004",
          "423456789012345678901",
          4,
        ),
      ),
    ).resolves.toEqual({ outcome: "connection_limit_reached" });
  });

  test("keeps setup rows isolated under the restricted API role", async () => {
    const repository = makeConnectionSetupRepository(provider);
    await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000001",
        "123456789012345678901",
        1,
      ),
    );
    await repository.start(
      startInput(
        accountB,
        "cst_000000000000000000002",
        "223456789012345678901",
        2,
      ),
    );

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountA],
      );
      const visible = await database.query<{ id: string }>(
        "SELECT id FROM app.connection_setups ORDER BY id",
      );
      expect(visible.rows).toEqual([{ id: "cst_000000000000000000001" }]);
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });
});
