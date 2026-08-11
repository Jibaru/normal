import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/migrations";

const accountId = "10000000-0000-4000-8000-000000000070";
const connectionId = "20000000-0000-4000-8000-000000000070";
const connectionPublicId = "con_000000000000000000070";
const contactLocator = `di1_${"A".repeat(43)}`;
const contactPublicId = "ctc_000000000000000000070";

describe("WhatsApp Recipient Exclusion persistence", () => {
  let database: PGlite;

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
      `SELECT * FROM public.admit_personal_account_for_clerk(
        'user_exclusion70',$1,1,'arn:aws:kms:us-east-1:111122223333:key/content',decode('0102','hex'),3
      )`,
      [accountId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections(id,personal_account_id,webhook_ingress_id,public_id,
        number_suffix,state,state_changed_at,created_at)
       VALUES($1,$2,'30000000-0000-4000-8000-000000000070',$3,'0070','connected',
        '2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`,
      [connectionId, accountId, connectionPublicId],
    );
    await database.query(
      `INSERT INTO public.directory_contacts(personal_account_id,whatsapp_connection_id,id,public_id,
        provider_identity_index,provider_identity_ciphertext_version,provider_identity_key_version,
        provider_identity_nonce,provider_identity_ciphertext,display_name_sort,active,received_at)
       VALUES($1,$2,'50000000-0000-4000-8000-000000000070',$3,$4,1,1,
        decode('000102030405060708090a0b','hex'),decode('${"00".repeat(20)}','hex'),
        'ada',true,'2026-06-02T00:00:00Z')`,
      [accountId, connectionId, contactPublicId, contactLocator],
    );
  });

  afterEach(async () => database.close());

  test("prepares, finalizes, and reports an exclusion for the owning User", async () => {
    const prepared = await database.query<Record<string, unknown>>(
      `SELECT * FROM public.prepare_whatsapp_recipient_exclusion(
        'user_exclusion70',$1,$2,true,false,'idem-0123456789abcdef')`,
      [connectionPublicId, contactPublicId],
    );
    expect(prepared.rows[0]).toMatchObject({
      outcome: "prepared",
      recipient_kind: "contact",
      recipient_locator: contactLocator,
      recipient_excluded: true,
    });
    const transitionId = prepared.rows[0]?.transition_id;

    const finalized = await database.query<Record<string, unknown>>(
      `SELECT * FROM public.finalize_whatsapp_recipient_exclusion(
        'user_exclusion70',$1,$2,$3,'2026-08-11T00:00:00Z')`,
      [connectionPublicId, contactPublicId, transitionId],
    );
    expect(finalized.rows[0]).toMatchObject({ recipient_excluded: true });

    const listed = await database.query<Record<string, unknown>>(
      `SELECT recipient_public_id, recipient_excluded
       FROM public.list_whatsapp_recipient_directory(
         'user_exclusion70',$1,'contact',NULL,NULL,NULL,20)`,
      [connectionPublicId],
    );
    expect(listed.rows).toEqual([
      { recipient_public_id: contactPublicId, recipient_excluded: true },
    ]);
  });
});
