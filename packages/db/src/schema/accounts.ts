import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgPolicy,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, publicSchema } from "./common";

export const personalAccountsInApp = publicSchema.table(
  "personal_accounts",
  {
    id: uuid().primaryKey().notNull(),
    state: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    storedMediaLimitBytes: bigint("stored_media_limit_bytes", {
      mode: "number",
    })
      .default(sql`'5368709120'`)
      .notNull(),
    whatsappConnectionLimit: smallint("whatsapp_connection_limit")
      .default(3)
      .notNull(),
    messageRetentionDays: smallint("message_retention_days")
      .default(30)
      .notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    storedMediaUsedBytes: bigint("stored_media_used_bytes", { mode: "number" })
      .default(0)
      .notNull(),
    deletionRequestedAt: timestamp("deletion_requested_at", {
      withTimezone: true,
      mode: "string",
    }),
    deletionMarkerId: text("deletion_marker_id"),
  },
  (_table) => [
    pgPolicy("personal_accounts_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "personal_accounts_state_check",
      sql`state = ANY (ARRAY['active'::text, 'deleting'::text])`,
    ),
    check(
      "personal_accounts_stored_media_limit_bytes_check",
      sql`stored_media_limit_bytes = '5368709120'::bigint`,
    ),
    check(
      "personal_accounts_whatsapp_connection_limit_check",
      sql`whatsapp_connection_limit = 3`,
    ),
    check(
      "personal_accounts_message_retention_days_check",
      sql`message_retention_days > 0`,
    ),
    check(
      "personal_accounts_check",
      sql`(stored_media_used_bytes >= 0) AND (stored_media_used_bytes <= stored_media_limit_bytes)`,
    ),
    check(
      "personal_accounts_deletion_marker_id_check",
      sql`deletion_marker_id ~ '^[a-f0-9]{64}$'::text`,
    ),
    check(
      "personal_account_deletion_metadata_complete",
      sql`((deletion_requested_at IS NULL) AND (deletion_marker_id IS NULL)) OR ((state = 'deleting'::text) AND (deletion_requested_at IS NOT NULL) AND (deletion_marker_id IS NULL)) OR ((state = 'deleting'::text) AND (deletion_requested_at IS NOT NULL) AND (deletion_marker_id IS NOT NULL))`,
    ),
  ],
);

export const clerkIdentitiesInAppPrivate = publicSchema.table(
  "clerk_identities",
  {
    clerkUserId: text("clerk_user_id").primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "clerk_identities_personal_account_id_fkey",
    }).onDelete("cascade"),
    unique("clerk_identities_personal_account_id_key").on(
      table.personalAccountId,
    ),
  ],
);

export const personalAccountKeyEnvelopesInApp = publicSchema.table(
  "personal_account_key_envelopes",
  {
    personalAccountId: uuid("personal_account_id").primaryKey().notNull(),
    keyVersion: integer("key_version"),
    kmsKeyId: text("kms_key_id"),
    ciphertext: bytea("ciphertext"),
    unavailableAt: timestamp("unavailable_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "personal_account_key_envelopes_personal_account_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("personal_account_key_envelopes_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "personal_account_key_envelopes_key_version_check",
      sql`key_version > 0`,
    ),
    check(
      "personal_account_key_envelopes_kms_key_id_check",
      sql`kms_key_id <> ''::text`,
    ),
    check(
      "personal_account_key_envelopes_check",
      sql`((ciphertext IS NOT NULL) AND (key_version IS NOT NULL) AND (kms_key_id IS NOT NULL) AND (unavailable_at IS NULL)) OR ((ciphertext IS NULL) AND (unavailable_at IS NOT NULL))`,
    ),
  ],
);

export const privateBetaWaitlistInAppPrivate = publicSchema.table(
  "private_beta_waitlist",
  {
    clerkUserId: text("clerk_user_id").primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (_table) => [
    check(
      "private_beta_waitlist_clerk_user_id_check",
      sql`clerk_user_id ~ '^user_[A-Za-z0-9]{1,64}$'::text`,
    ),
  ],
);
