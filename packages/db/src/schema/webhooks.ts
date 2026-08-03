import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./common";
import { whatsappConnectionsInApp } from "./connections";

export const webhookEventsInApp = app.table(
  "webhook_events",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    id: uuid().notNull(),
    ciphertextSha256: text("ciphertext_sha256").notNull(),
    payloadBytes: integer("payload_bytes").notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    sourceExpiresAt: timestamp("source_expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    processingCompletedAt: timestamp("processing_completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    deadLetteredAt: timestamp("dead_lettered_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "webhook_events_personal_account_id_whatsapp_connection_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.id, table.personalAccountId, table.whatsappConnectionId],
      name: "webhook_events_pkey",
    }),
    unique("webhook_events_id_key").on(table.id),
    pgPolicy("webhook_events_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "webhook_events_ciphertext_sha256_check",
      sql`ciphertext_sha256 ~ '^[a-f0-9]{64}$'::text`,
    ),
    check(
      "webhook_events_payload_bytes_check",
      sql`(payload_bytes >= 1) AND (payload_bytes <= 1048576)`,
    ),
    check(
      "webhook_events_check",
      sql`source_expires_at = (received_at + '7 days'::interval)`,
    ),
    check(
      "webhook_events_check1",
      sql`(processing_completed_at IS NULL) OR (processing_completed_at >= received_at)`,
    ),
    check(
      "webhook_event_dead_letter_order",
      sql`(dead_lettered_at IS NULL) OR (dead_lettered_at >= received_at)`,
    ),
  ],
);

export const webhookItemsInApp = app.table(
  "webhook_items",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    deduplicationIdentity: text("deduplication_identity").notNull(),
    firstWebhookEventId: uuid("first_webhook_event_id"),
    itemIndex: integer("item_index").notNull(),
    itemKind: text("item_kind").notNull(),
    outcome: text().notNull(),
    providerOccurredAt: timestamp("provider_occurred_at", {
      withTimezone: true,
      mode: "string",
    }),
    providerVersion: text("provider_version"),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.personalAccountId,
        table.whatsappConnectionId,
        table.firstWebhookEventId,
      ],
      foreignColumns: [
        webhookEventsInApp.id,
        webhookEventsInApp.personalAccountId,
        webhookEventsInApp.whatsappConnectionId,
      ],
      name: "webhook_items_first_event",
    }).onDelete("set null"),
    primaryKey({
      columns: [
        table.deduplicationIdentity,
        table.personalAccountId,
        table.whatsappConnectionId,
      ],
      name: "webhook_items_pkey",
    }),
    pgPolicy("webhook_items_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "webhook_items_deduplication_identity_check",
      sql`deduplication_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'::text`,
    ),
    check("webhook_items_item_index_check", sql`item_index >= 0`),
    check(
      "webhook_items_item_kind_check",
      sql`item_kind ~ '^[a-z][a-z_]{0,63}$'::text`,
    ),
    check(
      "webhook_items_outcome_check",
      sql`outcome = ANY (ARRAY['applied'::text, 'quarantined'::text, 'superseded'::text])`,
    ),
    check(
      "webhook_items_provider_version_check",
      sql`(provider_version IS NULL) OR (octet_length(provider_version) <= 512)`,
    ),
  ],
);

export const webhookItemQuarantinesInApp = app.table(
  "webhook_item_quarantines",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    webhookEventId: uuid("webhook_event_id").notNull(),
    itemIndex: integer("item_index").notNull(),
    itemIdentity: text("item_identity"),
    itemKind: text("item_kind").notNull(),
    classification: text().notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
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
      name: "webhook_item_quarantines_personal_account_id_whatsapp_conn_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [
        table.itemIndex,
        table.personalAccountId,
        table.webhookEventId,
        table.whatsappConnectionId,
      ],
      name: "webhook_item_quarantines_pkey",
    }),
    pgPolicy("webhook_item_quarantines_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "webhook_item_quarantines_item_index_check",
      sql`item_index >= '-1'::integer`,
    ),
    check(
      "webhook_item_quarantines_item_kind_check",
      sql`item_kind ~ '^[a-z][a-z_]{0,63}$'::text`,
    ),
    check(
      "webhook_item_quarantines_classification_check",
      sql`classification = ANY (ARRAY['invalid_item_shape'::text, 'invalid_top_level_shape'::text, 'missing_required_identity'::text, 'unsupported_item_kind'::text, 'unsupported_projection'::text])`,
    ),
    check(
      "webhook_item_quarantines_item_identity_check",
      sql`(item_identity IS NULL) OR (item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'::text)`,
    ),
  ],
);

