import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  bytea,
  directoryBlindIndex,
  groupNameBlindIndex,
  publicSchema,
} from "./common";
import { whatsappConnectionsInApp } from "./connections";
import { webhookEventsInApp } from "./webhooks";

export const whatsappGroupsInApp = publicSchema.table(
  "whatsapp_groups",
  {
    id: uuid().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    publicId: text("public_id").notNull(),
    providerLocator: text("provider_locator").notNull(),
    namePrefixIndexes: groupNameBlindIndex("name_prefix_indexes")
      .array()
      .default(["RAY"])
      .notNull(),
    displayNameCiphertextVersion: smallint("display_name_ciphertext_version"),
    displayNameKeyVersion: integer("display_name_key_version"),
    displayNameNonce: bytea("display_name_nonce"),
    displayNameCiphertext: bytea("display_name_ciphertext"),
    providerIdentityCiphertextVersion: smallint(
      "provider_identity_ciphertext_version",
    ).notNull(),
    providerIdentityKeyVersion: integer(
      "provider_identity_key_version",
    ).notNull(),
    providerIdentityNonce: bytea("provider_identity_nonce").notNull(),
    providerIdentityCiphertext: bytea("provider_identity_ciphertext").notNull(),
    joined: boolean().notNull(),
    lastObservedAt: timestamp("last_observed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    providerOccurredAt: timestamp("provider_occurred_at", {
      withTimezone: true,
      mode: "string",
    }),
    providerVersion: text("provider_version"),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "string",
    }),
    webhookEventId: uuid("webhook_event_id"),
    webhookItemIdentity: text("webhook_item_identity"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    index("whatsapp_groups_joined_name_prefixes")
      .using("gin", table.namePrefixIndexes.asc().nullsLast().op("array_ops"))
      .where(sql`joined`),
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "whatsapp_groups_personal_account_id_whatsapp_connection_id_fkey",
    }).onDelete("cascade"),
    unique("whatsapp_groups_public_id_key").on(table.publicId),
    unique(
      "whatsapp_groups_personal_account_id_whatsapp_connection_id__key",
    ).on(
      table.personalAccountId,
      table.providerLocator,
      table.whatsappConnectionId,
    ),
    unique(
      "whatsapp_groups_personal_account_id_whatsapp_connection_id_key1",
    ).on(table.id, table.personalAccountId, table.whatsappConnectionId),
    pgPolicy("whatsapp_groups_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "whatsapp_groups_public_id_check",
      sql`public_id ~ '^grp_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "whatsapp_groups_provider_locator_check",
      sql`provider_locator ~ '^wi1_[A-Za-z0-9_-]{43}$'::text`,
    ),
    check(
      "whatsapp_groups_display_name_ciphertext_version_check",
      sql`(display_name_ciphertext_version IS NULL) OR (display_name_ciphertext_version > 0)`,
    ),
    check(
      "whatsapp_groups_display_name_key_version_check",
      sql`(display_name_key_version IS NULL) OR (display_name_key_version > 0)`,
    ),
    check(
      "whatsapp_groups_display_name_nonce_check",
      sql`(display_name_nonce IS NULL) OR (octet_length(display_name_nonce) = 12)`,
    ),
    check(
      "whatsapp_groups_provider_identity_ciphertext_version_check",
      sql`provider_identity_ciphertext_version > 0`,
    ),
    check(
      "whatsapp_groups_provider_identity_key_version_check",
      sql`provider_identity_key_version > 0`,
    ),
    check(
      "whatsapp_groups_provider_identity_nonce_check",
      sql`octet_length(provider_identity_nonce) = 12`,
    ),
    check(
      "whatsapp_groups_provider_identity_ciphertext_check",
      sql`octet_length(provider_identity_ciphertext) > 16`,
    ),
    check(
      "whatsapp_groups_webhook_item_identity_check",
      sql`(webhook_item_identity IS NULL) OR (webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'::text)`,
    ),
    check(
      "whatsapp_groups_check",
      sql`((display_name_ciphertext_version IS NULL) AND (display_name_key_version IS NULL) AND (display_name_nonce IS NULL) AND (display_name_ciphertext IS NULL)) OR ((display_name_ciphertext_version IS NOT NULL) AND (display_name_key_version IS NOT NULL) AND (display_name_nonce IS NOT NULL) AND (display_name_ciphertext IS NOT NULL) AND (octet_length(display_name_ciphertext) > 16))`,
    ),
    check(
      "whatsapp_groups_name_prefix_indexes_check",
      sql`array_position(name_prefix_indexes, (NULL::text)::public.group_name_blind_index) IS NULL`,
    ),
    check(
      "whatsapp_groups_check1",
      sql`joined OR (cardinality(name_prefix_indexes) = 0)`,
    ),
  ],
);

