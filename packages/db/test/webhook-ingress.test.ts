import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  makeWebhookIngressRepository,
  type WebhookIngressConnectionProvider,
} from "../src/webhook-ingress";
import { createMigratedDatabase } from "./support/migrated-database";

const accountId = "10000000-0000-4000-8000-000000000032";
const connectionId = "20000000-0000-4000-8000-000000000032";
const ingressId = "30000000-0000-4000-8000-000000000032";

describe("Webhook Event ingress repository", () => {
  let database: PGlite;
  let provider: WebhookIngressConnectionProvider;

  beforeEach(async () => {
    database = await createMigratedDatabase();
    await database.query(
      `INSERT INTO public.personal_accounts (id, state)
       VALUES ($1, 'active')`,
      [accountId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
        id, personal_account_id, webhook_ingress_id, display_name_fallback
      )
      VALUES ($1, $2, $3, 'Bright Badger')`,
      [connectionId, accountId, ingressId],
    );
    await database.query(
      `INSERT INTO public.personal_account_key_envelopes (
        personal_account_id, key_version, kms_key_id, ciphertext
      )
      VALUES ($1, 1, 'kms-content-root', decode('0102', 'hex'))`,
      [accountId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_key_envelopes (
        personal_account_id,
        whatsapp_connection_id,
        account_key_version,
        key_version,
        nonce,
        ciphertext
      )
      VALUES (
        $1, $2, 1, 2,
        decode(repeat('03', 12), 'hex'),
        decode(repeat('04', 32), 'hex')
      )`,
      [accountId, connectionId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_provider_sessions (
        personal_account_id,
        whatsapp_connection_id,
        locator_ciphertext_version,
        locator_key_version,
        locator_nonce,
        locator_ciphertext,
        authority_ciphertext_version,
        authority_key_version,
        authority_nonce,
        authority_ciphertext,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2,
        1, 1, decode(repeat('05', 12), 'hex'), decode(repeat('06', 32), 'hex'),
        1, 2, decode(repeat('07', 12), 'hex'), decode(repeat('08', 32), 'hex'),
        transaction_timestamp(), transaction_timestamp()
      )`,
      [accountId, connectionId],
    );

    provider = {
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_webhook_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
  });

  afterEach(async () => {
    await database.close();
  });

  test("loads only connection-bound encrypted material through the ingress bootstrap", async () => {
    const repository = makeWebhookIngressRepository(provider);

    const [resolved, unknown] = await Promise.all([
      repository.resolve(ingressId),
      repository.resolve("30000000-0000-4000-8000-000000000099"),
    ]);

    expect(resolved).toEqual({
      accountKey: {
        ciphertext: "AQI=",
        keyVersion: 1,
        kmsKeyId: "kms-content-root",
        personalAccountId: accountId,
        version: 1,
      },
      connectionKey: {
        accountKeyVersion: 1,
        ciphertext: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
        connectionId,
        keyVersion: 2,
        nonce: "AwMDAwMDAwMDAwMD",
        personalAccountId: accountId,
        version: 1,
      },
      personalAccountId: accountId,
      providerAuthority: {
        ciphertext: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
        keyVersion: 2,
        nonce: "BwcHBwcHBwcHBwcH",
        version: 1,
      },
      whatsappConnectionId: connectionId,
    });
    expect(unknown).toBeNull();
  });

  test("rejects ingress material whose key versions cannot decrypt together", async () => {
    const repository = makeWebhookIngressRepository(provider);

    await database.query(
      `UPDATE public.personal_account_key_envelopes
       SET key_version = 2
       WHERE personal_account_id = $1`,
      [accountId],
    );
    expect(await repository.resolve(ingressId)).toBeNull();

    await database.query(
      `UPDATE public.personal_account_key_envelopes
       SET key_version = 1
       WHERE personal_account_id = $1`,
      [accountId],
    );
    await database.query(
      `UPDATE public.whatsapp_connection_provider_sessions
       SET authority_key_version = 3
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = $2`,
      [accountId, connectionId],
    );
    expect(await repository.resolve(ingressId)).toBeNull();
  });
});
