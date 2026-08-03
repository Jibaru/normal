import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type GroupConnectionProvider,
  makeGroupRepository,
} from "../src/group";
import { runMigrations } from "../src/migrations";

const accountId = "10000000-0000-4000-8000-000000000039";
const connectionId = "20000000-0000-4000-8000-000000000039";
const groupId = "30000000-0000-4000-8000-000000000039";
const groupPublicId = "grp_123456789012345678939";
const locator = `wi1_${"A".repeat(43)}`;
const observedAt = "2026-07-31T12:00:00.000Z";

const protectedFields = {
  displayName: {
    ciphertext: new Uint8Array(17).fill(3),
    keyVersion: 1,
    nonce: new Uint8Array(12).fill(2),
    version: 1 as const,
  },
  providerIdentity: {
    ciphertext: new Uint8Array(17).fill(5),
    keyVersion: 1,
    nonce: new Uint8Array(12).fill(4),
    version: 1 as const,
  },
};

describe("WhatsApp group projection repository", () => {
  let database: PGlite;
  let repository: ReturnType<typeof makeGroupRepository>;

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
    await database.query(
      `SELECT * FROM app_private.admit_personal_account_for_clerk(
        $1, $2, 1, $3, decode('0102', 'hex'), 6
      )`,
      [
        "user_group39",
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_ciphertext, public_id, state, state_changed_at, created_at
       ) VALUES ($1, $2, gen_random_uuid(), NULL,
         'con_123456789012345678939', 'connected', $3, $3)`,
      [connectionId, accountId, observedAt],
    );

    const provider: GroupConnectionProvider = {
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    repository = makeGroupRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  test("idempotently reconciles joined groups and unjoins snapshot omissions", async () => {
    const entry = {
      displayName: "Family",
      groupId,
      joined: true,
      locator,
      namePrefixIndexes: [`gi1_${"A".repeat(43)}`],
      providerIdentity: "sealed-provider-group",
      publicId: groupPublicId,
    } as const;

    await expect(
      repository.reconcile({
        completeness: "complete",
        connectionId,
        entries: [entry],
        observedAt,
        personalAccountId: accountId,
        stale: false,
        protect: async () => protectedFields,
      }),
    ).resolves.toEqual({ applied: 1, unjoined: 0 });
    await expect(
      repository.reconcile({
        completeness: "complete",
        connectionId,
        entries: [entry],
        observedAt,
        personalAccountId: accountId,
        stale: false,
        protect: async () => protectedFields,
      }),
    ).resolves.toEqual({ applied: 0, unjoined: 0 });

    const projected = await database.query<{
      display_name_ciphertext: Uint8Array;
      joined: boolean;
      provider_identity_ciphertext: Uint8Array;
      public_id: string;
      name_prefix_indexes: string[];
    }>(
      `SELECT public_id, joined,
         ARRAY(SELECT value::text FROM unnest(name_prefix_indexes) AS value)
           AS name_prefix_indexes,
         display_name_ciphertext,
         provider_identity_ciphertext
       FROM app.whatsapp_groups`,
    );
    expect(projected.rows).toHaveLength(1);
    expect(projected.rows[0]).toMatchObject({
      joined: true,
      name_prefix_indexes: [`gi1_${"A".repeat(43)}`],
      public_id: groupPublicId,
    });
    expect(
      new TextDecoder().decode(projected.rows[0]?.display_name_ciphertext),
    ).not.toContain("Family");
    expect(
      new TextDecoder().decode(projected.rows[0]?.provider_identity_ciphertext),
    ).not.toContain("sealed-provider-group");

    await database.query(
      `UPDATE app.whatsapp_groups
       SET provider_occurred_at = $1,
           provider_version = 'stale-webhook-version',
           received_at = $1,
           webhook_event_id = gen_random_uuid(),
           webhook_item_identity = $2`,
      [observedAt, `wi1_${"B".repeat(43)}`],
    );
    await expect(
      repository.reconcile({
        completeness: "complete",
        connectionId,
        entries: [entry],
        observedAt: "2026-07-31T12:30:00.000Z",
        personalAccountId: accountId,
        stale: false,
        protect: async () => protectedFields,
      }),
    ).resolves.toEqual({ applied: 1, unjoined: 0 });
    const reconciledEvidence = await database.query<{
      provider_occurred_at: Date | null;
      provider_version: string | null;
      received_at: Date | null;
      webhook_event_id: string | null;
      webhook_item_identity: string | null;
    }>(
      `SELECT provider_occurred_at, provider_version, received_at,
         webhook_event_id, webhook_item_identity
       FROM app.whatsapp_groups`,
    );
    expect(reconciledEvidence.rows).toEqual([
      {
        provider_occurred_at: null,
        provider_version: null,
        received_at: null,
        webhook_event_id: null,
        webhook_item_identity: null,
      },
    ]);

    await expect(
      repository.reconcile({
        completeness: "complete",
        connectionId,
        entries: [],
        observedAt: "2026-07-31T13:00:00.000Z",
        personalAccountId: accountId,
        stale: false,
        protect: async () => protectedFields,
      }),
    ).resolves.toEqual({ applied: 0, unjoined: 1 });
    const current = await database.query<{
      joined: boolean;
      name_prefix_indexes: string[];
    }>(
      `SELECT joined,
         ARRAY(SELECT value::text FROM unnest(name_prefix_indexes) AS value)
           AS name_prefix_indexes
       FROM app.whatsapp_groups`,
    );
    expect(current.rows).toEqual([{ joined: false, name_prefix_indexes: [] }]);
  });

  test("does not treat missing groups in a partial snapshot as unjoined", async () => {
    await repository.reconcile({
      completeness: "complete",
      connectionId,
      entries: [
        {
          displayName: "Family",
          groupId,
          joined: true,
          locator,
          namePrefixIndexes: [`gi1_${"A".repeat(43)}`],
          providerIdentity: "sealed-provider-group",
          publicId: groupPublicId,
        },
      ],
      observedAt,
      personalAccountId: accountId,
      stale: false,
      protect: async () => protectedFields,
    });

    await expect(
      repository.reconcile({
        completeness: "partial",
        connectionId,
        entries: [],
        observedAt: "2026-07-31T13:00:00.000Z",
        personalAccountId: accountId,
        stale: true,
        protect: async () => protectedFields,
      }),
    ).resolves.toEqual({ applied: 0, unjoined: 0 });
    const current = await database.query<{ joined: boolean }>(
      "SELECT joined FROM app.whatsapp_groups",
    );
    expect(current.rows).toEqual([{ joined: true }]);
  });

  test("claims only connection-bound encrypted material and leases failures", async () => {
    await database.query(
      `INSERT INTO app.whatsapp_connection_key_envelopes (
         personal_account_id, whatsapp_connection_id, account_key_version,
         key_version, nonce, ciphertext
       ) VALUES ($1, $2, 1, 1, decode(repeat('01', 12), 'hex'),
         decode(repeat('02', 32), 'hex'))`,
      [accountId, connectionId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connection_provider_sessions (
         personal_account_id, whatsapp_connection_id,
         locator_ciphertext_version, locator_key_version, locator_nonce,
         locator_ciphertext, authority_ciphertext_version,
         authority_key_version, authority_nonce, authority_ciphertext,
         created_at, updated_at
       ) VALUES ($1, $2, 1, 1, decode(repeat('03', 12), 'hex'),
         decode(repeat('04', 20), 'hex'), 1, 1,
         decode(repeat('05', 12), 'hex'), decode(repeat('06', 20), 'hex'),
         $3, $3)`,
      [accountId, connectionId, observedAt],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connection_secrets (
         personal_account_id, whatsapp_connection_id, credential_ciphertext,
         credential_ciphertext_version, credential_key_version,
         credential_nonce
       ) VALUES ($1, $2, decode(repeat('07', 20), 'hex'), 1, 1,
         decode(repeat('08', 12), 'hex'))`,
      [accountId, connectionId],
    );

    const claimed = await repository.claim({
      claimedAt: "2026-07-31T13:00:00.000Z",
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      connectionId,
      personalAccountId: accountId,
      providerAuthority: { keyVersion: 1, version: 1 },
    });
    const firstClaim = claimed[0];
    if (firstClaim === undefined) throw new Error("missing group claim");
    await expect(
      repository.claim({
        claimedAt: "2026-07-31T13:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.fail({
        claimId: firstClaim.claimId,
        connectionId,
        failedAt: "2026-07-31T13:00:00.000Z",
        personalAccountId: accountId,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.claim({
        claimedAt: "2026-07-31T13:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual([]);

    await database.query(
      `UPDATE app.whatsapp_group_directory_states
       SET as_of = $3
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = $2`,
      [accountId, connectionId, observedAt],
    );
    const staleClaim = await repository.claim({
      claimedAt: "2026-07-31T14:00:00.000Z",
      limit: 10,
    });
    expect(staleClaim).toHaveLength(1);
    const failedStaleClaim = staleClaim[0];
    if (failedStaleClaim === undefined) {
      throw new Error("missing stale group claim");
    }
    await expect(
      repository.fail({
        claimId: failedStaleClaim.claimId,
        connectionId,
        failedAt: "2026-07-31T14:00:00.000Z",
        personalAccountId: accountId,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.claim({
        claimedAt: "2026-07-31T14:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});
