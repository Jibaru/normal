import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { publicSchema } from "./common";
import { whatsappConnectionsInApp } from "./connections";

export const whatsappRecipientExclusionsInApp = publicSchema.table(
  "whatsapp_recipient_exclusions",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    recipientKind: text("recipient_kind").notNull(),
    recipientLocator: text("recipient_locator").notNull(),
    recipientPublicId: text("recipient_public_id").notNull(),
    excluded: boolean().notNull(),
    effectiveAt: timestamp("effective_at", {
      withTimezone: true,
      mode: "string",
    }),
    purgeCutoffAt: timestamp("purge_cutoff_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastTransitionId: uuid("last_transition_id"),
    transitionId: uuid("transition_id"),
    transitionExcluded: boolean("transition_excluded"),
    transitionEffectiveAt: timestamp("transition_effective_at", {
      withTimezone: true,
      mode: "string",
    }),
    transitionPurgeCutoffAt: timestamp("transition_purge_cutoff_at", {
      withTimezone: true,
      mode: "string",
    }),
    transitionIdempotencyKey: text("transition_idempotency_key"),
    transitionPreparedAt: timestamp("transition_prepared_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    index("whatsapp_recipient_exclusions_pending")
      .on(table.transitionPreparedAt, table.transitionId)
      .where(sql`transition_id IS NOT NULL`),
    index("whatsapp_recipient_exclusions_purge_cutoff")
      .on(
        table.personalAccountId,
        table.whatsappConnectionId,
        table.recipientLocator,
      )
      .where(sql`purge_cutoff_at IS NOT NULL`),
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.personalAccountId,
        whatsappConnectionsInApp.id,
      ],
      name: "whatsapp_recipient_exclusions_personal_account_id_whatsapp_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [
        table.personalAccountId,
        table.whatsappConnectionId,
        table.recipientKind,
        table.recipientLocator,
      ],
      name: "whatsapp_recipient_exclusions_pkey",
    }),
    unique("whatsapp_recipient_exclusions_recipient_public_id_key").on(
      table.personalAccountId,
      table.whatsappConnectionId,
      table.recipientPublicId,
    ),
    pgPolicy("whatsapp_recipient_exclusions_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "whatsapp_recipient_exclusions_recipient_kind_check",
      sql`recipient_kind IN ('contact', 'group')`,
    ),
    check(
      "whatsapp_recipient_exclusions_recipient_locator_check",
      sql`recipient_locator ~ '^(wi1|di1)_[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      "whatsapp_recipient_exclusions_recipient_public_id_check",
      sql`recipient_public_id ~ '^(ctc|grp)_[A-Za-z0-9_-]{21}$'`,
    ),
    check(
      "whatsapp_recipient_exclusions_idempotency_key_check",
      sql`transition_idempotency_key IS NULL OR transition_idempotency_key ~ '^[A-Za-z0-9._~-]{16,255}$'`,
    ),
    check(
      "whatsapp_recipient_exclusions_kind_alignment_check",
      sql`(recipient_kind = 'contact' AND recipient_locator LIKE 'di1|_%' ESCAPE '|' AND recipient_public_id LIKE 'ctc|_%' ESCAPE '|') OR (recipient_kind = 'group' AND recipient_locator LIKE 'wi1|_%' ESCAPE '|' AND recipient_public_id LIKE 'grp|_%' ESCAPE '|')`,
    ),
    check(
      "whatsapp_recipient_exclusions_effective_at_check",
      sql`NOT excluded OR effective_at IS NOT NULL`,
    ),
    check(
      "whatsapp_recipient_exclusions_purge_cutoff_check",
      sql`purge_cutoff_at IS NULL OR effective_at IS NOT NULL`,
    ),
    check(
      "whatsapp_recipient_exclusions_transition_check",
      sql`(transition_id IS NULL AND transition_excluded IS NULL AND transition_effective_at IS NULL AND transition_idempotency_key IS NULL AND transition_prepared_at IS NULL AND transition_purge_cutoff_at IS NULL) OR (transition_id IS NOT NULL AND transition_excluded IS NOT NULL AND transition_effective_at IS NOT NULL AND transition_idempotency_key IS NOT NULL AND transition_prepared_at IS NOT NULL)`,
    ),
  ],
);