export const webhookDeadLetterIncidentsInApp = app.table(
  "webhook_dead_letter_incidents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    webhookEventId: uuid("webhook_event_id"),
    detectedAt: timestamp("detected_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    sourceExpiresAt: timestamp("source_expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "webhook_dead_letter_incidents_personal_account_id_whatsapp_fkey",
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
      name: "webhook_dead_letter_incident_personal_account_id_whatsapp_fkey1",
    }).onDelete("set null"),
    unique("webhook_dead_letter_incidents_webhook_event_id_key").on(
      table.webhookEventId,
    ),
    pgPolicy("webhook_dead_letter_incidents_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
  ],
);

export const webhookReplayAttemptsInApp = app.table(
  "webhook_replay_attempts",
  {
    id: uuid().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    incidentId: uuid("incident_id").notNull(),
    operatorReference: text("operator_reference").notNull(),
    reasonCode: text("reason_code").notNull(),
    requestedAt: timestamp("requested_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    status: text().notNull(),
    dispatchedAt: timestamp("dispatched_at", {
      withTimezone: true,
      mode: "string",
    }),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    index("webhook_replay_attempts_incident").using(
      "btree",
      table.incidentId.asc().nullsLast().op("uuid_ops"),
      table.requestedAt.asc().nullsLast().op("timestamptz_ops"),
      table.id.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.incidentId],
      foreignColumns: [webhookDeadLetterIncidentsInApp.id],
      name: "webhook_replay_attempts_incident_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "webhook_replay_attempts_personal_account_id_whatsapp_conne_fkey",
    }).onDelete("cascade"),
    pgPolicy("webhook_replay_attempts_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "webhook_replay_attempts_operator_reference_check",
      sql`operator_reference ~ '^[a-f0-9]{64}$'::text`,
    ),
    check(
      "webhook_replay_attempts_reason_code_check",
      sql`reason_code = ANY (ARRAY['dependency_recovered'::text, 'schema_support_deployed'::text, 'transient_incident_resolved'::text])`,
    ),
    check(
      "webhook_replay_attempts_status_check",
      sql`status = ANY (ARRAY['pending'::text, 'dispatched'::text, 'source_unavailable'::text])`,
    ),
    check(
      "webhook_replay_attempts_check",
      sql`expires_at = (requested_at + '90 days'::interval)`,
    ),
    check(
      "webhook_replay_attempts_check1",
      sql`((status = ANY (ARRAY['pending'::text, 'source_unavailable'::text])) AND (dispatched_at IS NULL)) OR ((status = 'dispatched'::text) AND (dispatched_at IS NOT NULL) AND (dispatched_at >= requested_at))`,
    ),
  ],
);

export const ingestionGapsInApp = app.table(
  "ingestion_gaps",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    id: uuid().defaultRandom().notNull(),
    cause: text().notNull(),
    historyWindowStartedAt: timestamp("history_window_started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    startsAt: timestamp("starts_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "string" }),
    detectedAt: timestamp("detected_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    evidenceWebhookEventId: uuid("evidence_webhook_event_id"),
  },
  (table) => [
    index("ingestion_gaps_connection_interval").using(
      "btree",
      table.personalAccountId.asc().nullsLast().op("uuid_ops"),
      table.whatsappConnectionId.asc().nullsLast().op("uuid_ops"),
      table.startsAt.asc().nullsLast().op("timestamptz_ops"),
      table.endsAt.asc().nullsLast().op("uuid_ops"),
    ),
    uniqueIndex("ingestion_gaps_one_active_cause")
      .using(
        "btree",
        table.personalAccountId.asc().nullsLast().op("uuid_ops"),
        table.whatsappConnectionId.asc().nullsLast().op("text_ops"),
        table.cause.asc().nullsLast().op("uuid_ops"),
      )
      .where(sql`(ends_at IS NULL)`),
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "ingestion_gaps_personal_account_id_whatsapp_connection_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.personalAccountId,
        table.whatsappConnectionId,
        table.evidenceWebhookEventId,
      ],
      foreignColumns: [
        webhookEventsInApp.id,
        webhookEventsInApp.personalAccountId,
        webhookEventsInApp.whatsappConnectionId,
      ],
      name: "ingestion_gaps_evidence_webhook_event",
    }).onDelete("set null"),
    primaryKey({
      columns: [table.id, table.personalAccountId, table.whatsappConnectionId],
      name: "ingestion_gaps_pkey",
    }),
    unique("ingestion_gaps_id_key").on(table.id),
    unique("ingestion_gaps_evidence_webhook_event_unique").on(
      table.evidenceWebhookEventId,
    ),
    pgPolicy("ingestion_gaps_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('app.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "ingestion_gaps_cause_check",
      sql`cause = ANY (ARRAY['connection_unavailable'::text, 'webhook_configuration'::text, 'ingress_failure'::text, 'processing_failure'::text, 'restore_loss'::text])`,
    ),
    check("ingestion_gaps_check", sql`starts_at >= history_window_started_at`),
    check(
      "ingestion_gaps_check1",
      sql`(ends_at IS NULL) OR (ends_at >= starts_at)`,
    ),
    check("ingestion_gaps_check2", sql`updated_at >= detected_at`),
  ],
);
