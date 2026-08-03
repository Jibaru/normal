import { sql } from "drizzle-orm";
import {
  bigint,
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
import { app, bytea } from "./common";
import { whatsappConnectionsInApp } from "./connections";
import { webhookEventsInApp } from "./webhooks";

export const whatsappConversationsInApp = app.table(
  "whatsapp_conversations",
  {
    id: uuid().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    publicId: text("public_id").notNull(),
    kind: text().notNull(),
    recipientLocator: text("recipient_locator").notNull(),
    recipientPublicId: text("recipient_public_id").notNull(),
    lastActivityAt: timestamp("last_activity_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    lastActivityDirection: text("last_activity_direction").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    index("whatsapp_conversations_activity_order").using(
      "btree",
      table.personalAccountId.asc().nullsLast().op("text_ops"),
      table.whatsappConnectionId.asc().nullsLast().op("uuid_ops"),
      table.lastActivityAt.desc().nullsFirst().op("text_ops"),
      table.publicId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "whatsapp_conversations_personal_account_id_whatsapp_connec_fkey",
    }).onDelete("cascade"),
    unique("whatsapp_conversations_public_id_key").on(table.publicId),
    unique(
      "whatsapp_conversations_personal_account_id_whatsapp_connect_key",
    ).on(
      table.personalAccountId,
      table.recipientLocator,
      table.whatsappConnectionId,
    ),
    unique(
      "whatsapp_conversations_personal_account_id_whatsapp_connec_key1",
    ).on(table.id, table.personalAccountId, table.whatsappConnectionId),
    pgPolicy("whatsapp_conversations_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "whatsapp_conversations_public_id_check",
      sql`public_id ~ '^cvs_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "whatsapp_conversations_kind_check",
      sql`kind = ANY (ARRAY['direct'::text, 'group'::text])`,
    ),
    check(
      "whatsapp_conversations_recipient_locator_check",
      sql`recipient_locator ~ '^(wi1|di1)_[A-Za-z0-9_-]{43}$'::text`,
    ),
    check(
      "whatsapp_conversations_recipient_public_id_check",
      sql`recipient_public_id ~ '^(ctc|grp)_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "whatsapp_conversations_last_activity_direction_check",
      sql`last_activity_direction = ANY (ARRAY['inbound'::text, 'outbound'::text])`,
    ),
  ],
);

