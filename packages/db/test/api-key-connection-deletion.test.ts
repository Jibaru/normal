import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { type ApiKeyRepository, makeApiKeyRepository } from "../src/api-key";
import { makeMcpToolRepository } from "../src/mcp-tool";
import { makeWhatsAppConnectionRepository } from "../src/whatsapp-connection";
import { createMigratedDatabase } from "./support/migrated-database";

const accountId = "10000000-0000-4000-8000-000000000091";
const connectionIdA = "20000000-0000-4000-8000-000000000091";
const connectionIdB = "20000000-0000-4000-8000-000000000092";
const connectionA = "con_123456789012345678991";
const connectionB = "con_123456789012345678992";
const clerkUserId = "user_apikey91";
const createdAt = new Date("2026-08-17T12:00:00.000Z");
const reverifiedAt = new Date("2026-08-17T11:59:00.000Z");
const requestedAt = "2026-08-17T12:08:00.000Z";
const deletionMarkerId = "a".repeat(64);
const digestOnlyA = new Uint8Array(32).fill(17);
const digestBoth = new Uint8Array(32).fill(18);
const digestOnlyB = new Uint8Array(32).fill(19);
const publicIdOnlyA = "apk_123456789012345678991";
const publicIdBoth = "apk_123456789012345678992";
const publicIdOnlyB = "apk_123456789012345678993";

const hintFor = (publicId: string): string => `normal_${publicId}.…wxyz`;

