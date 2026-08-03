import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeDirectoryRepository } from "../src/directory";
import { makeMcpAuthorizationRepository } from "../src/mcp-authorization";
import {
  type McpToolConnectionProvider,
  type McpToolRepository,
  makeMcpToolRepository,
} from "../src/mcp-tool";
import { runMigrations } from "../src/migrations";
import type { PersonalAccountConnectionProvider } from "../src/personal-account";
import { makeWebhookEventRepository } from "../src/webhook-event";

const accountId = "10000000-0000-4000-8000-000000000030";
const authorizationId = "40000000-0000-4000-8000-000000000030";
const oauthSubject = "A".repeat(43);
const connectionA = "con_123456789012345678930";
const connectionB = "con_123456789012345678931";
const connectionLater = "con_123456789012345678932";
const connectionWithoutSuffix = "con_123456789012345678933";
const observedAt = new Date("2026-07-31T12:00:00.000Z");

describe("MCP tool repository", () => {
  let database: PGlite;
  let repository: McpToolRepository;

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
        "user_mcptool30",
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_ciphertext, public_id, number_suffix, state,
         state_changed_at
       ) VALUES
         ('20000000-0000-4000-8000-000000000030', $1,
          '30000000-0000-4000-8000-000000000030', NULL, $2, '1234',
          'connected', $6),
         ('20000000-0000-4000-8000-000000000031', $1,
          '30000000-0000-4000-8000-000000000031', NULL, $3, '5678',
          'deleting', $6),
         ('20000000-0000-4000-8000-000000000032', $1,
          '30000000-0000-4000-8000-000000000032', NULL, $4, '9012',
          'connected', $6),
         ('20000000-0000-4000-8000-000000000033', $1,
          '30000000-0000-4000-8000-000000000033', NULL, $5, NULL,
          'connecting', $6)`,
      [
        accountId,
        connectionA,
        connectionB,
        connectionLater,
        connectionWithoutSuffix,
        observedAt,
      ],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connection_key_envelopes (
         personal_account_id, whatsapp_connection_id, account_key_version,
         key_version, nonce, ciphertext
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030', 1, 1,
         decode(repeat('03', 12), 'hex'), decode(repeat('04', 32), 'hex')
       )`,
      [accountId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connection_secrets (
         personal_account_id, whatsapp_connection_id, credential_ciphertext,
         credential_ciphertext_version, credential_key_version, credential_nonce
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         decode(repeat('05', 32), 'hex'), 1, 1,
         decode(repeat('06', 12), 'hex')
       )`,
      [accountId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connection_provider_sessions (
         personal_account_id, whatsapp_connection_id,
         locator_ciphertext_version, locator_key_version,
         locator_nonce, locator_ciphertext,
         authority_ciphertext_version, authority_key_version,
         authority_nonce, authority_ciphertext, created_at, updated_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         1, 1, decode(repeat('0d', 12), 'hex'), decode(repeat('0e', 32), 'hex'),
         1, 1, decode(repeat('0f', 12), 'hex'), decode(repeat('10', 32), 'hex'),
         $2, $2
       )`,
      [accountId, observedAt],
    );

    const provider: McpToolConnectionProvider &
      PersonalAccountConnectionProvider = {
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    const authorizations = makeMcpAuthorizationRepository(provider);
    await authorizations.create({
      authorizationId,
      authorizedAt: observedAt,
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      clerkUserId: "user_mcptool30",
      connectionIds: [connectionA, connectionB, connectionWithoutSuffix],
      expiresAt: new Date("2026-10-29T12:00:00.000Z"),
      oauthSubject,
      reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
      scopes: ["connections:read", "directory:read"],
    });
    repository = makeMcpToolRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  const authorization = {
    authorizationId,
    clientId: "approved-client",
    oauthSubject,
  } as const;

  test("discovers current scopes and lists only explicitly selected non-deleting Connections", async () => {
    const inspected = await repository.inspectAuthorization({
      ...authorization,
      observedAt,
    });
    expect(inspected).toEqual({
      scopes: ["connections:read", "directory:read"],
    });

    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000030",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000030",
      outcome: "started",
    });

    await expect(
      repository.listConnections({
        ...authorization,
        observedAt,
      }),
    ).resolves.toEqual([
      {
        displayName: null,
        numberLastFour: "1234",
        publicId: connectionA,
        state: "connected",
        stateChangedAt: "2026-07-31T12:00:00.000Z",
      },
      {
        displayName: null,
        numberLastFour: null,
        publicId: connectionWithoutSuffix,
        state: "connecting",
        stateChangedAt: "2026-07-31T12:00:00.000Z",
      },
    ]);

    await repository.completeToolCall({
      auditLogId: "50000000-0000-4000-8000-000000000030",
      completedAt: new Date("2026-07-31T12:00:00.025Z"),
      errorCode: null,
      outcome: "success",
      resultCount: 2,
    });
    const persisted = await database.query<{
      error_code: string | null;
      outcome: string;
      quota_reserved: boolean;
      result_count: number | null;
      tool_name: string;
    }>(
      `SELECT tool_name, outcome, error_code, result_count, quota_reserved
       FROM app.tool_call_logs`,
    );
    expect(persisted.rows).toEqual([
      {
        error_code: null,
        outcome: "success",
        quota_reserved: true,
        result_count: 2,
        tool_name: "list_connections",
      },
    ]);
  });

  test("atomically audits rate-limit rejection without another reservation", async () => {
    for (const [index, time] of [
      [30, "2026-07-31T11:59:30.000Z"],
      [31, "2026-07-31T11:59:45.000Z"],
    ] as const) {
      await expect(
        repository.beginToolCall({
          ...authorization,
          auditLogId: `50000000-0000-4000-8000-0000000000${index}`,
          hourLimit: 3,
          minuteLimit: 2,
          observedAt: new Date(time),
          toolName: "list_connections",
        }),
      ).resolves.toMatchObject({ outcome: "started" });
    }

    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000032",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000032",
      outcome: "rate_limited",
      resetsAt: new Date("2026-07-31T12:00:30.000Z"),
      retryAfterSeconds: 30,
    });

    const persisted = await database.query<{
      outcome: string;
      quota_reserved: boolean;
    }>(
      `SELECT outcome, quota_reserved
       FROM app.tool_call_logs
       WHERE id = '50000000-0000-4000-8000-000000000032'`,
    );
    expect(persisted.rows).toEqual([
      { outcome: "rate_limited", quota_reserved: false },
    ]);
  });

  test("audits validation rejection without reserving request quota", async () => {
    await expect(
      repository.rejectToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000033",
        errorCode: "invalid_cursor",
        observedAt,
        toolName: "list_contacts",
      }),
    ).resolves.toBe("rejected");

    const persisted = await database.query<{
      error_code: string | null;
      outcome: string;
      quota_reserved: boolean;
    }>(
      `SELECT outcome, error_code, quota_reserved
       FROM app.tool_call_logs
       WHERE id = '50000000-0000-4000-8000-000000000033'`,
    );
    expect(persisted.rows).toEqual([
      {
        error_code: "invalid_cursor",
        outcome: "execution_error",
        quota_reserved: false,
      },
    ]);
  });

  test("loads encrypted contact material only for the selected authorized Connection", async () => {
    await database.query(
      `INSERT INTO app.directory_contact_projections (
         personal_account_id, whatsapp_connection_id, as_of, stale, partial,
         snapshot_observed_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030', $2, false, false, $2
       )`,
      [accountId, observedAt],
    );
    await database.query(
      `INSERT INTO app.directory_contacts (
         personal_account_id, whatsapp_connection_id, public_id,
         provider_identity_index, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, display_name_ciphertext_version,
         display_name_key_version, display_name_nonce, display_name_ciphertext,
         display_name_sort,
         phone_ciphertext_version, phone_key_version, phone_nonce,
         phone_ciphertext, name_prefix_indexes, phone_index, active, received_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         'ctc_123456789012345678901', $2, 1, 1,
         decode(repeat('07', 12), 'hex'), decode(repeat('08', 32), 'hex'),
         1, 1, decode(repeat('09', 12), 'hex'), decode(repeat('0a', 32), 'hex'),
         'ada',
         1, 1, decode(repeat('0b', 12), 'hex'), decode(repeat('0c', 32), 'hex'),
         ARRAY[$3::app.directory_blind_index], $4, true, $5
       )`,
      [
        accountId,
        `di1_${"i".repeat(43)}`,
        `di1_${"n".repeat(43)}`,
        `di1_${"p".repeat(43)}`,
        observedAt,
      ],
    );

    await expect(
      repository.loadContactReadMaterial({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
      }),
    ).resolves.toMatchObject({
      asOf: observedAt.toISOString(),
      partial: false,
      personalAccountId: accountId,
      stale: false,
      whatsappConnectionId: "20000000-0000-4000-8000-000000000030",
    });
    await expect(
      repository.listEncryptedContacts({
        ...authorization,
        connectionPublicId: connectionA,
        cursorDisplayNameSort: null,
        cursorPublicId: null,
        limit: 21,
        observedAt,
        searchIndex: `di1_${"n".repeat(43)}`,
        searchKind: "name",
      }),
    ).resolves.toEqual({
      asOf: observedAt.toISOString(),
      contacts: [
        expect.objectContaining({
          displayNameCiphertext: expect.objectContaining({ keyVersion: 1 }),
          displayNameSort: "ada",
          phoneCiphertext: expect.objectContaining({ keyVersion: 1 }),
          providerIdentityIndex: `di1_${"i".repeat(43)}`,
          publicId: "ctc_123456789012345678901",
        }),
      ],
      partial: false,
      snapshotObservedAt: observedAt.toISOString(),
      stale: false,
    });
    await expect(
      repository.listEncryptedContacts({
        ...authorization,
        connectionPublicId: connectionA,
        cursorDisplayNameSort: "ada",
        cursorPublicId: "ctc_123456789012345678901",
        limit: 1,
        observedAt,
        searchIndex: null,
        searchKind: null,
      }),
    ).resolves.toMatchObject({ contacts: [] });
    await expect(
      repository.loadContactReadMaterial({
        ...authorization,
        connectionPublicId: connectionLater,
        observedAt,
      }),
    ).resolves.toBeNull();
  });

  test("reports the reset that restores capacity after a quota reduction", async () => {
    for (const [index, time] of [
      [40, "2026-07-31T11:59:10.000Z"],
      [41, "2026-07-31T11:59:20.000Z"],
      [42, "2026-07-31T11:59:30.000Z"],
    ] as const) {
      await expect(
        repository.beginToolCall({
          ...authorization,
          auditLogId: `50000000-0000-4000-8000-0000000000${index}`,
          hourLimit: 10,
          minuteLimit: 3,
          observedAt: new Date(time),
          toolName: "list_connections",
        }),
      ).resolves.toMatchObject({ outcome: "started" });
    }

    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000043",
        hourLimit: 10,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000043",
      outcome: "rate_limited",
      resetsAt: new Date("2026-07-31T12:00:20.000Z"),
      retryAfterSeconds: 20,
    });
  });

  test("reconciles complete contact snapshots and removes missing contacts without retaining PII", async () => {
    const directory = makeDirectoryRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });
    const claimed = await directory.claimContactReconciliations({
      claimedAt: observedAt.toISOString(),
      limit: 100,
    });
    expect(claimed).toHaveLength(1);
    const first = claimed[0];
    if (first === undefined) throw new Error("missing reconciliation claim");
    const encrypted = (byte: string) => ({
      ciphertext: Buffer.from(byte.repeat(32), "hex").toString("base64"),
      keyVersion: 1,
      nonce: Buffer.from("11".repeat(12), "hex").toString("base64"),
      version: 1 as const,
    });
    expect(
      await directory.finishContactReconciliation({
        claimId: first.claimId,
        contacts: [
          {
            displayNameCiphertext: encrypted("12"),
            displayNameSort: "ada",
            namePrefixIndexes: [`di1_${"n".repeat(43)}`],
            phoneCiphertext: encrypted("13"),
            phoneIndex: `di1_${"p".repeat(43)}`,
            providerIdentityCiphertext: encrypted("14"),
            providerIdentityIndex: `di1_${"i".repeat(43)}`,
            publicId: "ctc_123456789012345678901",
          },
        ],
        observedAt: observedAt.toISOString(),
        partial: false,
        stale: false,
        whatsappConnectionId: first.whatsappConnectionId,
      }),
    ).toBe(true);

    const later = new Date(observedAt.valueOf() + 6 * 60_000);
    const reclaimed = await directory.claimContactReconciliations({
      claimedAt: later.toISOString(),
      limit: 100,
    });
    expect(reclaimed).toHaveLength(1);
    const second = reclaimed[0];
    if (second === undefined) throw new Error("missing second claim");
    expect(
      await directory.finishContactReconciliation({
        claimId: second.claimId,
        contacts: [],
        observedAt: later.toISOString(),
        partial: false,
        stale: false,
        whatsappConnectionId: second.whatsappConnectionId,
      }),
    ).toBe(true);

    const persisted = await database.query<{
      active: boolean;
      display_name_ciphertext: Uint8Array | null;
      phone_ciphertext: Uint8Array | null;
    }>(
      "SELECT active, display_name_ciphertext, phone_ciphertext FROM app.directory_contacts",
    );
    expect(persisted.rows).toEqual([
      {
        active: false,
        display_name_ciphertext: null,
        phone_ciphertext: null,
      },
    ]);
  });

  test("does not let a partial snapshot supersede webhook evidence for an unobserved contact", async () => {
    const connectionProvider = {
      withConnection: async <Value>(
        use: (connection: typeof database) => Promise<Value>,
      ) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    const directory = makeDirectoryRepository(connectionProvider);
    const encrypted = (byte: string) => ({
      ciphertext: Buffer.from(byte.repeat(32), "hex").toString("base64"),
      keyVersion: 1,
      nonce: Buffer.from("11".repeat(12), "hex").toString("base64"),
      version: 1 as const,
    });
    const firstContact = {
      displayNameCiphertext: encrypted("12"),
      displayNameSort: "ada",
      namePrefixIndexes: [`di1_${"n".repeat(43)}`],
      phoneCiphertext: encrypted("13"),
      phoneIndex: `di1_${"p".repeat(43)}`,
      providerIdentityCiphertext: encrypted("14"),
      providerIdentityIndex: `di1_${"i".repeat(43)}`,
      publicId: "ctc_123456789012345678901",
    } as const;
    const secondContact = {
      displayNameCiphertext: encrypted("15"),
      displayNameSort: "grace",
      namePrefixIndexes: [`di1_${"o".repeat(43)}`],
      phoneCiphertext: encrypted("16"),
      phoneIndex: `di1_${"q".repeat(43)}`,
      providerIdentityCiphertext: encrypted("17"),
      providerIdentityIndex: `di1_${"j".repeat(43)}`,
      publicId: "ctc_123456789012345678902",
    } as const;
    const initialClaim = (
      await directory.claimContactReconciliations({
        claimedAt: observedAt.toISOString(),
        limit: 100,
      })
    )[0];
    if (initialClaim === undefined) throw new Error("missing initial claim");
    expect(
      await directory.finishContactReconciliation({
        claimId: initialClaim.claimId,
        contacts: [firstContact, secondContact],
        observedAt: observedAt.toISOString(),
        partial: false,
        stale: false,
        whatsappConnectionId: initialClaim.whatsappConnectionId,
      }),
    ).toBe(true);

    const partialAt = new Date(observedAt.valueOf() + 6 * 60_000);
    const partialClaim = (
      await directory.claimContactReconciliations({
        claimedAt: partialAt.toISOString(),
        limit: 100,
      })
    )[0];
    if (partialClaim === undefined) throw new Error("missing partial claim");
    expect(
      await directory.finishContactReconciliation({
        claimId: partialClaim.claimId,
        contacts: [firstContact],
        observedAt: partialAt.toISOString(),
        partial: true,
        stale: true,
        whatsappConnectionId: partialClaim.whatsappConnectionId,
      }),
    ).toBe(true);

    const webhookProvider = {
      withConnection: async <Value>(
        use: (connection: typeof database) => Promise<Value>,
      ) => {
        await database.exec("SET ROLE whatsapp_webhook_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    const webhooks = makeWebhookEventRepository(webhookProvider);
    const eventId = "50000000-0000-4000-8000-000000000039";
    const webhookReceivedAt = new Date(
      partialAt.valueOf() + 60_000,
    ).toISOString();
    await webhooks.prepare({
      ciphertextSha256: "a".repeat(64),
      eventId,
      payloadBytes: 128,
      personalAccountId: accountId,
      receivedAt: webhookReceivedAt,
      whatsappConnectionId: initialClaim.whatsappConnectionId,
    });
    const olderOccurrence = new Date(
      observedAt.valueOf() + 60_000,
    ).toISOString();
    expect(
      await webhooks.projectDirectoryContact(
        {
          ...firstContact,
          displayNameCiphertext: encrypted("19"),
          displayNameSort: "ada older",
          eventId,
          evidence: { occurredAt: olderOccurrence, version: null },
          itemIdentity: `wi1_${"v".repeat(43)}`,
          itemIndex: 0,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678904",
          receivedAt: webhookReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("superseded");
    expect(
      await webhooks.projectDirectoryContact(
        {
          ...secondContact,
          displayNameCiphertext: encrypted("18"),
          displayNameSort: "grace updated",
          eventId,
          evidence: { occurredAt: olderOccurrence, version: null },
          itemIdentity: `wi1_${"w".repeat(43)}`,
          itemIndex: 1,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678903",
          receivedAt: webhookReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("applied");

    expect(
      await webhooks.projectDirectoryContact(
        {
          ...firstContact,
          displayNameCiphertext: encrypted("20"),
          displayNameSort: "ada current",
          eventId,
          evidence: { occurredAt: null, version: null },
          itemIdentity: `wi1_${"x".repeat(43)}`,
          itemIndex: 2,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678905",
          receivedAt: webhookReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("applied");

    const laterEventId = "50000000-0000-4000-8000-000000000040";
    const laterReceivedAt = new Date(
      partialAt.valueOf() + 2 * 60_000,
    ).toISOString();
    await webhooks.prepare({
      ciphertextSha256: "b".repeat(64),
      eventId: laterEventId,
      payloadBytes: 128,
      personalAccountId: accountId,
      receivedAt: laterReceivedAt,
      whatsappConnectionId: initialClaim.whatsappConnectionId,
    });
    expect(
      await webhooks.projectDirectoryContact(
        {
          ...firstContact,
          displayNameCiphertext: encrypted("21"),
          displayNameSort: "ada stale",
          eventId: laterEventId,
          evidence: {
            occurredAt: new Date(partialAt.valueOf() - 60_000).toISOString(),
            version: null,
          },
          itemIdentity: `wi1_${"y".repeat(43)}`,
          itemIndex: 0,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678906",
          receivedAt: laterReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("superseded");

    const persisted = await database.query<{
      display_name_sort: string;
      provider_identity_index: string;
    }>(
      `SELECT provider_identity_index, display_name_sort
       FROM app.directory_contacts
       WHERE provider_identity_index IN (
         $1::app.directory_blind_index,
         $2::app.directory_blind_index
       )
       ORDER BY provider_identity_index`,
      [firstContact.providerIdentityIndex, secondContact.providerIdentityIndex],
    );
    expect(persisted.rows).toEqual([
      {
        display_name_sort: "ada current",
        provider_identity_index: firstContact.providerIdentityIndex,
      },
      {
        display_name_sort: "grace updated",
        provider_identity_index: secondContact.providerIdentityIndex,
      },
    ]);

    const inFlightSnapshotAt = new Date(partialAt.valueOf() + 6 * 60_000);
    const inFlightClaim = (
      await directory.claimContactReconciliations({
        claimedAt: inFlightSnapshotAt.toISOString(),
        limit: 100,
      })
    )[0];
    if (inFlightClaim === undefined) throw new Error("missing in-flight claim");

    const newestEventId = "50000000-0000-4000-8000-000000000041";
    const newestReceivedAt = new Date(
      inFlightSnapshotAt.valueOf() + 60_000,
    ).toISOString();
    await webhooks.prepare({
      ciphertextSha256: "c".repeat(64),
      eventId: newestEventId,
      payloadBytes: 128,
      personalAccountId: accountId,
      receivedAt: newestReceivedAt,
      whatsappConnectionId: initialClaim.whatsappConnectionId,
    });
    expect(
      await webhooks.projectDirectoryContact(
        {
          ...firstContact,
          displayNameCiphertext: encrypted("22"),
          displayNameSort: "ada newest",
          eventId: newestEventId,
          evidence: { occurredAt: null, version: null },
          itemIdentity: `wi1_${"z".repeat(43)}`,
          itemIndex: 0,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678907",
          receivedAt: newestReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("applied");
    expect(
      await directory.finishContactReconciliation({
        claimId: inFlightClaim.claimId,
        contacts: [],
        observedAt: inFlightSnapshotAt.toISOString(),
        partial: false,
        stale: false,
        whatsappConnectionId: inFlightClaim.whatsappConnectionId,
      }),
    ).toBe(true);

    const delayedEventId = "50000000-0000-4000-8000-000000000042";
    const delayedReceivedAt = new Date(
      inFlightSnapshotAt.valueOf() + 2 * 60_000,
    ).toISOString();
    await webhooks.prepare({
      ciphertextSha256: "d".repeat(64),
      eventId: delayedEventId,
      payloadBytes: 128,
      personalAccountId: accountId,
      receivedAt: delayedReceivedAt,
      whatsappConnectionId: initialClaim.whatsappConnectionId,
    });
    expect(
      await webhooks.projectDirectoryContact(
        {
          ...firstContact,
          displayNameCiphertext: encrypted("23"),
          displayNameSort: "ada delayed",
          eventId: delayedEventId,
          evidence: {
            occurredAt: new Date(
              inFlightSnapshotAt.valueOf() - 60_000,
            ).toISOString(),
            version: null,
          },
          itemIdentity: `wi1_${"0".repeat(43)}`,
          itemIndex: 0,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678908",
          receivedAt: delayedReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("superseded");

    const converged = await database.query<{ display_name_sort: string }>(
      `SELECT display_name_sort
       FROM app.directory_contacts
       WHERE provider_identity_index = $1`,
      [firstContact.providerIdentityIndex],
    );
    expect(converged.rows).toEqual([{ display_name_sort: "ada newest" }]);
  });

  test("rechecks scope and revocation at audit and protected-read boundaries", async () => {
    await database.query(
      `UPDATE app.mcp_authorizations
       SET scopes = ARRAY['messages:send']::text[]
       WHERE id = $1`,
      [authorizationId],
    );
    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000033",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toMatchObject({ outcome: "authorization_denied" });

    await database.query(
      `UPDATE app.mcp_authorizations
       SET scopes = ARRAY['connections:read']::text[]
       WHERE id = $1`,
      [authorizationId],
    );
    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000034",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await database.query(
      `UPDATE app.mcp_authorizations
       SET state = 'revoked', revoked_at = $2
       WHERE id = $1`,
      [authorizationId, observedAt],
    );
    await expect(
      repository.listConnections({
        ...authorization,
        observedAt,
      }),
    ).resolves.toBeNull();
  });

  test("returns an empty list after every selected Connection is purged", async () => {
    await database.query(
      `DELETE FROM app.whatsapp_connections
       WHERE personal_account_id = $1
         AND public_id IN ($2, $3, $4)`,
      [accountId, connectionA, connectionB, connectionWithoutSuffix],
    );

    await expect(
      repository.inspectAuthorization({
        ...authorization,
        observedAt,
      }),
    ).resolves.toEqual({
      scopes: ["connections:read", "directory:read"],
    });
    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000035",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        toolName: "list_connections",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await expect(
      repository.listConnections({
        ...authorization,
        observedAt,
      }),
    ).resolves.toEqual([]);
  });

  test("rechecks directory scope, selected connection, and joined state for encrypted groups", async () => {
    await database.query(
      `UPDATE app.mcp_authorizations
       SET scopes = ARRAY['directory:read']::text[]
       WHERE id = $1`,
      [authorizationId],
    );
    await database.query(
      `DELETE FROM app.whatsapp_connection_secrets
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = '20000000-0000-4000-8000-000000000030'`,
      [accountId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_group_directory_states (
         personal_account_id, whatsapp_connection_id, as_of,
         stale, partial, updated_at
       ) VALUES ($1, '20000000-0000-4000-8000-000000000030', $2,
         false, false, $2)`,
      [accountId, observedAt],
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: null,
      }),
    ).resolves.toMatchObject({ groups: [] });
    await expect(
      repository.loadGroupSearchMaterial({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
      }),
    ).resolves.toBeNull();
    await database.query(
      `INSERT INTO app.whatsapp_connection_secrets (
         personal_account_id, whatsapp_connection_id, credential_ciphertext,
         credential_ciphertext_version, credential_key_version,
         credential_nonce
       ) VALUES ($1, '20000000-0000-4000-8000-000000000030',
         decode(repeat('07', 32), 'hex'), 1, 1,
         decode(repeat('08', 12), 'hex'))`,
      [accountId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_groups (
         id, personal_account_id, whatsapp_connection_id, public_id,
         provider_locator, display_name_ciphertext_version,
         display_name_key_version, display_name_nonce,
         display_name_ciphertext, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, name_prefix_indexes, joined, last_observed_at,
         created_at, updated_at
       ) VALUES (
         '30000000-0000-4000-8000-000000000039', $1,
         '20000000-0000-4000-8000-000000000030',
         'grp_123456789012345678939', $2, 1, 1,
         decode(repeat('03', 12), 'hex'), decode(repeat('04', 20), 'hex'),
         1, 1, decode(repeat('05', 12), 'hex'),
         decode(repeat('06', 20), 'hex'),
         ARRAY[$4::app.group_name_blind_index], true, $3, $3, $3
       )`,
      [accountId, `wi1_${"A".repeat(43)}`, observedAt, `gi1_${"A".repeat(43)}`],
    );

    await expect(
      repository.beginToolCall({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000039",
        hourLimit: 10,
        minuteLimit: 10,
        observedAt,
        toolName: "list_groups",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await expect(
      repository.loadGroupSearchMaterial({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
      }),
    ).resolves.toMatchObject({
      identityKey: { keyVersion: 1, version: 1 },
    });
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: `gi1_${"B".repeat(43)}`,
      }),
    ).resolves.toMatchObject({ groups: [] });
    const page = await repository.listGroups({
      ...authorization,
      connectionPublicId: connectionA,
      observedAt,
      searchIndex: `gi1_${"A".repeat(43)}`,
    });
    expect(page).toMatchObject({
      asOf: "2026-07-31T12:00:00.000Z",
      groups: [
        {
          id: "30000000-0000-4000-8000-000000000039",
          publicId: "grp_123456789012345678939",
        },
      ],
      partial: false,
      stale: false,
    });
    expect(page?.groups[0]?.displayName?.ciphertext).not.toContain("Family");

    await database.query(
      `UPDATE app.whatsapp_groups
       SET joined = false,
           name_prefix_indexes = ARRAY[]::app.group_name_blind_index[]
       WHERE public_id = 'grp_123456789012345678939'`,
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: `gi1_${"A".repeat(43)}`,
      }),
    ).resolves.toMatchObject({ groups: [] });
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionLater,
        observedAt,
        searchIndex: null,
      }),
    ).resolves.toBeNull();

    await database.query(
      `UPDATE app.whatsapp_groups SET joined = true
       WHERE public_id = 'grp_123456789012345678939'`,
    );
    await database.query(
      `UPDATE app.mcp_authorizations
       SET state = 'revoked', revoked_at = $2
       WHERE id = $1`,
      [authorizationId, observedAt],
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: null,
      }),
    ).resolves.toBeNull();
    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('app.personal_account_id', $1, true)",
        [accountId],
      );
      const protectedBoundary = await database.query(
        `SELECT * FROM app_private.load_mcp_group_projection_material(
          $1, $2, $3, $4, $5
        )`,
        [
          authorizationId,
          authorization.oauthSubject,
          authorization.clientId,
          observedAt,
          connectionA,
        ],
      );
      expect(protectedBoundary.rows).toEqual([]);
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });
});