export const storedMessagesInApp = app.table(
  "stored_messages",
  {
    id: uuid().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    publicId: text("public_id").notNull(),
    messageIdentity: text("message_identity").notNull(),
    direction: text().notNull(),
    sentAt: timestamp("sent_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    contentType: text("content_type"),
    contentCiphertextVersion: smallint("content_ciphertext_version"),
    contentKeyVersion: integer("content_key_version"),
    contentNonce: bytea("content_nonce"),
    contentCiphertext: bytea("content_ciphertext"),
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
    editedAt: timestamp("edited_at", { withTimezone: true, mode: "string" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
    contentExpiredAt: timestamp("content_expired_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("stored_messages_chronological_read").using(
      "btree",
      table.personalAccountId.asc().nullsLast().op("timestamptz_ops"),
      table.whatsappConnectionId.asc().nullsLast().op("timestamptz_ops"),
      table.conversationId.asc().nullsLast().op("timestamptz_ops"),
      table.sentAt.desc().nullsFirst().op("text_ops"),
      table.publicId.desc().nullsFirst().op("text_ops"),
    ),
    foreignKey({
      columns: [
        table.personalAccountId,
        table.whatsappConnectionId,
        table.conversationId,
      ],
      foreignColumns: [
        whatsappConversationsInApp.id,
        whatsappConversationsInApp.personalAccountId,
        whatsappConversationsInApp.whatsappConnectionId,
      ],
      name: "stored_messages_personal_account_id_whatsapp_connection_id_fkey",
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
      name: "stored_messages_personal_account_id_whatsapp_connection_i_fkey1",
    }).onDelete("set null"),
    unique("stored_messages_public_id_key").on(table.publicId),
    unique(
      "stored_messages_personal_account_id_whatsapp_connection_id__key",
    ).on(
      table.messageIdentity,
      table.personalAccountId,
      table.whatsappConnectionId,
    ),
    unique("stored_messages_tenant_identity").on(
      table.id,
      table.personalAccountId,
      table.whatsappConnectionId,
    ),
    pgPolicy("stored_messages_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "stored_messages_public_id_check",
      sql`public_id ~ '^msg_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "stored_messages_message_identity_check",
      sql`message_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'::text`,
    ),
    check(
      "stored_messages_direction_check",
      sql`direction = ANY (ARRAY['inbound'::text, 'outbound'::text])`,
    ),
    check(
      "stored_messages_content_type_check",
      sql`content_type = ANY (ARRAY['audio'::text, 'document'::text, 'image'::text, 'sticker'::text, 'text'::text, 'unknown'::text, 'video'::text])`,
    ),
    check(
      "stored_messages_content_ciphertext_version_check",
      sql`content_ciphertext_version = 1`,
    ),
    check(
      "stored_messages_content_key_version_check",
      sql`content_key_version > 0`,
    ),
    check(
      "stored_messages_content_nonce_check",
      sql`octet_length(content_nonce) = 12`,
    ),
    check(
      "stored_messages_content_ciphertext_check",
      sql`octet_length(content_ciphertext) > 16`,
    ),
    check(
      "stored_messages_webhook_item_identity_check",
      sql`webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'::text`,
    ),
    check(
      "stored_messages_provider_version_check",
      sql`(provider_version IS NULL) OR (octet_length(provider_version) <= 512)`,
    ),
    check(
      "stored_messages_content_lifecycle",
      sql`((deleted_at IS NULL) AND (content_expired_at IS NULL) AND (content_type IS NOT NULL) AND (content_ciphertext_version IS NOT NULL) AND (content_key_version IS NOT NULL) AND (content_nonce IS NOT NULL) AND (content_ciphertext IS NOT NULL)) OR (((deleted_at IS NOT NULL) OR (content_expired_at IS NOT NULL)) AND (content_type IS NULL) AND (content_ciphertext_version IS NULL) AND (content_key_version IS NULL) AND (content_nonce IS NULL) AND (content_ciphertext IS NULL))`,
    ),
  ],
);

export const storedMediaInApp = app.table(
  "stored_media",
  {
    id: uuid().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    storedMessageId: uuid("stored_message_id").notNull(),
    publicId: text("public_id").notNull(),
    state: text().notNull(),
    mediaType: text("media_type").notNull(),
    sourceCiphertextVersion: smallint("source_ciphertext_version"),
    sourceKeyVersion: integer("source_key_version"),
    sourceNonce: bytea("source_nonce"),
    sourceCiphertext: bytea("source_ciphertext"),
    objectKey: text("object_key"),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    plaintextSizeBytes: bigint("plaintext_size_bytes", { mode: "number" }),
    sha256: text(),
    metadataCiphertextVersion: smallint("metadata_ciphertext_version"),
    metadataKeyVersion: integer("metadata_key_version"),
    metadataNonce: bytea("metadata_nonce"),
    metadataCiphertext: bytea("metadata_ciphertext"),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    index("stored_media_pending")
      .using(
        "btree",
        table.createdAt.asc().nullsLast().op("uuid_ops"),
        table.id.asc().nullsLast().op("timestamptz_ops"),
      )
      .where(sql`(state = 'pending'::text)`),
    foreignKey({
      columns: [
        table.personalAccountId,
        table.whatsappConnectionId,
        table.storedMessageId,
      ],
      foreignColumns: [
        storedMessagesInApp.id,
        storedMessagesInApp.personalAccountId,
        storedMessagesInApp.whatsappConnectionId,
      ],
      name: "stored_media_personal_account_id_whatsapp_connection_id_st_fkey",
    }).onDelete("cascade"),
    unique("stored_media_public_id_key").on(table.publicId),
    unique("stored_media_object_key_key").on(table.objectKey),
    unique(
      "stored_media_personal_account_id_whatsapp_connection_id_sto_key",
    ).on(
      table.personalAccountId,
      table.storedMessageId,
      table.whatsappConnectionId,
    ),
    pgPolicy("stored_media_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "stored_media_metadata_ciphertext_version_check",
      sql`metadata_ciphertext_version = 1`,
    ),
    check(
      "stored_media_public_id_check",
      sql`public_id ~ '^med_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "stored_media_media_type_check",
      sql`media_type = ANY (ARRAY['audio'::text, 'document'::text, 'image'::text, 'sticker'::text, 'video'::text])`,
    ),
    check(
      "stored_media_source_ciphertext_version_check",
      sql`source_ciphertext_version = 1`,
    ),
    check("stored_media_source_key_version_check", sql`source_key_version > 0`),
    check(
      "stored_media_source_nonce_check",
      sql`octet_length(source_nonce) = 12`,
    ),
    check(
      "stored_media_plaintext_size_bytes_check",
      sql`plaintext_size_bytes >= 0`,
    ),
    check("stored_media_sha256_check", sql`sha256 ~ '^[a-f0-9]{64}$'::text`),
    check(
      "stored_media_metadata_key_version_check",
      sql`metadata_key_version > 0`,
    ),
    check(
      "stored_media_metadata_nonce_check",
      sql`octet_length(metadata_nonce) = 12`,
    ),
    check(
      "stored_media_failure_code_check",
      sql`failure_code = ANY (ARRAY['policy_rejected'::text, 'processing_failed'::text, 'object_missing'::text, 'quota_exceeded'::text])`,
    ),
    check(
      "stored_media_state_check",
      sql`state = ANY (ARRAY['pending'::text, 'ready'::text, 'purging'::text, 'rejected'::text, 'failed'::text])`,
    ),
    check(
      "stored_media_lifecycle_check",
      sql`((state = 'pending'::text) AND (source_ciphertext IS NOT NULL) AND (source_nonce IS NOT NULL) AND (source_key_version IS NOT NULL) AND (source_ciphertext_version IS NOT NULL) AND (object_key IS NULL) AND (plaintext_size_bytes IS NULL) AND (sha256 IS NULL) AND (metadata_ciphertext IS NULL) AND (failure_code IS NULL)) OR ((state = ANY (ARRAY['ready'::text, 'purging'::text])) AND (source_ciphertext IS NULL) AND (source_nonce IS NULL) AND (source_key_version IS NULL) AND (source_ciphertext_version IS NULL) AND (object_key IS NOT NULL) AND (plaintext_size_bytes IS NOT NULL) AND (sha256 IS NOT NULL) AND (metadata_ciphertext IS NOT NULL) AND (metadata_nonce IS NOT NULL) AND (metadata_key_version IS NOT NULL) AND (metadata_ciphertext_version IS NOT NULL) AND (failure_code IS NULL)) OR ((state = ANY (ARRAY['rejected'::text, 'failed'::text])) AND (source_ciphertext IS NULL) AND (source_nonce IS NULL) AND (source_key_version IS NULL) AND (source_ciphertext_version IS NULL) AND (object_key IS NULL) AND (plaintext_size_bytes IS NULL) AND (sha256 IS NULL) AND (metadata_ciphertext IS NULL) AND (metadata_nonce IS NULL) AND (metadata_key_version IS NULL) AND (metadata_ciphertext_version IS NULL) AND (failure_code IS NOT NULL))`,
    ),
  ],
);

export const storedMediaObjectDeletionsInApp = app.table(
  "stored_media_object_deletions",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    objectKey: text("object_key").notNull(),
    requestedAt: timestamp("requested_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.objectKey, table.personalAccountId],
      name: "stored_media_object_deletions_pkey",
    }),
    pgPolicy("stored_media_object_deletions_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
  ],
);