export const whatsappGroupDirectoryStatesInApp = publicSchema.table(
  "whatsapp_group_directory_states",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    asOf: timestamp("as_of", { withTimezone: true, mode: "string" }),
    stale: boolean().notNull(),
    partial: boolean().notNull(),
    reconciliationClaimId: uuid("reconciliation_claim_id"),
    reconciliationLeaseExpiresAt: timestamp("reconciliation_lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    snapshotObservedAt: timestamp("snapshot_observed_at", {
      withTimezone: true,
      mode: "string",
    }),
    retentionLimited: boolean("retention_limited").default(false).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "whatsapp_group_directory_stat_personal_account_id_whatsapp_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      name: "whatsapp_group_directory_states_pkey",
    }),
    pgPolicy("whatsapp_group_directory_states_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "whatsapp_group_directory_states_check",
      sql`(reconciliation_claim_id IS NULL) = (reconciliation_lease_expires_at IS NULL)`,
    ),
  ],
);

export const directoryContactProjectionsInApp = publicSchema.table(
  "directory_contact_projections",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    asOf: timestamp("as_of", { withTimezone: true, mode: "string" }).notNull(),
    stale: boolean().notNull(),
    partial: boolean().notNull(),
    snapshotObservedAt: timestamp("snapshot_observed_at", {
      withTimezone: true,
      mode: "string",
    }),
    reconciliationAttemptedAt: timestamp("reconciliation_attempted_at", {
      withTimezone: true,
      mode: "string",
    }),
    reconciliationClaimId: uuid("reconciliation_claim_id"),
    reconciliationLeaseExpiresAt: timestamp("reconciliation_lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    retentionLimited: boolean("retention_limited").default(false).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "directory_contact_projections_personal_account_id_whatsapp_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      name: "directory_contact_projections_pkey",
    }),
    pgPolicy("directory_contact_projections_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "directory_contact_projections_check",
      sql`((reconciliation_claim_id IS NULL) AND (reconciliation_lease_expires_at IS NULL)) OR ((reconciliation_claim_id IS NOT NULL) AND (reconciliation_lease_expires_at IS NOT NULL))`,
    ),
  ],
);

