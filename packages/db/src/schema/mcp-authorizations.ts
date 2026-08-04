import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { personalAccountsInApp } from "./accounts";
import { bytea, publicSchema } from "./common";
import { whatsappConnectionsInApp } from "./connections";

export const mcpAuthorizationsInApp = publicSchema.table(
  "mcp_authorizations",
  {
    id: uuid().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    oauthSubject: text("oauth_subject").notNull(),
    clientId: text("client_id").notNull(),
    clientClass: text("client_class").notNull(),
    scopes: text().array().notNull(),
    state: text().default("active").notNull(),
    reverifiedAt: timestamp("reverified_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    authorizedAt: timestamp("authorized_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    refreshFamilyState: text("refresh_family_state")
      .default("active")
      .notNull(),
    refreshFamilyRevokedAt: timestamp("refresh_family_revoked_at", {
      withTimezone: true,
      mode: "string",
    }),
    publicId: text("public_id")
      .default(
        sql`(\'mca_\'::text || translate(SUBSTRING(encode(decode(md5((gen_random_uuid())::text), \'hex\'::text), \'base64\'::text) FROM 1 FOR 21), \'+/\'::text, \'-_\'::text))`,
      )
      .notNull(),
    clientName: text("client_name"),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "mcp_authorizations_personal_account_id_fkey",
    }).onDelete("cascade"),
    unique("mcp_authorizations_oauth_subject_key").on(table.oauthSubject),
    unique("mcp_authorizations_personal_account_id_id_key").on(
      table.id,
      table.personalAccountId,
    ),
    unique(
      "mcp_authorizations_personal_account_id_id_client_id_oauth_s_key",
    ).on(table.clientId, table.id, table.oauthSubject, table.personalAccountId),
    unique("mcp_authorizations_public_id_unique").on(table.publicId),
    pgPolicy("mcp_authorizations_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "mcp_authorizations_oauth_subject_check",
      sql`oauth_subject ~ '^[A-Za-z0-9_-]{43}$'::text`,
    ),
    check(
      "mcp_authorizations_client_id_check",
      sql`(length(client_id) >= 1) AND (length(client_id) <= 128)`,
    ),
    check(
      "mcp_authorizations_client_class_check",
      sql`client_class ~ '^[a-z][a-z0-9_-]{0,63}$'::text`,
    ),
    check(
      "mcp_authorizations_scopes_check",
      sql`((cardinality(scopes) >= 1) AND (cardinality(scopes) <= 4)) AND (scopes <@ ARRAY['connections:read'::text, 'directory:read'::text, 'messages:read'::text, 'messages:send'::text]) AND (cardinality(scopes) = ((((('connections:read'::text = ANY (scopes)))::integer + (('directory:read'::text = ANY (scopes)))::integer) + (('messages:read'::text = ANY (scopes)))::integer) + (('messages:send'::text = ANY (scopes)))::integer))`,
    ),
    check(
      "mcp_authorizations_state_check",
      sql`state = ANY (ARRAY['active'::text, 'revoked'::text])`,
    ),
    check(
      "mcp_authorizations_check",
      sql`(reverified_at <= authorized_at) AND (reverified_at > (authorized_at - '00:05:00'::interval))`,
    ),
    check(
      "mcp_authorizations_check1",
      sql`(absolute_expires_at > authorized_at) AND (absolute_expires_at <= (authorized_at + '90 days'::interval))`,
    ),
    check(
      "mcp_authorizations_check2",
      sql`((state = 'active'::text) AND (revoked_at IS NULL)) OR ((state = 'revoked'::text) AND (revoked_at IS NOT NULL))`,
    ),
    check(
      "mcp_authorizations_refresh_family_state_check",
      sql`refresh_family_state = ANY (ARRAY['active'::text, 'revoked'::text])`,
    ),
    check(
      "mcp_authorizations_refresh_family_revoked_at_check",
      sql`((refresh_family_state = 'active'::text) AND (refresh_family_revoked_at IS NULL)) OR ((refresh_family_state = 'revoked'::text) AND (refresh_family_revoked_at IS NOT NULL))`,
    ),
    check(
      "mcp_authorizations_client_name_check",
      sql`(client_name IS NULL) OR (((length(client_name) >= 1) AND (length(client_name) <= 128)) AND (client_name = btrim(client_name)))`,
    ),
    check(
      "mcp_authorizations_public_id_format",
      sql`public_id ~ '^mca_[A-Za-z0-9_-]{21}$'::text`,
    ),
  ],
);

export const mcpRefreshCredentialsInApp = publicSchema.table(
  "mcp_refresh_credentials",
  {
    credentialHash: bytea("credential_hash").primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    mcpAuthorizationId: uuid("mcp_authorization_id").notNull(),
    issuedAt: timestamp("issued_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    inactiveExpiresAt: timestamp("inactive_expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("mcp_refresh_credentials_one_current")
      .using("btree", table.mcpAuthorizationId.asc().nullsLast().op("uuid_ops"))
      .where(sql`(consumed_at IS NULL)`),
    foreignKey({
      columns: [table.personalAccountId, table.mcpAuthorizationId],
      foreignColumns: [
        mcpAuthorizationsInApp.id,
        mcpAuthorizationsInApp.personalAccountId,
      ],
      name: "mcp_refresh_credentials_personal_account_id_mcp_authorizat_fkey",
    }).onDelete("cascade"),
    pgPolicy("mcp_refresh_credentials_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "mcp_refresh_credentials_credential_hash_check",
      sql`octet_length(credential_hash) = 32`,
    ),
    check(
      "mcp_refresh_credentials_check",
      sql`(inactive_expires_at > issued_at) AND (inactive_expires_at <= (issued_at + '30 days'::interval))`,
    ),
    check(
      "mcp_refresh_credentials_check1",
      sql`(consumed_at IS NULL) OR (consumed_at >= issued_at)`,
    ),
  ],
);

export const mcpAuthorizationConnectionsInApp = publicSchema.table(
  "mcp_authorization_connections",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    mcpAuthorizationId: uuid("mcp_authorization_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.mcpAuthorizationId],
      foreignColumns: [
        mcpAuthorizationsInApp.id,
        mcpAuthorizationsInApp.personalAccountId,
      ],
      name: "mcp_authorization_connections_personal_account_id_mcp_auth_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "mcp_authorization_connections_personal_account_id_whatsapp_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.mcpAuthorizationId, table.whatsappConnectionId],
      name: "mcp_authorization_connections_pkey",
    }),
    pgPolicy("mcp_authorization_connections_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
  ],
);
