import { and, asc, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { makeDatabase, makeQueryConnection } from "./database";
import type {
  PersonalAccountConnection,
  PersonalAccountConnectionProvider,
} from "./personal-account";
import { withPgRequestConnection } from "./request-connection";
import {
  mcpAuthorizationConnectionsInApp,
  mcpAuthorizationsInApp,
  mcpRefreshCredentialsInApp,
  personalAccountsInApp,
  whatsappConnectionsInApp,
} from "./schema";
import { withTransaction } from "./transaction";

export const MCP_AUTHORIZATION_SCOPES = [
  "connections:read",
  "directory:read",
  "messages:read",
  "messages:send",
] as const;

export type McpAuthorizationScope = (typeof MCP_AUTHORIZATION_SCOPES)[number];

export interface SelectableWhatsAppConnection {
  readonly accountKey: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly kmsKeyId: string;
    readonly personalAccountId: string;
    readonly version: 1;
  } | null;
  readonly connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: string;
    readonly connectionId: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly personalAccountId: string;
    readonly version: 1;
  } | null;
  readonly connectionId: string;
  readonly displayName: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly version: 1;
  } | null;
  readonly displayNameFallback: string | null;
  readonly numberSuffix: string | null;
}

const base64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const bytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  return null;
};

export interface CreateMcpAuthorizationInput {
  readonly authorizationId: string;
  readonly authorizedAt: Date;
  readonly clientClass: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly clerkUserId: string;
  readonly connectionIds: ReadonlyArray<string>;
  readonly expiresAt: Date;
  readonly oauthSubject: string;
  readonly reverifiedAt: Date;
  readonly scopes: ReadonlyArray<McpAuthorizationScope>;
}

export interface McpAuthorizationSummary {
  readonly authorizationId: string;
  readonly authorizedAt: Date;
  readonly clientClass: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly connectionIds: ReadonlyArray<string>;
  readonly expired: boolean;
  readonly expiresAt: Date;
  readonly revoked: boolean;
  readonly revokedAt: Date | null;
  readonly scopes: ReadonlyArray<McpAuthorizationScope>;
}

export interface McpAuthorizationRepository {
  readonly create: (input: CreateMcpAuthorizationInput) => Promise<boolean>;
  readonly isActive: (input: {
    readonly authorizationId: string;
    readonly clientId?: string | undefined;
    readonly observedAt: Date;
    readonly oauthSubject: string;
  }) => Promise<boolean>;
  readonly listConnections: (
    clerkUserId: string,
  ) => Promise<ReadonlyArray<SelectableWhatsAppConnection> | null>;
  readonly list: (
    clerkUserId: string,
    observedAt: Date,
  ) => Promise<ReadonlyArray<McpAuthorizationSummary> | null>;
  readonly registerRefreshCredential: (
    input: RefreshCredentialInput,
  ) => Promise<boolean>;
  readonly revoke: (input: {
    readonly authorizationId: string;
    readonly clerkUserId: string;
    readonly revokedAt: Date;
  }) => Promise<{ readonly revokedAt: Date } | null>;
  readonly rotateRefreshCredential: <Value>(
    input: RefreshCredentialInput,
    issue: () => Promise<{
      readonly credentialHash: Uint8Array;
      readonly value: Value;
    }>,
  ) => Promise<RefreshCredentialRotationResult<Value>>;
}

export interface RefreshCredentialInput {
  readonly clientId: string;
  readonly credentialHash: Uint8Array;
  readonly oauthSubject: string;
  readonly observedAt: Date;
}

export type RefreshCredentialRotationResult<Value> =
  | { readonly outcome: "invalid" | "reuse" }
  | { readonly outcome: "rotated"; readonly value: Value };

const enterClerkContext = async (
  connection: PersonalAccountConnection,
  clerkUserId: string,
): Promise<string | null> => {
  const db = makeDatabase(connection);
  const result = await db.execute<{ personal_account_id: string | null }>(sql`
    SELECT public.bootstrap_personal_account_for_clerk(${clerkUserId})
      AS personal_account_id
  `);
  const personalAccountId = result[0]?.personal_account_id;
  if (typeof personalAccountId !== "string") return null;
  await db.execute(
    sql`SELECT set_config('public.personal_account_id', ${personalAccountId}, true)`,
  );
  const account = await db
    .select({ id: personalAccountsInApp.id })
    .from(personalAccountsInApp)
    .where(
      and(
        eq(personalAccountsInApp.id, personalAccountId),
        eq(personalAccountsInApp.state, "active"),
      ),
    );
  return account.length === 1 ? personalAccountId : null;
};

