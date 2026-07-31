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
import {
  makeWhatsAppConnectionRepository,
  type WhatsAppConnectionConnectionProvider,
} from "../src/whatsapp-connection";

const accountA = "10000000-0000-4000-8000-000000000031";
const accountB = "10000000-0000-4000-8000-000000000032";
const setupId = "cst_000000000000000000031";
const connectionId = "20000000-0000-4000-8000-000000000031";
const publicId = "con_000000000000000000031";
const createdAt = "2026-07-31T12:00:00.000Z";
const connectedAt = "2026-07-31T12:04:00.000Z";

describe("WhatsApp Connection repository", () => {
  let database: PGlite;
  let provider: ConnectionSetupConnectionProvider &
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
    for (const [accountId, clerkUserId, fill] of [
      [accountA, "user_connectiona", 1],
      [accountB, "user_connectionb", 2],
    ] as const) {
      const account = await accounts.create({
        clerkUserId,
        keyCiphertext: new Uint8Array([fill, fill + 1, fill + 2]),
        keyVersion: 1,
        kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
        personalAccountId: accountId,
        providerApprovedSessionCapacity: 6,
      });
      expect(account).toMatchObject({
        admissionState: "active",
        personalAccountId: accountId,
      });
    }

    const setups = makeConnectionSetupRepository(provider);
    await setups.start({
      accountKeyVersion: 1,
      connectionKeyCiphertext: new Uint8Array(32).fill(3),
      connectionKeyNonce: new Uint8Array(12).fill(4),
      connectionKeyVersion: 1,
      createdAt,
      idempotencyKey: "123456789012345678931",
      numberCiphertext: new Uint8Array(32).fill(5),
      numberCiphertextNonce: new Uint8Array(12).fill(6),
      numberCiphertextVersion: 1,
      numberKeyVersion: 1,
      numberToken: new Uint8Array(32).fill(7),
      personalAccountId: accountA,
      setupId,
    });
    await setups.claimProvisioning({
      claimedAt: "2026-07-31T12:01:00.000Z",
      setupId,
      workerId: "cspw_0000000000000000000000000000000000000000031",
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
      workerId: "cspw_0000000000000000000000000000000000000000031",
    });
  });

  afterEach(async () => {
    await database.close();
  });

  const activationInput = {
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
    numberSuffix: "3456",
    personalAccountId: accountA,
    publicId,
    setupId,
    webhookIngressId: "30000000-0000-4000-8000-000000000031",
    webhookSecretCiphertext: new Uint8Array(48).fill(18),
    webhookSecretCiphertextVersion: 1,
    webhookSecretKeyVersion: 1,
    webhookSecretNonce: new Uint8Array(12).fill(19),
  } as const;

  test("loads activation material only for the owning signed-in User", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);

    const owned = await repository.loadSetupForActivation({
      clerkUserId: "user_connectiona",
      observedAt: connectedAt,
      setupId,
    });
    const otherTenant = await repository.loadSetupForActivation({
      clerkUserId: "user_connectionb",
      observedAt: connectedAt,
      setupId,
    });

    expect(owned).toMatchObject({
      outcome: "provisioned",
      setup: {
        accountKey: {
          personalAccountId: accountA,
          version: 1,
        },
        personalAccountId: accountA,
        setupId,
        setupKey: {
          connectionId: setupId,
          personalAccountId: accountA,
          version: 1,
        },
      },
    });
    expect(otherTenant).toBeNull();
  });

  test("does not load or activate an incomplete Setup at its expiry", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    const expiresAt = "2026-07-31T12:15:00.000Z";

    await expect(
      repository.loadSetupForActivation({
        clerkUserId: "user_connectiona",
        observedAt: expiresAt,
        setupId,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.activate({
        ...activationInput,
        connectedAt: expiresAt,
      }),
    ).rejects.toThrow();

    const counts = await database.query<{ connection_count: number }>(`
      SELECT count(*)::integer AS connection_count
      FROM app.whatsapp_connections
    `);
    expect(counts.rows).toEqual([{ connection_count: 0 }]);
  });

  test("atomically activates exactly one Connection and returns the idempotent winner", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);

    const first = await repository.activate(activationInput);
    const replay = await repository.activate({
      ...activationInput,
      connectionId: "20000000-0000-4000-8000-000000000099",
      publicId: "con_000000000000000000099",
      webhookIngressId: "30000000-0000-4000-8000-000000000099",
    });

    expect(first).toEqual({
      displayName: null,
      numberSuffix: "3456",
      publicId,
      state: "connected",
      stateChangedAt: connectedAt,
    });
    expect(replay).toEqual(first);

    const counts = await database.query<{
      connection_count: number;
      connection_key_count: number;
      provider_session_count: number;
      setup_state: string;
      webhook_secret_count: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM app.whatsapp_connections)
          AS connection_count,
        (SELECT count(*)::integer FROM app.whatsapp_connection_key_envelopes)
          AS connection_key_count,
        (SELECT count(*)::integer FROM app.whatsapp_connection_provider_sessions)
          AS provider_session_count,
        (SELECT state FROM app.connection_setups WHERE id = '${setupId}')
          AS setup_state,
        (SELECT count(*)::integer FROM app.whatsapp_connection_secrets)
          AS webhook_secret_count
    `);
    expect(counts.rows).toEqual([
      {
        connection_count: 1,
        connection_key_count: 1,
        provider_session_count: 1,
        setup_state: "activated",
        webhook_secret_count: 1,
      },
    ]);
  });

  test("lists only safe normalized fields under the restricted tenant role", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    await repository.activate(activationInput);

    await expect(repository.listForUser("user_connectiona")).resolves.toEqual([
      {
        displayName: null,
        numberSuffix: "3456",
        publicId,
        state: "connected",
        stateChangedAt: connectedAt,
      },
    ]);
    await expect(repository.listForUser("user_connectionb")).resolves.toEqual(
      [],
    );

    const qrColumns = await database.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM information_schema.columns
      WHERE table_schema IN ('app', 'app_private')
        AND column_name ILIKE '%qr%'
    `);
    expect(qrColumns.rows).toEqual([{ count: 0 }]);
  });

  test("serializes disconnect and reconnect claims while preserving retained identity", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    await repository.activate(activationInput);

    const disconnect = await repository.claimLifecycle({
      action: "disconnect",
      claimId: "40000000-0000-4000-8000-000000000031",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:05:00.000Z",
    });
    const concurrent = await repository.claimLifecycle({
      action: "disconnect",
      claimId: "40000000-0000-4000-8000-000000000032",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:05:01.000Z",
    });

    expect(disconnect).toEqual({
      action: "disconnect",
      connection: {
        displayName: null,
        numberSuffix: "3456",
        publicId,
        state: "degraded",
        stateChangedAt: "2026-07-31T12:05:00.000Z",
      },
      outcome: "claimed",
      setupMarker: setupId,
    });
    if (disconnect?.outcome !== "claimed") {
      throw new Error("expected claimed disconnect lifecycle");
    }
    expect(concurrent).toEqual({
      connection: disconnect.connection,
      outcome: "in_progress",
    });
    await expect(
      repository.finishLifecycle({
        claimId: "40000000-0000-4000-8000-000000000032",
        clerkUserId: "user_connectiona",
        observedAt: "2026-07-31T12:05:02.000Z",
        publicId,
        state: "connected",
      }),
    ).resolves.toBeNull();

    const disconnected = await repository.finishLifecycle({
      claimId: "40000000-0000-4000-8000-000000000031",
      clerkUserId: "user_connectiona",
      observedAt: "2026-07-31T12:05:03.000Z",
      publicId,
      state: "disconnected",
    });
    expect(disconnected).toMatchObject({
      publicId,
      state: "disconnected",
      stateChangedAt: "2026-07-31T12:05:03.000Z",
    });

    const replay = await repository.claimLifecycle({
      action: "disconnect",
      claimId: "40000000-0000-4000-8000-000000000033",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:05:04.000Z",
    });
    expect(replay).toMatchObject({
      connection: { publicId, state: "disconnected" },
      outcome: "complete",
    });

    const reconnect = await repository.claimLifecycle({
      action: "reconnect",
      claimId: "40000000-0000-4000-8000-000000000034",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:05:05.000Z",
    });
    expect(reconnect).toMatchObject({
      action: "reconnect",
      connection: {
        publicId,
        state: "connecting",
        stateChangedAt: "2026-07-31T12:05:05.000Z",
      },
      outcome: "claimed",
      setupMarker: setupId,
    });

    const reconnected = await repository.finishLifecycle({
      claimId: "40000000-0000-4000-8000-000000000034",
      clerkUserId: "user_connectiona",
      observedAt: "2026-07-31T12:05:06.000Z",
      publicId,
      state: "connected",
    });
    expect(reconnected).toMatchObject({
      numberSuffix: "3456",
      publicId,
      state: "connected",
    });

    const retained = await database.query<{
      connection_count: number;
      reservation_count: number;
      setup_count: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM app.whatsapp_connections)
          AS connection_count,
        (SELECT count(*)::integer FROM app.whatsapp_number_reservations)
          AS reservation_count,
        (SELECT count(*)::integer FROM app.connection_setups)
          AS setup_count
    `);
    expect(retained.rows).toEqual([
      {
        connection_count: 1,
        reservation_count: 1,
        setup_count: 1,
      },
    ]);
  });

  test("keeps lifecycle claims tenant scoped and rejects stale completion regression", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    await repository.activate(activationInput);

    await expect(
      repository.claimLifecycle({
        action: "disconnect",
        claimId: "40000000-0000-4000-8000-000000000035",
        clerkUserId: "user_connectionb",
        publicId,
        requestedAt: "2026-07-31T12:06:00.000Z",
      }),
    ).resolves.toBeNull();

    await repository.claimLifecycle({
      action: "disconnect",
      claimId: "40000000-0000-4000-8000-000000000036",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:06:00.000Z",
    });
    await expect(
      repository.finishLifecycle({
        claimId: "40000000-0000-4000-8000-000000000036",
        clerkUserId: "user_connectiona",
        observedAt: "2026-07-31T12:05:59.000Z",
        publicId,
        state: "disconnected",
      }),
    ).resolves.toBeNull();
    await expect(repository.listForUser("user_connectiona")).resolves.toEqual([
      expect.objectContaining({
        publicId,
        state: "degraded",
        stateChangedAt: "2026-07-31T12:06:00.000Z",
      }),
    ]);
  });

  test("does not regress the state-change time when a later claim has an older timestamp", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    await repository.activate(activationInput);

    await repository.claimLifecycle({
      action: "disconnect",
      claimId: "40000000-0000-4000-8000-000000000037",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:07:00.000Z",
    });
    await repository.finishLifecycle({
      claimId: "40000000-0000-4000-8000-000000000037",
      clerkUserId: "user_connectiona",
      observedAt: "2026-07-31T12:07:01.000Z",
      publicId,
      state: "disconnected",
    });

    const reconnect = await repository.claimLifecycle({
      action: "reconnect",
      claimId: "40000000-0000-4000-8000-000000000038",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:06:59.000Z",
    });

    expect(reconnect).toMatchObject({
      action: "reconnect",
      connection: {
        publicId,
        state: "connecting",
        stateChangedAt: "2026-07-31T12:07:01.000Z",
      },
      outcome: "claimed",
    });
  });

  test("counts an activated Setup and its Connection as one retained slot", async () => {
    const connections = makeWhatsAppConnectionRepository(provider);
    const setups = makeConnectionSetupRepository(provider);
    await connections.activate(activationInput);

    for (const [index, token] of [
      [32, 20],
      [33, 21],
    ] as const) {
      await expect(
        setups.start({
          accountKeyVersion: 1,
          connectionKeyCiphertext: new Uint8Array(32).fill(token),
          connectionKeyNonce: new Uint8Array(12).fill(token),
          connectionKeyVersion: 1,
          createdAt,
          idempotencyKey: `${index}3456789012345678931`,
          numberCiphertext: new Uint8Array(32).fill(token),
          numberCiphertextNonce: new Uint8Array(12).fill(token),
          numberCiphertextVersion: 1,
          numberKeyVersion: 1,
          numberToken: new Uint8Array(32).fill(token),
          personalAccountId: accountA,
          setupId: `cst_${String(index).padStart(21, "0")}`,
        }),
      ).resolves.toMatchObject({ outcome: "created" });
    }
  });
});
