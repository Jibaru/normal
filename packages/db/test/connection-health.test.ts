import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type ConnectionHealthConnectionProvider,
  makeConnectionHealthRepository,
} from "../src/connection-health";
import {
  type ConnectionSetupConnectionProvider,
  makeConnectionSetupRepository,
} from "../src/connection-setup";
import { runMigrations } from "../src/migrations";
import {
  makePersonalAccountRepository,
  type PersonalAccountConnectionProvider,
} from "../src/personal-account";
import {
  makeWhatsAppConnectionRepository,
  type WhatsAppConnectionConnectionProvider,
} from "../src/whatsapp-connection";

const accountId = "10000000-0000-4000-8000-000000000036";
const setupId = "cst_000000000000000000036";
const connectionId = "20000000-0000-4000-8000-000000000036";
const webhookIngressId = "30000000-0000-4000-8000-000000000036";
const connectedAt = "2026-07-31T12:04:00.000Z";

describe("connection health and Ingestion Gap repository", () => {
  let database: PGlite;
  let provider: ConnectionHealthConnectionProvider &
    ConnectionSetupConnectionProvider &
    PersonalAccountConnectionProvider &
    WhatsAppConnectionConnectionProvider;

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
    const account = await accounts.create({
      clerkUserId: "user_connectionhealth",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountId,
      providerApprovedSessionCapacity: 6,
    });
    expect(account).toMatchObject({
      admissionState: "active",
      personalAccountId: accountId,
    });
    const setups = makeConnectionSetupRepository(provider);
    await setups.start({
      accountKeyVersion: 1,
      connectionKeyCiphertext: new Uint8Array(32).fill(3),
      connectionKeyNonce: new Uint8Array(12).fill(4),
      connectionKeyVersion: 1,
      createdAt: "2026-07-31T12:00:00.000Z",
      idempotencyKey: "123456789012345678936",
      numberCiphertext: new Uint8Array(32).fill(5),
      numberCiphertextNonce: new Uint8Array(12).fill(6),
      numberCiphertextVersion: 1,
      numberKeyVersion: 1,
      numberToken: new Uint8Array(32).fill(7),
      personalAccountId: accountId,
      setupId,
    });
    await database.query(
      `UPDATE app.connection_setups
       SET webhook_ingress_id = $1
       WHERE id = $2`,
      [webhookIngressId, setupId],
    );
    const workerId = "cspw_0000000000000000000000000000000000000000036";
    await setups.claimProvisioning({
      claimedAt: "2026-07-31T12:01:00.000Z",
      setupId,
      workerId,
    });
    await setups.finishProvisioning({
      observedAt: "2026-07-31T12:01:01.000Z",
      outcome: "provisioned",
      sessions: [
        {
          authorityCiphertext: new Uint8Array(32).fill(8),
          authorityCiphertextVersion: 1,
          authorityKeyVersion: 1,
          authorityNonce: new Uint8Array(12).fill(9),
          locatorCiphertext: new Uint8Array(32).fill(10),
          locatorCiphertextVersion: 1,
          locatorKeyVersion: 1,
          locatorNonce: new Uint8Array(12).fill(11),
          ordinal: 0,
        },
      ],
      setupId,
      workerId,
    });
    await makeWhatsAppConnectionRepository(provider).activate({
      accountKeyVersion: 1,
      authorityCiphertext: new Uint8Array(32).fill(12),
      authorityCiphertextVersion: 1,
      authorityKeyVersion: 1,
      authorityNonce: new Uint8Array(12).fill(13),
      connectionId,
      connectionKeyCiphertext: new Uint8Array(32).fill(14),
      connectionKeyNonce: new Uint8Array(12).fill(15),
      connectionKeyVersion: 1,
      connectedAt,
      locatorCiphertext: new Uint8Array(32).fill(16),
      locatorCiphertextVersion: 1,
      locatorKeyVersion: 1,
      locatorNonce: new Uint8Array(12).fill(17),
      numberSuffix: "3636",
      personalAccountId: accountId,
      publicId: "con_000000000000000000036",
      setupId,
      webhookIngressId,
      webhookSecretCiphertext: new Uint8Array(48).fill(18),
      webhookSecretCiphertextVersion: 1,
      webhookSecretKeyVersion: 1,
      webhookSecretNonce: new Uint8Array(12).fill(19),
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("leases due checks and retains a closed gap from the last confirmed healthy point", async () => {
    const repository = makeConnectionHealthRepository(provider);

    const first = await repository.claim({
      claimedAt: "2026-07-31T12:05:00.000Z",
      limit: 100,
    });
    expect(first).toEqual([
      expect.objectContaining({
        connectionId,
        setupMarker: setupId,
        webhookIngressId,
      }),
    ]);
    expect(
      await repository.finish({
        checkedAt: "2026-07-31T12:05:30.000Z",
        claimId: first[0]?.claimId ?? "missing",
        connectionId,
        gapEvidence: "healthy",
        startedAt: "2026-07-31T12:05:00.000Z",
        state: "connected",
        webhookConfigurationHealthy: true,
      }),
    ).toBe(true);
    await expect(
      repository.claim({
        claimedAt: "2026-07-31T12:09:59.000Z",
        limit: 100,
      }),
    ).resolves.toEqual([]);

    const disconnectedClaim = await repository.claim({
      claimedAt: "2026-07-31T12:10:00.000Z",
      limit: 100,
    });
    expect(
      await repository.finish({
        checkedAt: "2026-07-31T12:10:45.000Z",
        claimId: disconnectedClaim[0]?.claimId ?? "missing",
        connectionId,
        gapEvidence: "connection_unavailable",
        startedAt: "2026-07-31T12:10:00.000Z",
        state: "disconnected",
        webhookConfigurationHealthy: true,
      }),
    ).toBe(true);

    const recoveryClaim = await repository.claim({
      claimedAt: "2026-07-31T12:15:00.000Z",
      limit: 100,
    });
    await repository.finish({
      checkedAt: "2026-07-31T12:16:00.000Z",
      claimId: recoveryClaim[0]?.claimId ?? "missing",
      connectionId,
      gapEvidence: "healthy",
      startedAt: "2026-07-31T12:15:00.000Z",
      state: "connected",
      webhookConfigurationHealthy: true,
    });

    const gaps = await database.query<{
      cause: string;
      ends_at: Date | null;
      history_window_started_at: Date;
      starts_at: Date;
    }>(
      `SELECT cause, starts_at, ends_at, history_window_started_at
       FROM app.ingestion_gaps
       WHERE whatsapp_connection_id = $1`,
      [connectionId],
    );
    expect(gaps.rows).toEqual([
      {
        cause: "connection_unavailable",
        ends_at: new Date("2026-07-31T12:16:00.000Z"),
        history_window_started_at: new Date(connectedAt),
        starts_at: new Date("2026-07-31T12:05:30.000Z"),
      },
    ]);
  });

  test("opens measured ingress and restore-loss evidence without treating a failed check as a gap", async () => {
    const repository = makeConnectionHealthRepository(provider);
    const initial = await repository.claim({
      claimedAt: "2026-07-31T12:05:00.000Z",
      limit: 1,
    });
    await repository.finish({
      checkedAt: "2026-07-31T12:05:30.000Z",
      claimId: initial[0]?.claimId ?? "missing",
      connectionId,
      gapEvidence: "healthy",
      startedAt: "2026-07-31T12:05:00.000Z",
      state: "connected",
      webhookConfigurationHealthy: true,
    });

    expect(
      await repository.recordEvidence({
        active: true,
        cause: "ingress_failure",
        connectionId,
        observedAt: "2026-07-31T12:05:00.000Z",
      }),
    ).toBe(false);

    expect(
      await repository.recordEvidence({
        active: true,
        cause: "ingress_failure",
        connectionId,
        observedAt: "2026-07-31T12:20:00.000Z",
      }),
    ).toBe(true);
    expect(
      await repository.recordEvidence({
        active: false,
        cause: "ingress_failure",
        connectionId,
        observedAt: "2026-07-31T12:21:00.000Z",
      }),
    ).toBe(true);
    expect(
      await repository.recordEvidence({
        active: true,
        cause: "restore_loss",
        connectionId,
        observedAt: "2026-07-31T12:22:00.000Z",
      }),
    ).toBe(true);

    const failedCheck = await repository.claim({
      claimedAt: "2026-07-31T12:25:30.000Z",
      limit: 1,
    });
    await repository.finish({
      checkedAt: "2026-07-31T12:26:00.000Z",
      claimId: failedCheck[0]?.claimId ?? "missing",
      connectionId,
      gapEvidence: "unknown",
      startedAt: "2026-07-31T12:25:30.000Z",
      state: "degraded",
      webhookConfigurationHealthy: false,
    });

    const gaps = await database.query<{
      cause: string;
      ends_at: Date | null;
      starts_at: Date;
    }>(
      `SELECT cause, starts_at, ends_at
       FROM app.ingestion_gaps
       WHERE whatsapp_connection_id = $1
       ORDER BY cause`,
      [connectionId],
    );
    expect(gaps.rows).toEqual([
      {
        cause: "ingress_failure",
        ends_at: new Date("2026-07-31T12:21:00.000Z"),
        starts_at: new Date("2026-07-31T12:05:30.000Z"),
      },
      {
        cause: "restore_loss",
        ends_at: null,
        starts_at: new Date("2026-07-31T12:05:30.000Z"),
      },
    ]);
  });

  test("keeps webhook drift open through unknown checks and closes it only on confirmed recovery", async () => {
    const repository = makeConnectionHealthRepository(provider);
    const healthy = await repository.claim({
      claimedAt: "2026-07-31T12:05:00.000Z",
      limit: 1,
    });
    await repository.finish({
      checkedAt: "2026-07-31T12:05:30.000Z",
      claimId: healthy[0]?.claimId ?? "missing",
      connectionId,
      gapEvidence: "healthy",
      startedAt: "2026-07-31T12:05:00.000Z",
      state: "connected",
      webhookConfigurationHealthy: true,
    });
    const drift = await repository.claim({
      claimedAt: "2026-07-31T12:10:30.000Z",
      limit: 1,
    });
    await repository.finish({
      checkedAt: "2026-07-31T12:11:00.000Z",
      claimId: drift[0]?.claimId ?? "missing",
      connectionId,
      gapEvidence: "webhook_configuration",
      startedAt: "2026-07-31T12:10:30.000Z",
      state: "degraded",
      webhookConfigurationHealthy: false,
    });
    const unknown = await repository.claim({
      claimedAt: "2026-07-31T12:16:00.000Z",
      limit: 1,
    });
    await repository.finish({
      checkedAt: "2026-07-31T12:16:30.000Z",
      claimId: unknown[0]?.claimId ?? "missing",
      connectionId,
      gapEvidence: "unknown",
      startedAt: "2026-07-31T12:16:00.000Z",
      state: "degraded",
      webhookConfigurationHealthy: false,
    });
    const open = await database.query<{ ends_at: Date | null }>(
      `SELECT ends_at
       FROM app.ingestion_gaps
       WHERE whatsapp_connection_id = $1
         AND cause = 'webhook_configuration'`,
      [connectionId],
    );
    expect(open.rows).toEqual([{ ends_at: null }]);

    const absent = await repository.claim({
      claimedAt: "2026-07-31T12:21:30.000Z",
      limit: 1,
    });
    await repository.finish({
      checkedAt: "2026-07-31T12:22:00.000Z",
      claimId: absent[0]?.claimId ?? "missing",
      connectionId,
      gapEvidence: "connection_unavailable",
      startedAt: "2026-07-31T12:21:30.000Z",
      state: "reconnect_required",
      webhookConfigurationHealthy: false,
    });
    await expect(
      database.query<{ ends_at: Date | null }>(
        `SELECT ends_at
         FROM app.ingestion_gaps
         WHERE whatsapp_connection_id = $1
           AND cause = 'webhook_configuration'`,
        [connectionId],
      ),
    ).resolves.toMatchObject({ rows: [{ ends_at: null }] });

    const recovered = await repository.claim({
      claimedAt: "2026-07-31T12:26:30.000Z",
      limit: 1,
    });
    await repository.finish({
      checkedAt: "2026-07-31T12:27:00.000Z",
      claimId: recovered[0]?.claimId ?? "missing",
      connectionId,
      gapEvidence: "healthy",
      startedAt: "2026-07-31T12:26:30.000Z",
      state: "connected",
      webhookConfigurationHealthy: true,
    });
    const closed = await database.query<{ ends_at: Date | null }>(
      `SELECT ends_at
       FROM app.ingestion_gaps
       WHERE whatsapp_connection_id = $1
         AND cause = 'webhook_configuration'`,
      [connectionId],
    );
    expect(closed.rows).toEqual([
      { ends_at: new Date("2026-07-31T12:27:00.000Z") },
    ]);
  });

  test("rejects an expired claim after a newer check leases the Connection", async () => {
    const repository = makeConnectionHealthRepository(provider);
    const first = await repository.claim({
      claimedAt: "2026-07-31T12:05:00.000Z",
      limit: 1,
    });
    const replacement = await repository.claim({
      claimedAt: "2026-07-31T12:09:00.000Z",
      limit: 1,
    });

    expect(replacement[0]?.claimId).not.toBe(first[0]?.claimId);
    expect(
      await repository.finish({
        checkedAt: "2026-07-31T12:09:01.000Z",
        claimId: first[0]?.claimId ?? "missing",
        connectionId,
        gapEvidence: "connection_unavailable",
        startedAt: "2026-07-31T12:09:00.000Z",
        state: "disconnected",
        webhookConfigurationHealthy: true,
      }),
    ).toBe(false);
    expect(
      await repository.finish({
        checkedAt: "2026-07-31T12:09:02.000Z",
        claimId: replacement[0]?.claimId ?? "missing",
        connectionId,
        gapEvidence: "healthy",
        startedAt: "2026-07-31T12:09:00.000Z",
        state: "connected",
        webhookConfigurationHealthy: true,
      }),
    ).toBe(true);
  });

  test("does not let a check overwrite connection evidence received while its safe read was in flight", async () => {
    const repository = makeConnectionHealthRepository(provider);
    const claim = await repository.claim({
      claimedAt: "2026-07-31T12:05:00.000Z",
      limit: 1,
    });
    await database.query(
      `UPDATE app.whatsapp_connections
       SET
         state = 'disconnected',
         state_changed_at = '2026-07-31T12:05:00.000Z',
         state_received_at = '2026-07-31T12:05:00.000Z'
       WHERE id = $1`,
      [connectionId],
    );

    expect(
      await repository.finish({
        checkedAt: "2026-07-31T12:05:30.000Z",
        claimId: claim[0]?.claimId ?? "missing",
        connectionId,
        gapEvidence: "healthy",
        startedAt: "2026-07-31T12:05:00.000Z",
        state: "connected",
        webhookConfigurationHealthy: true,
      }),
    ).toBe(false);

    const state = await database.query<{
      health_last_checked_at: Date | null;
      state: string;
    }>(
      `SELECT state, health_last_checked_at
       FROM app.whatsapp_connections
       WHERE id = $1`,
      [connectionId],
    );
    expect(state.rows).toEqual([
      {
        health_last_checked_at: new Date("2026-07-31T12:05:30.000Z"),
        state: "disconnected",
      },
    ]);
  });

  test("keeps gap rows inaccessible through ordinary restricted-role table reads", async () => {
    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      await expect(
        database.query("SELECT * FROM app.ingestion_gaps"),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }
  });
});