export const directoryContactsInApp = publicSchema.table(
  "directory_contacts",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    id: uuid().defaultRandom().notNull(),
    publicId: text("public_id").notNull(),
    providerIdentityIndex: directoryBlindIndex(
      "provider_identity_index",
    ).notNull(),
    providerIdentityCiphertextVersion: smallint(
      "provider_identity_ciphertext_version",
    ).notNull(),
    providerIdentityKeyVersion: integer(
      "provider_identity_key_version",
    ).notNull(),
    providerIdentityNonce: bytea("provider_identity_nonce").notNull(),
    providerIdentityCiphertext: bytea("provider_identity_ciphertext").notNull(),
    displayNameCiphertextVersion: smallint("display_name_ciphertext_version"),
    displayNameKeyVersion: integer("display_name_key_version"),
    displayNameNonce: bytea("display_name_nonce"),
    displayNameCiphertext: bytea("display_name_ciphertext"),
    displayNameSort: text("display_name_sort").notNull(),
    phoneCiphertextVersion: smallint("phone_ciphertext_version"),
    phoneKeyVersion: integer("phone_key_version"),
    phoneNonce: bytea("phone_nonce"),
    phoneCiphertext: bytea("phone_ciphertext"),
    namePrefixIndexes: directoryBlindIndex("name_prefix_indexes")
      .array()
      .default(["RAY"])
      .notNull(),
    phoneIndex: directoryBlindIndex("phone_index"),
    active: boolean().notNull(),
    providerOccurredAt: timestamp("provider_occurred_at", {
      withTimezone: true,
      mode: "string",
    }),
    providerVersion: text("provider_version"),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    webhookEventId: uuid("webhook_event_id"),
    webhookItemIdentity: text("webhook_item_identity"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    snapshotObservedAt: timestamp("snapshot_observed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("directory_contacts_active_order")
      .using(
        "btree",
        table.personalAccountId.asc().nullsLast().op("text_ops"),
        table.whatsappConnectionId.asc().nullsLast().op("uuid_ops"),
        table.displayNameSort.asc().nullsLast().op("uuid_ops"),
        table.publicId.asc().nullsLast().op("text_ops"),
      )
      .where(sql`active`),
    index("directory_contacts_name_prefixes")
      .using("gin", table.namePrefixIndexes.asc().nullsLast().op("array_ops"))
      .where(sql`active`),
    index("directory_contacts_phone")
      .using(
        "btree",
        table.personalAccountId.asc().nullsLast().op("text_ops"),
        table.whatsappConnectionId.asc().nullsLast().op("text_ops"),
        table.phoneIndex.asc().nullsLast().op("uuid_ops"),
      )
      .where(sql`(active AND (phone_index IS NOT NULL))`),
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "directory_contacts_personal_account_id_whatsapp_connection_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.personalAccountId,
        table.whatsappConnectionId,
        table.webhookEventId,
      ],
      foreignColumns: [
        webhookEventsInApp.id,
        webhookEventsInApp.personalAccountId,
        webhookEventsInApp.whatsappConnectionId,
      ],
      name: "directory_contacts_personal_account_id_whatsapp_connectio_fkey1",
    }).onDelete("set null"),
    primaryKey({
      columns: [table.id, table.personalAccountId, table.whatsappConnectionId],
      name: "directory_contacts_pkey",
    }),
    unique("directory_contacts_id_key").on(table.id),
    unique("directory_contacts_public_id_key").on(table.publicId),
    unique(
      "directory_contacts_personal_account_id_whatsapp_connection__key",
    ).on(
      table.personalAccountId,
      table.providerIdentityIndex,
      table.whatsappConnectionId,
    ),
    pgPolicy("directory_contacts_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "directory_contacts_public_id_check",
      sql`public_id ~ '^ctc_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "directory_contacts_provider_identity_ciphertext_version_check",
      sql`provider_identity_ciphertext_version = 1`,
    ),
    check(
      "directory_contacts_provider_identity_key_version_check",
      sql`provider_identity_key_version > 0`,
    ),
    check(
      "directory_contacts_provider_identity_nonce_check",
      sql`octet_length(provider_identity_nonce) = 12`,
    ),
    check(
      "directory_contacts_provider_identity_ciphertext_check",
      sql`octet_length(provider_identity_ciphertext) > 16`,
    ),
    check(
      "directory_contacts_display_name_sort_check",
      sql`octet_length(display_name_sort) <= 1024`,
    ),
    check(
      "directory_contacts_check",
      sql`((display_name_ciphertext IS NULL) AND (display_name_ciphertext_version IS NULL) AND (display_name_key_version IS NULL) AND (display_name_nonce IS NULL)) OR ((display_name_ciphertext IS NOT NULL) AND (display_name_ciphertext_version = 1) AND (display_name_key_version > 0) AND (octet_length(display_name_nonce) = 12) AND (octet_length(display_name_ciphertext) > 16))`,
    ),
    check(
      "directory_contacts_check1",
      sql`((phone_ciphertext IS NULL) AND (phone_ciphertext_version IS NULL) AND (phone_key_version IS NULL) AND (phone_nonce IS NULL)) OR ((phone_ciphertext IS NOT NULL) AND (phone_ciphertext_version = 1) AND (phone_key_version > 0) AND (octet_length(phone_nonce) = 12) AND (octet_length(phone_ciphertext) > 16))`,
    ),
    check(
      "directory_contacts_name_prefix_indexes_check",
      sql`array_position(name_prefix_indexes, (NULL::text)::public.directory_blind_index) IS NULL`,
    ),
    check(
      "directory_contacts_check2",
      sql`active OR ((display_name_ciphertext IS NULL) AND (display_name_sort = ''::text) AND (phone_ciphertext IS NULL) AND (cardinality(name_prefix_indexes) = 0) AND (phone_index IS NULL))`,
    ),
    check(
      "directory_contacts_provider_version_check",
      sql`(provider_version IS NULL) OR (octet_length(provider_version) <= 512)`,
    ),
    check(
      "directory_contacts_webhook_item_identity_check",
      sql`(webhook_item_identity IS NULL) OR (webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'::text)`,
    ),
  ],
);