describe("API Key Connection Deletion", () => {
  let database: PGlite;
  let repository: ApiKeyRepository;

  const createKey = (
    overrides: Partial<Parameters<ApiKeyRepository["create"]>[0]> = {},
  ) =>
    repository.create({
      clerkUserId,
      connectionIds: [connectionA],
      createdAt,
      credentialDigest: digestOnlyA,
      credentialHint: hintFor(overrides.publicId ?? publicIdOnlyA),
      expiresAt: null,
      id: overrides.id ?? "50000000-0000-4000-8000-000000000091",
      name: "Only A",
      permissions: ["connections:read", "messages:send"],
      publicId: publicIdOnlyA,
      reverifiedAt,
      ...overrides,
    });

  const deleteConnection = (publicId: string) =>
    makeWhatsAppConnectionRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    }).finishDeletion({
      clerkUserId,
      deletionMarkerId,
      publicId,
      requestedAt,
    });

  beforeEach(async () => {
    database = await createMigratedDatabase();
    await database.query(
      `SELECT * FROM public.admit_personal_account_for_clerk(
        $1, $2, 1, $3, decode('0102', 'hex'), 6
      )`,
      [
        clerkUserId,
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
          id, personal_account_id, webhook_ingress_id,
          display_name_fallback, public_id, number_suffix
        ) VALUES
          ($1, $2, '30000000-0000-4000-8000-000000000091', 'Bright Badger',
           $3, '3456'),
          ($4, $2, '30000000-0000-4000-8000-000000000092', 'Calm Falcon',
           $5, '7890')`,
      [connectionIdA, accountId, connectionA, connectionIdB, connectionB],
    );
    repository = makeApiKeyRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("removes the Connection, revokes a last-selected key, and keeps other grants", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    expect(
      await createKey({
        connectionIds: [connectionA, connectionB],
        credentialDigest: digestBoth,
        credentialHint: hintFor(publicIdBoth),
        id: "50000000-0000-4000-8000-000000000092",
        name: "Both",
        publicId: publicIdBoth,
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await createKey({
        connectionIds: [connectionB],
        credentialDigest: digestOnlyB,
        credentialHint: hintFor(publicIdOnlyB),
        id: "50000000-0000-4000-8000-000000000093",
        name: "Only B",
        publicId: publicIdOnlyB,
      }),
    ).toMatchObject({ outcome: "created" });

    const first = await deleteConnection(connectionA);
    const replay = await deleteConnection(connectionA);
    expect(first).toEqual({
      deletionMarkerId,
      publicId: connectionA,
      requestedAt,
    });
    expect(replay).toEqual(first);

    const persisted = await database.query<{
      digest: Uint8Array | null;
      metadata_expires_at: Date | null;
      public_id: string;
      revoked_at: Date | null;
      state: string;
    }>(
      `SELECT public_id, state, credential_digest AS digest, revoked_at,
              metadata_expires_at
       FROM public.api_keys
       ORDER BY public_id`,
    );
    expect(persisted.rows).toEqual([
      {
        digest: null,
        metadata_expires_at: new Date(
          Date.parse(requestedAt) + 90 * 24 * 60 * 60 * 1000,
        ),
        public_id: publicIdOnlyA,
        revoked_at: new Date(requestedAt),
        state: "revoked",
      },
      {
        digest: digestBoth,
        metadata_expires_at: null,
        public_id: publicIdBoth,
        revoked_at: null,
        state: "active",
      },
      {
        digest: digestOnlyB,
        metadata_expires_at: null,
        public_id: publicIdOnlyB,
        revoked_at: null,
        state: "active",
      },
    ]);

    const selections = await database.query<{
      api_key_id: string;
      whatsapp_connection_id: string;
    }>(
      `SELECT api_key_id, whatsapp_connection_id
       FROM public.api_key_connections
       ORDER BY api_key_id, whatsapp_connection_id`,
    );
    expect(selections.rows).toEqual([
      {
        api_key_id: "50000000-0000-4000-8000-000000000092",
        whatsapp_connection_id: connectionIdB,
      },
      {
        api_key_id: "50000000-0000-4000-8000-000000000093",
        whatsapp_connection_id: connectionIdB,
      },
    ]);

    const revoked = await repository.authenticate({
      digest: digestOnlyA,
      publicId: publicIdOnlyA,
    });
    const unknown = await repository.authenticate({
      digest: digestOnlyA,
      publicId: "apk_999999999999999999999",
    });
    expect(revoked).toBeNull();
    expect(unknown).toBeNull();
    expect(revoked).toEqual(unknown);

    const remaining = await repository.authenticate({
      digest: digestBoth,
      publicId: publicIdBoth,
    });
    expect(remaining).toMatchObject({
      connectionIds: [connectionB],
      id: publicIdBoth,
    });
    expect(remaining?.connectionIds).not.toContain(connectionA);

    const tools = makeMcpToolRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });
    expect(
      await tools.listApiKeyConnections({
        apiKeyGrantId: "50000000-0000-4000-8000-000000000091",
        observedAt: new Date(requestedAt),
        personalAccountId: accountId,
      }),
    ).toBeNull();
    expect(
      (
        await tools.listApiKeyConnections({
          apiKeyGrantId: "50000000-0000-4000-8000-000000000092",
          observedAt: new Date(requestedAt),
          personalAccountId: accountId,
        })
      )?.map((row) => row.publicId),
    ).toEqual([connectionB]);

    const listed = await repository.list(clerkUserId, new Date(requestedAt));
    expect(listed?.find((key) => key.id === publicIdOnlyA)).toMatchObject({
      connectionIds: [],
      state: "revoked",
    });
    expect(
      listed?.find((key) => key.id === publicIdBoth)?.connectionIds,
    ).toEqual([connectionB]);
  });

  test("keeps selection and the credential after ordinary disconnection", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    await database.query(
      `UPDATE public.whatsapp_connections
       SET state = 'disconnected'
       WHERE public_id = $1`,
      [connectionA],
    );

    const accepted = await repository.authenticate({
      digest: digestOnlyA,
      publicId: publicIdOnlyA,
    });
    expect(accepted).toMatchObject({
      connectionIds: [connectionA],
      id: publicIdOnlyA,
    });

    const persisted = await database.query<{
      digest_present: boolean;
      state: string;
    }>(
      `SELECT state, credential_digest IS NOT NULL AS digest_present
       FROM public.api_keys WHERE public_id = $1`,
      [publicIdOnlyA],
    );
    expect(persisted.rows).toEqual([{ digest_present: true, state: "active" }]);

    const tools = makeMcpToolRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });
    expect(
      (
        await tools.listApiKeyConnections({
          apiKeyGrantId: "50000000-0000-4000-8000-000000000091",
          observedAt: createdAt,
          personalAccountId: accountId,
        })
      )?.map((row) => row.publicId),
    ).toEqual([connectionA]);
  });
});
