import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/migrations";
import {
  makeWebhookEventRepository,
  type WebhookEventConnectionProvider,
} from "../src/webhook-event";
import {
  makeWebhookReplayRepository,
  type WebhookReplayConnectionProvider,
} from "../src/webhook-replay";

const accountId = "10000000-0000-4000-8000-000000000035";
const connectionId = "20000000-0000-4000-8000-000000000035";
const eventId = "40000000-0000-4000-8000-000000000035";
const requestId = "60000000-0000-4000-8000-000000000035";
const receivedAt = "2026-07-31T12:10:00.000Z";

const eventInput = {
  ciphertextSha256: "a".repeat(64),
  eventId,
  payloadBytes: 128,
  personalAccountId: accountId,
  receivedAt,
  whatsappConnectionId: connectionId,
};

describe("Webhook Event replay and source retention repository", () => {
  let database: PGlite;
  let provider: WebhookEventConnectionProvider &
    WebhookReplayConnectionProvider;

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
      `INSERT INTO app.personal_accounts (id, state)
       VALUES ($1, 'active')`,
      [accountId],
    );
    await database.query(
      `INSERT INTO app.whatsapp_connections (
         id,
         personal_account_id,
         webhook_ingress_id,
         public_id,
         number_suffix,
         state,
         state_changed_at,
         created_at
       )
       VALUES ($1, $2, $3, $4, '0035', 'connecting', $5, $5)`,
      [
        connectionId,
        accountId,
        "30000000-0000-4000-8000-000000000035",
        "con_000000000000000000035",
        "2026-07-31T12:00:00.000Z",
      ],
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

  test("returns one opaque incident reference and audits immutable replay before dispatch", async () => {
    const events = makeWebhookEventRepository(provider);
    const replay = makeWebhookReplayRepository(provider);
    const deadLetter = await events.deadLetter({
      ...eventInput,
      deadLetteredAt: "2026-08-01T09:10:00.000Z",
    });

    expect(deadLetter.outcome).toBe("gap_recorded");
    expect(deadLetter.incidentReference).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    if (deadLetter.incidentReference === null) {
      throw new Error("missing incident reference");
    }
    const incidentReference = deadLetter.incidentReference;
    expect(
      await events.deadLetter({
        ...eventInput,
        deadLetteredAt: "2026-08-01T09:10:00.000Z",
      }),
    ).toEqual(deadLetter);

    const request = {
      incidentReference,
      observedAt: "2026-08-01T12:10:00.000Z",
      operatorReference: "b".repeat(64),
      reasonCode: "dependency_recovered" as const,
      requestId,
      requestedAt: "2026-08-01T12:10:00.000Z",
    };
    const prepared = await replay.prepare(request);
    expect(prepared).toEqual({
      message: {
        ciphertext_sha256: eventInput.ciphertextSha256,
        object_id: eventId,
        payload_bytes: eventInput.payloadBytes,
        personal_account_id: accountId,
        received_at: receivedAt,
        version: 1,
        whatsapp_connection_id: connectionId,
      },
      outcome: "pending",
    });

    const beforeDispatch = await database.query<{
      dispatched_at: Date | null;
      incident_reference: string;
      operator_reference: string;
      reason_code: string;
      status: string;
    }>(
      `SELECT
         attempts.dispatched_at,
         attempts.operator_reference,
         attempts.reason_code,
         attempts.status,
         incidents.id AS incident_reference
       FROM app.webhook_replay_attempts AS attempts
       JOIN app.webhook_dead_letter_incidents AS incidents
         ON incidents.id = attempts.incident_id`,
    );
    expect(beforeDispatch.rows).toEqual([
      {
        dispatched_at: null,
        incident_reference: incidentReference,
        operator_reference: "b".repeat(64),
        reason_code: "dependency_recovered",
        status: "pending",
      },
    ]);

    await replay.complete({
      dispatchedAt: "2026-08-01T12:10:01.000Z",
      requestId,
    });
    expect(await replay.prepare(request)).toMatchObject({
      outcome: "already_dispatched",
    });
    const dispatched = await database.query<{ dispatched_at: Date }>(
      "SELECT dispatched_at FROM app.webhook_replay_attempts",
    );
    expect(dispatched.rows).toEqual([
      { dispatched_at: new Date("2026-08-01T12:10:01.000Z") },
    ]);
  });

  test("rejects replay after source expiry and conflicting request-id reuse", async () => {
    const events = makeWebhookEventRepository(provider);
    const replay = makeWebhookReplayRepository(provider);
    const deadLetter = await events.deadLetter({
      ...eventInput,
      deadLetteredAt: "2026-08-01T09:10:00.000Z",
    });
    const base = {
      incidentReference: deadLetter.incidentReference ?? "",
      observedAt: "2026-08-01T12:10:00.000Z",
      operatorReference: "b".repeat(64),
      reasonCode: "dependency_recovered" as const,
      requestId,
      requestedAt: "2026-08-01T12:10:00.000Z",
    };
    await replay.prepare(base);
    await expect(
      replay.prepare({ ...base, reasonCode: "schema_support_deployed" }),
    ).rejects.toThrow("conflicting Webhook Event replay request");
    expect(
      await replay.prepare({
        ...base,
        observedAt: "2026-08-07T12:10:00.000Z",
        requestId: "60000000-0000-4000-8000-000000000036",
      }),
    ).toEqual({ outcome: "source_unavailable" });
    const unavailableAttempt = await database.query<{
      incident_id: string;
      status: string;
    }>(
      `SELECT incident_id, status
       FROM app.webhook_replay_attempts
       WHERE id = $1`,
      ["60000000-0000-4000-8000-000000000036"],
    );
    expect(unavailableAttempt.rows).toEqual([
      {
        incident_id: base.incidentReference,
        status: "source_unavailable",
      },
    ]);
  });

  test("closes the processing-failure gap only after normal replay processing completes", async () => {
    const events = makeWebhookEventRepository(provider);
    const deadLetter = await events.deadLetter({
      ...eventInput,
      deadLetteredAt: "2026-08-01T09:10:00.000Z",
    });
    expect(deadLetter.outcome).toBe("gap_recorded");

    const beforeCompletion = await database.query<{ ends_at: Date | null }>(
      `SELECT ends_at
       FROM app.ingestion_gaps
       WHERE evidence_webhook_event_id = $1`,
      [eventId],
    );
    expect(beforeCompletion.rows).toEqual([{ ends_at: null }]);

    await events.complete({
      completedAt: "2026-08-01T12:10:01.000Z",
      eventId,
      personalAccountId: accountId,
      whatsappConnectionId: connectionId,
    });

    const afterCompletion = await database.query<{ ends_at: Date | null }>(
      `SELECT ends_at
       FROM app.ingestion_gaps
       WHERE evidence_webhook_event_id = $1`,
      [eventId],
    );
    expect(afterCompletion.rows).toEqual([
      { ends_at: new Date("2026-08-01T12:10:01.000Z") },
    ]);
  });

  test("expires source and quarantine references while retaining non-reversible item fingerprints", async () => {
    const events = makeWebhookEventRepository(provider);
    const replay = makeWebhookReplayRepository(provider);
    const deadLetter = await events.deadLetter({
      ...eventInput,
      deadLetteredAt: "2026-08-01T09:10:00.000Z",
    });
    await database.query(
      `INSERT INTO app.webhook_items (
         personal_account_id,
         whatsapp_connection_id,
         deduplication_identity,
         first_webhook_event_id,
         item_index,
         item_kind,
         outcome,
         received_at
       )
       VALUES ($1, $2, $3, $4, 0, 'connection_state', 'quarantined', $5)`,
      [accountId, connectionId, `wi1_${"x".repeat(43)}`, eventId, receivedAt],
    );
    await database.query(
      `INSERT INTO app.webhook_item_quarantines (
         personal_account_id,
         whatsapp_connection_id,
         webhook_event_id,
         item_index,
         item_identity,
         item_kind,
         classification,
         received_at
       )
       VALUES ($1, $2, $3, 0, $4, 'connection_state', 'unsupported_projection', $5)`,
      [accountId, connectionId, eventId, `wi1_${"x".repeat(43)}`, receivedAt],
    );
    await database.query(
      `UPDATE app.whatsapp_connections
       SET
         state_webhook_event_id = $3,
         state_webhook_item_identity = $4
       WHERE personal_account_id = $1
         AND id = $2`,
      [accountId, connectionId, eventId, `wi1_${"x".repeat(43)}`],
    );

    expect(
      await replay.listExpiredSources({
        limit: 100,
        observedAt: "2026-08-07T12:09:59.999Z",
      }),
    ).toEqual([]);
    expect(
      await replay.listExpiredSources({
        limit: 100,
        observedAt: "2026-08-07T12:10:00.000Z",
      }),
    ).toEqual([eventId]);
    expect(
      await replay.finalizeExpiredSource({
        eventId,
        observedAt: "2026-08-07T12:10:00.000Z",
      }),
    ).toBe(true);

    const retained = await database.query<{
      event_count: number;
      first_webhook_event_id: string | null;
      incident_event_id: string | null;
      item_count: number;
      quarantine_count: number;
      state_webhook_event_id: string | null;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM app.webhook_events) AS event_count,
         (SELECT count(*)::integer FROM app.webhook_items) AS item_count,
         (SELECT first_webhook_event_id FROM app.webhook_items LIMIT 1)
           AS first_webhook_event_id,
         (SELECT count(*)::integer FROM app.webhook_item_quarantines)
           AS quarantine_count,
         (SELECT state_webhook_event_id FROM app.whatsapp_connections
          WHERE id = $2) AS state_webhook_event_id,
         (SELECT webhook_event_id FROM app.webhook_dead_letter_incidents
          WHERE id = $1) AS incident_event_id`,
      [deadLetter.incidentReference, connectionId],
    );
    expect(retained.rows).toEqual([
      {
        event_count: 0,
        first_webhook_event_id: null,
        incident_event_id: null,
        item_count: 1,
        quarantine_count: 0,
        state_webhook_event_id: null,
      },
    ]);

    const expiredReplayId = "60000000-0000-4000-8000-000000000037";
    expect(
      await replay.prepare({
        incidentReference: deadLetter.incidentReference ?? "",
        observedAt: "2026-08-07T12:10:01.000Z",
        operatorReference: "b".repeat(64),
        reasonCode: "dependency_recovered",
        requestId: expiredReplayId,
        requestedAt: "2026-08-07T12:10:01.000Z",
      }),
    ).toEqual({ outcome: "source_unavailable" });
    const expiredReplay = await database.query<{ status: string }>(
      `SELECT status
       FROM app.webhook_replay_attempts
       WHERE id = $1`,
      [expiredReplayId],
    );
    expect(expiredReplay.rows).toEqual([{ status: "source_unavailable" }]);
  });

  test("keeps replay and retention authority unavailable to the API runtime role", async () => {
    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      await expect(
        database.query("SELECT id FROM app.webhook_replay_attempts"),
      ).rejects.toThrow();
      await expect(
        database.query(
          "SELECT * FROM app_private.list_expired_webhook_sources(now(), 100)",
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }
  });
});