export const makeMcpAuthorizationRepository = (
  provider: PersonalAccountConnectionProvider,
): McpAuthorizationRepository => ({
  create: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        const personalAccountId = await enterClerkContext(
          connection,
          input.clerkUserId,
        );
        if (personalAccountId === null) return false;
        if (
          input.connectionIds.length === 0 ||
          new Set(input.connectionIds).size !== input.connectionIds.length ||
          input.scopes.length === 0 ||
          new Set(input.scopes).size !== input.scopes.length
        ) {
          return false;
        }
        const selected = await db
          .select({ id: whatsappConnectionsInApp.id })
          .from(whatsappConnectionsInApp)
          .where(
            inArray(whatsappConnectionsInApp.publicId, input.connectionIds),
          )
          .orderBy(asc(whatsappConnectionsInApp.publicId));
        if (selected.length !== input.connectionIds.length) return false;

        await db.insert(mcpAuthorizationsInApp).values({
          absoluteExpiresAt: input.expiresAt.toISOString(),
          authorizedAt: input.authorizedAt.toISOString(),
          clientClass: input.clientClass,
          clientId: input.clientId,
          clientName: input.clientName,
          id: input.authorizationId,
          oauthSubject: input.oauthSubject,
          personalAccountId,
          reverifiedAt: input.reverifiedAt.toISOString(),
          scopes: [...input.scopes],
        });
        await db.insert(mcpAuthorizationConnectionsInApp).values(
          selected.map((row) => ({
            mcpAuthorizationId: input.authorizationId,
            personalAccountId,
            whatsappConnectionId: row.id,
          })),
        );
        return true;
      }),
    ),
  isActive: (input) =>
    provider.withConnection((connection) =>
      (async () => {
        const db = makeDatabase(connection);
        const context = await db.execute<{
          personal_account_id: string | null;
        }>(
          input.clientId === undefined
            ? sql`SELECT public.bootstrap_mcp_access_authorization(
                ${input.authorizationId}, ${input.oauthSubject}, ${input.observedAt}
              ) AS personal_account_id`
            : sql`SELECT public.bootstrap_mcp_authorization(
                ${input.authorizationId}, ${input.oauthSubject},
                ${input.clientId}, ${input.observedAt}
              ) AS personal_account_id`,
        );
        const personalAccountId = context[0]?.personal_account_id;
        return typeof personalAccountId === "string";
      })(),
    ),
  listConnections: (clerkUserId) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if ((await enterClerkContext(connection, clerkUserId)) === null) {
          return null;
        }
        const result = await db.execute<Record<string, unknown>>(sql`
          SELECT
            account_keys.ciphertext AS account_key_ciphertext,
            account_keys.key_version AS account_key_version,
            account_keys.kms_key_id AS account_kms_key_id,
            connections.id AS connection_id,
            connection_keys.account_key_version AS connection_key_account_version,
            connection_keys.ciphertext AS connection_key_ciphertext,
            connection_keys.nonce AS connection_key_nonce,
            connection_keys.key_version AS connection_key_version,
            connections.display_name_ciphertext AS display_name_ciphertext,
            connections.display_name_ciphertext_version AS display_name_ciphertext_version,
            connections.display_name_fallback AS display_name_fallback,
            connections.display_name_key_version AS display_name_key_version,
            connections.display_name_nonce AS display_name_nonce,
            connections.number_suffix AS number_suffix,
            connections.personal_account_id AS personal_account_id,
            connections.public_id AS public_id
          FROM public.whatsapp_connections AS connections
          LEFT JOIN public.personal_account_key_envelopes AS account_keys
            ON account_keys.personal_account_id = connections.personal_account_id
           AND account_keys.unavailable_at IS NULL
          LEFT JOIN public.whatsapp_connection_key_envelopes AS connection_keys
            ON connection_keys.personal_account_id = connections.personal_account_id
           AND connection_keys.whatsapp_connection_id = connections.id
           AND connection_keys.unavailable_at IS NULL
          ORDER BY connections.created_at, connections.public_id
        `);
        return result.map((row) => {
          const accountKeyCiphertext = bytes(row.account_key_ciphertext);
          const connectionKeyCiphertext = bytes(row.connection_key_ciphertext);
          const connectionKeyNonce = bytes(row.connection_key_nonce);
          const displayNameCiphertext = bytes(row.display_name_ciphertext);
          const displayNameNonce = bytes(row.display_name_nonce);
          const displayNameFallback =
            typeof row.display_name_fallback === "string"
              ? row.display_name_fallback
              : null;
          const hasEncryptedName = displayNameCiphertext !== null;
          const hasEncryptionMaterial =
            accountKeyCiphertext !== null &&
            typeof row.account_key_version === "number" &&
            typeof row.account_kms_key_id === "string" &&
            typeof row.connection_key_account_version === "number" &&
            connectionKeyCiphertext !== null &&
            connectionKeyNonce !== null &&
            typeof row.connection_key_version === "number" &&
            row.display_name_ciphertext_version === 1 &&
            typeof row.display_name_key_version === "number" &&
            displayNameNonce !== null;
          if (
            hasEncryptedName === (displayNameFallback !== null) ||
            (hasEncryptedName && !hasEncryptionMaterial) ||
            typeof row.connection_id !== "string" ||
            typeof row.personal_account_id !== "string" ||
            typeof row.public_id !== "string" ||
            (row.number_suffix !== null &&
              typeof row.number_suffix !== "string")
          ) {
            throw new Error("invalid persisted WhatsApp Connection name");
          }
          return {
            accountKey: hasEncryptedName
              ? {
                  ciphertext: base64(accountKeyCiphertext as Uint8Array),
                  keyVersion: row.account_key_version as number,
                  kmsKeyId: row.account_kms_key_id as string,
                  personalAccountId: row.personal_account_id,
                  version: 1 as const,
                }
              : null,
            connectionId: row.public_id,
            connectionKey: hasEncryptedName
              ? {
                  accountKeyVersion:
                    row.connection_key_account_version as number,
                  ciphertext: base64(connectionKeyCiphertext as Uint8Array),
                  connectionId: row.connection_id,
                  keyVersion: row.connection_key_version as number,
                  nonce: base64(connectionKeyNonce as Uint8Array),
                  personalAccountId: row.personal_account_id,
                  version: 1 as const,
                }
              : null,
            displayName: hasEncryptedName
              ? {
                  ciphertext: base64(displayNameCiphertext),
                  keyVersion: row.display_name_key_version as number,
                  nonce: base64(displayNameNonce as Uint8Array),
                  version: 1 as const,
                }
              : null,
            displayNameFallback,
            numberSuffix: row.number_suffix as string | null,
          };
        });
      }),
    ),
  list: (clerkUserId, observedAt) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if ((await enterClerkContext(connection, clerkUserId)) === null) {
          return null;
        }
        const result = await db
          .select({
            absoluteExpiresAt: mcpAuthorizationsInApp.absoluteExpiresAt,
            authorizedAt: mcpAuthorizationsInApp.authorizedAt,
            clientClass: mcpAuthorizationsInApp.clientClass,
            clientId: mcpAuthorizationsInApp.clientId,
            clientName: mcpAuthorizationsInApp.clientName,
            connectionPublicId: sql<
              string | null
            >`${whatsappConnectionsInApp.publicId}`.as("connection_public_id"),
            publicId: sql<string>`${mcpAuthorizationsInApp.publicId}`.as(
              "authorization_public_id",
            ),
            revokedAt: mcpAuthorizationsInApp.revokedAt,
            scopes: mcpAuthorizationsInApp.scopes,
            state: mcpAuthorizationsInApp.state,
          })
          .from(mcpAuthorizationsInApp)
          .leftJoin(
            mcpAuthorizationConnectionsInApp,
            and(
              eq(
                mcpAuthorizationConnectionsInApp.personalAccountId,
                mcpAuthorizationsInApp.personalAccountId,
              ),
              eq(
                mcpAuthorizationConnectionsInApp.mcpAuthorizationId,
                mcpAuthorizationsInApp.id,
              ),
            ),
          )
          .leftJoin(
            whatsappConnectionsInApp,
            and(
              eq(
                whatsappConnectionsInApp.personalAccountId,
                mcpAuthorizationConnectionsInApp.personalAccountId,
              ),
              eq(
                whatsappConnectionsInApp.id,
                mcpAuthorizationConnectionsInApp.whatsappConnectionId,
              ),
            ),
          )
          .orderBy(
            desc(mcpAuthorizationsInApp.authorizedAt),
            asc(mcpAuthorizationsInApp.publicId),
            asc(whatsappConnectionsInApp.createdAt),
            asc(whatsappConnectionsInApp.publicId),
          );
        const summaries = new Map<string, McpAuthorizationSummary>();
        for (const row of result) {
          const existing = summaries.get(row.publicId);
          if (existing !== undefined) {
            if (row.connectionPublicId !== null) {
              (existing.connectionIds as Array<string>).push(
                row.connectionPublicId,
              );
            }
            continue;
          }
          const authorizedAt = new Date(row.authorizedAt);
          const expiresAt = new Date(row.absoluteExpiresAt);
          summaries.set(row.publicId, {
            authorizationId: row.publicId,
            authorizedAt,
            clientClass: row.clientClass,
            clientId: row.clientId,
            clientName: row.clientName ?? row.clientId,
            connectionIds:
              row.connectionPublicId === null ? [] : [row.connectionPublicId],
            expired: expiresAt <= observedAt,
            expiresAt,
            revoked: row.state === "revoked",
            revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt),
            scopes: row.scopes as Array<McpAuthorizationScope>,
          });
        }
        return [...summaries.values()];
      }),
    ),
  registerRefreshCredential: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (input.credentialHash.byteLength !== 32) return false;
        const context = await db.execute<{
          mcp_authorization_id: string;
          personal_account_id: string;
        }>(sql`
          SELECT personal_account_id, mcp_authorization_id
          FROM public.bootstrap_mcp_refresh_authorization(
            ${input.oauthSubject}, ${input.clientId}, ${input.observedAt}
          )
        `);
        const authorization = context[0];
        if (authorization === undefined) return false;
        await db.execute(
          sql`SELECT set_config(
            'public.personal_account_id', ${authorization.personal_account_id}, true
          )`,
        );
        const inserted = await db
          .insert(mcpRefreshCredentialsInApp)
          .select(
            db
              .select({
                credentialHash: sql<Uint8Array>`${input.credentialHash}`.as(
                  "credential_hash",
                ),
                personalAccountId: mcpAuthorizationsInApp.personalAccountId,
                mcpAuthorizationId: mcpAuthorizationsInApp.id,
                issuedAt: sql<string>`${input.observedAt}::timestamptz`.as(
                  "issued_at",
                ),
                inactiveExpiresAt: sql<string>`LEAST(
                  ${input.observedAt}::timestamptz + interval '30 days',
                  ${mcpAuthorizationsInApp.absoluteExpiresAt}
                )`.as("inactive_expires_at"),
                consumedAt: sql<string | null>`NULL::timestamptz`.as(
                  "consumed_at",
                ),
              })
              .from(mcpAuthorizationsInApp)
              .where(
                and(
                  eq(
                    mcpAuthorizationsInApp.id,
                    authorization.mcp_authorization_id,
                  ),
                  notExists(
                    db
                      .select({
                        credentialHash:
                          mcpRefreshCredentialsInApp.credentialHash,
                      })
                      .from(mcpRefreshCredentialsInApp)
                      .where(
                        eq(
                          mcpRefreshCredentialsInApp.mcpAuthorizationId,
                          mcpAuthorizationsInApp.id,
                        ),
                      ),
                  ),
                ),
              ),
          )
          .returning({
            credentialHash: mcpRefreshCredentialsInApp.credentialHash,
          });
        return inserted.length === 1;
      }),
    ),
  revoke: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (!/^mca_[A-Za-z0-9_-]{21}$/u.test(input.authorizationId)) {
          return null;
        }
        if ((await enterClerkContext(connection, input.clerkUserId)) === null) {
          return null;
        }
        const revoked = await db
          .update(mcpAuthorizationsInApp)
          .set({
            refreshFamilyRevokedAt: sql`COALESCE(
              ${mcpAuthorizationsInApp.refreshFamilyRevokedAt}, ${input.revokedAt}
            )`,
            refreshFamilyState: "revoked",
            revokedAt: sql`COALESCE(
              ${mcpAuthorizationsInApp.revokedAt}, ${input.revokedAt}
            )`,
            state: "revoked",
          })
          .where(eq(mcpAuthorizationsInApp.publicId, input.authorizationId))
          .returning({ revokedAt: mcpAuthorizationsInApp.revokedAt });
        const revokedAt = revoked[0]?.revokedAt;
        return revokedAt == null ? null : { revokedAt: new Date(revokedAt) };
      }),
    ),
  rotateRefreshCredential: (input, issue) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (input.credentialHash.byteLength !== 32) {
          return { outcome: "invalid" as const };
        }
        const context = await db.execute<{
          mcp_authorization_id: string;
          personal_account_id: string;
        }>(sql`
          WITH refresh_context AS MATERIALIZED (
            SELECT personal_account_id, mcp_authorization_id
            FROM public.bootstrap_mcp_refresh_credential(
              ${input.credentialHash}, ${input.oauthSubject}, ${input.clientId}
            )
          )
          SELECT refresh_context.personal_account_id,
                 refresh_context.mcp_authorization_id,
                 set_config(
                   'public.personal_account_id',
                   refresh_context.personal_account_id::text,
                   true
                 ) AS configured_account_id
          FROM refresh_context
        `);
        const authorization = context[0];
        if (authorization === undefined) {
          return { outcome: "invalid" as const };
        }
        const locked = await db
          .select({
            consumedAt: mcpRefreshCredentialsInApp.consumedAt,
            inactiveExpiresAt: mcpRefreshCredentialsInApp.inactiveExpiresAt,
            refreshFamilyState: mcpAuthorizationsInApp.refreshFamilyState,
          })
          .from(mcpRefreshCredentialsInApp)
          .innerJoin(
            mcpAuthorizationsInApp,
            and(
              eq(
                mcpAuthorizationsInApp.personalAccountId,
                mcpRefreshCredentialsInApp.personalAccountId,
              ),
              eq(
                mcpAuthorizationsInApp.id,
                mcpRefreshCredentialsInApp.mcpAuthorizationId,
              ),
            ),
          )
          .where(
            and(
              eq(
                mcpRefreshCredentialsInApp.credentialHash,
                input.credentialHash,
              ),
              eq(
                mcpRefreshCredentialsInApp.mcpAuthorizationId,
                authorization.mcp_authorization_id,
              ),
            ),
          )
          .for("update");
        const credential = locked[0];
        if (credential === undefined) {
          return { outcome: "invalid" as const };
        }
        if (credential.consumedAt !== null) {
          await db
            .update(mcpAuthorizationsInApp)
            .set({
              refreshFamilyRevokedAt: sql`COALESCE(
                ${mcpAuthorizationsInApp.refreshFamilyRevokedAt},
                ${input.observedAt}
              )`,
              refreshFamilyState: "revoked",
            })
            .where(
              eq(mcpAuthorizationsInApp.id, authorization.mcp_authorization_id),
            );
          return { outcome: "reuse" as const };
        }
        const current = await db.execute<{
          personal_account_id: string | null;
        }>(sql`
          SELECT public.bootstrap_mcp_authorization(
            ${authorization.mcp_authorization_id}, ${input.oauthSubject},
            ${input.clientId}, ${input.observedAt}
          ) AS personal_account_id
        `);
        if (
          credential.refreshFamilyState !== "active" ||
          new Date(credential.inactiveExpiresAt) <= input.observedAt ||
          current[0]?.personal_account_id !== authorization.personal_account_id
        ) {
          return { outcome: "invalid" as const };
        }

        const issued = await issue();
        if (issued.credentialHash.byteLength !== 32) {
          throw new Error("invalid rotated refresh credential hash");
        }
        await db
          .update(mcpRefreshCredentialsInApp)
          .set({ consumedAt: input.observedAt.toISOString() })
          .where(
            eq(mcpRefreshCredentialsInApp.credentialHash, input.credentialHash),
          );
        await db.insert(mcpRefreshCredentialsInApp).select(
          db
            .select({
              credentialHash: sql<Uint8Array>`${issued.credentialHash}`.as(
                "credential_hash",
              ),
              personalAccountId: mcpAuthorizationsInApp.personalAccountId,
              mcpAuthorizationId: mcpAuthorizationsInApp.id,
              issuedAt: sql<string>`${input.observedAt}::timestamptz`.as(
                "issued_at",
              ),
              inactiveExpiresAt: sql<string>`LEAST(
                ${input.observedAt}::timestamptz + interval '30 days',
                ${mcpAuthorizationsInApp.absoluteExpiresAt}
              )`.as("inactive_expires_at"),
              consumedAt: sql<string | null>`NULL::timestamptz`.as(
                "consumed_at",
              ),
            })
            .from(mcpAuthorizationsInApp)
            .where(
              eq(mcpAuthorizationsInApp.id, authorization.mcp_authorization_id),
            ),
        );
        return { outcome: "rotated" as const, value: issued.value };
      }),
    ),
});

const makePgConnectionProvider = (
  connectionString: string,
): PersonalAccountConnectionProvider => ({
  withConnection: (use) =>
    withPgRequestConnection(connectionString, (client) =>
      use(makeQueryConnection(client)),
    ),
});

export const makePgMcpAuthorizationRepository = (
  connectionString: string,
): McpAuthorizationRepository =>
  makeMcpAuthorizationRepository(makePgConnectionProvider(connectionString));
