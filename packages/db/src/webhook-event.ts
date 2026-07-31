import type { WhatsAppConnectionState } from "@whatsapp-mcp/domain/whatsapp-connection";
import type { Client as PgClient } from "pg";

export interface WebhookEventConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface WebhookEventConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: WebhookEventConnection) => Promise<Value>,
  ) => Promise<Value>;
}

interface AccountKeyEnvelope {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

interface ConnectionKeyEnvelope {
  readonly accountKeyVersion: number;
  readonly ciphertext: string;
  readonly connectionId: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

interface VersionedCiphertext {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
}

export interface WebhookEventProcessingMaterial {
  readonly accountKey: AccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly identityKey: VersionedCiphertext;
}

export interface PrepareWebhookEventInput {
  readonly ciphertextSha256: string;
  readonly eventId: string;
  readonly payloadBytes: number;
  readonly personalAccountId: string;
  readonly receivedAt: string;
  readonly whatsappConnectionId: string;
}

export interface DeadLetterWebhookEventInput extends PrepareWebhookEventInput {
  readonly deadLetteredAt: string;
}

export type DeadLetterWebhookEventOutcome =
  | "already_completed"
  | "gap_recorded"
  | "source_unavailable";

export interface DeadLetterWebhookEventResult {
  readonly incidentReference: string | null;
  readonly outcome: DeadLetterWebhookEventOutcome;
}

export type WebhookItemQuarantineClassification =
  | "invalid_item_shape"
  | "invalid_top_level_shape"
  | "missing_required_identity"
  | "unsupported_item_kind"
  | "unsupported_projection";

export type WebhookItemProjectionOutcome =
  | "applied"
  | "duplicate"
  | "superseded";

export type WebhookVersionComparison =
  | "after"
  | "before"
  | "equal"
  | "incomparable";

interface WebhookItemBase {
  readonly eventId: string;
  readonly itemIndex: number;
  readonly personalAccountId: string;
  readonly receivedAt: string;
  readonly whatsappConnectionId: string;
}

export interface ProjectConnectionStateInput extends WebhookItemBase {
  readonly evidence: {
    readonly occurredAt: string | null;
    readonly version: string | null;
  };
  readonly itemIdentity: string;
  readonly state: Exclude<WhatsAppConnectionState, "deleting">;
}

export interface QuarantineWebhookItemInput extends WebhookItemBase {
  readonly classification: WebhookItemQuarantineClassification;
  readonly itemIdentity: string | null;
  readonly itemKind: string;
}

export interface WebhookEventRepository {
  readonly complete: (input: {
    readonly completedAt: string;
    readonly eventId: string;
    readonly personalAccountId: string;
    readonly whatsappConnectionId: string;
  }) => Promise<void>;
  readonly deadLetter: (
    input: DeadLetterWebhookEventInput,
  ) => Promise<DeadLetterWebhookEventResult>;
  readonly filterUnclaimed: <Input extends PrepareWebhookEventInput>(
    inputs: ReadonlyArray<Input>,
  ) => Promise<ReadonlyArray<Input>>;
  readonly prepare: (
    input: PrepareWebhookEventInput,
  ) => Promise<WebhookEventProcessingMaterial | null>;
  readonly projectConnectionState: (
    input: ProjectConnectionStateInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly quarantine: (input: QuarantineWebhookItemInput) => Promise<void>;
}

const withTransaction = async <Value>(
  connection: WebhookEventConnection,
  use: () => Promise<Value>,
): Promise<Value> => {
  await connection.query("BEGIN");
  try {
    const value = await use();
    await connection.query("COMMIT");
    return value;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
};

const enterPersonalAccountContext = async (
  connection: WebhookEventConnection,
  personalAccountId: string,
): Promise<void> => {
  await connection.query(
    "SELECT set_config('app.personal_account_id', $1, true)",
    [personalAccountId],
  );
};

const positiveInteger = (value: unknown): number | null => {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : value;
  return typeof parsed === "number" &&
    Number.isSafeInteger(parsed) &&
    parsed > 0
    ? parsed
    : null;
};

const bytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  return null;
};

const encodeBase64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const timestamp = (value: unknown): string | null => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return date !== null && Number.isFinite(date.valueOf())
    ? date.toISOString()
    : null;
};

interface MaterialRow extends Record<string, unknown> {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly account_kms_key_id: unknown;
  readonly connection_key_account_version: unknown;
  readonly connection_key_ciphertext: unknown;
  readonly connection_key_nonce: unknown;
  readonly connection_key_version: unknown;
  readonly identity_ciphertext: unknown;
  readonly identity_ciphertext_version: unknown;
  readonly identity_key_version: unknown;
  readonly identity_nonce: unknown;
}

const processingMaterial = (
  input: Pick<
    PrepareWebhookEventInput,
    "personalAccountId" | "whatsappConnectionId"
  >,
  row: MaterialRow | undefined,
): WebhookEventProcessingMaterial | null => {
  if (row === undefined) return null;
  const accountKeyCiphertext = bytes(row.account_key_ciphertext);
  const accountKeyVersion = positiveInteger(row.account_key_version);
  const connectionKeyAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const connectionKeyCiphertext = bytes(row.connection_key_ciphertext);
  const connectionKeyNonce = bytes(row.connection_key_nonce);
  const connectionKeyVersion = positiveInteger(row.connection_key_version);
  const identityCiphertext = bytes(row.identity_ciphertext);
  const identityCiphertextVersion = positiveInteger(
    row.identity_ciphertext_version,
  );
  const identityKeyVersion = positiveInteger(row.identity_key_version);
  const identityNonce = bytes(row.identity_nonce);
  if (
    typeof row.account_kms_key_id !== "string" ||
    row.account_kms_key_id.length === 0 ||
    accountKeyCiphertext === null ||
    accountKeyVersion === null ||
    connectionKeyAccountVersion === null ||
    connectionKeyCiphertext === null ||
    connectionKeyNonce === null ||
    connectionKeyVersion === null ||
    identityCiphertextVersion !== 1 ||
    identityKeyVersion === null ||
    identityNonce === null ||
    identityCiphertext === null
  ) {
    throw new Error("invalid Webhook Event processing material");
  }
  return {
    accountKey: {
      ciphertext: encodeBase64(accountKeyCiphertext),
      keyVersion: accountKeyVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId: input.personalAccountId,
      version: 1,
    },
    connectionKey: {
      accountKeyVersion: connectionKeyAccountVersion,
      ciphertext: encodeBase64(connectionKeyCiphertext),
      connectionId: input.whatsappConnectionId,
      keyVersion: connectionKeyVersion,
      nonce: encodeBase64(connectionKeyNonce),
      personalAccountId: input.personalAccountId,
      version: 1,
    },
    identityKey: {
      ciphertext: encodeBase64(identityCiphertext),
      keyVersion: identityKeyVersion,
      nonce: encodeBase64(identityNonce),
      version: 1,
    },
  };
};

interface EventRow extends Record<string, unknown> {
  readonly ciphertext_sha256: unknown;
  readonly payload_bytes: unknown;
  readonly received_at: unknown;
}

interface EventProcessingRow extends EventRow {
  readonly processing_completed_at: unknown;
}

interface RecoveryCandidateRow extends Record<string, unknown> {
  readonly candidate_index: unknown;
  readonly status: unknown;
}

const sameEvent = (
  input: PrepareWebhookEventInput,
  row: EventRow | undefined,
): boolean =>
  row !== undefined &&
  row.ciphertext_sha256 === input.ciphertextSha256 &&
  positiveInteger(row.payload_bytes) === input.payloadBytes &&
  timestamp(row.received_at) === input.receivedAt;

interface StateRow extends Record<string, unknown> {
  readonly state_provider_occurred_at: unknown;
  readonly state_provider_version: unknown;
  readonly state_received_at: unknown;
  readonly state_snapshot_observed_at: unknown;
  readonly state_webhook_event_id: unknown;
}

const shouldApply = async (
  input: ProjectConnectionStateInput,
  current: StateRow,
  compareVersions: (
    left: string,
    right: string,
  ) => Promise<WebhookVersionComparison>,
): Promise<boolean> => {
  const snapshotObservedAt = timestamp(current.state_snapshot_observed_at);
  const incomingOccurredAt =
    input.evidence.occurredAt === null
      ? null
      : timestamp(input.evidence.occurredAt);
  const incomingReceivedAt = timestamp(input.receivedAt);
  if (
    (input.evidence.occurredAt !== null && incomingOccurredAt === null) ||
    incomingReceivedAt === null
  ) {
    throw new Error("invalid incoming connection-state evidence order");
  }
  if (
    snapshotObservedAt !== null &&
    (incomingOccurredAt ?? incomingReceivedAt) <= snapshotObservedAt
  ) {
    return false;
  }

  const currentVersion = current.state_provider_version;
  if (currentVersion !== null && typeof currentVersion !== "string") {
    throw new Error("invalid current connection-state evidence");
  }
  const incomingVersion = input.evidence.version;
  if (incomingVersion !== null && currentVersion !== null) {
    const comparison = await compareVersions(incomingVersion, currentVersion);
    if (comparison === "after") return true;
    if (comparison === "before") return false;
    if (comparison === "incomparable") {
      throw new Error("incomparable connection-state evidence");
    }
  }

  const currentOccurredAt = timestamp(current.state_provider_occurred_at);
  if (
    incomingOccurredAt !== null &&
    currentOccurredAt !== null &&
    incomingOccurredAt !== currentOccurredAt
  ) {
    return incomingOccurredAt > currentOccurredAt;
  }

  const incomingHasProviderEvidence =
    incomingVersion !== null || incomingOccurredAt !== null;
  const currentHasProviderEvidence =
    currentVersion !== null || currentOccurredAt !== null;
  if (incomingHasProviderEvidence !== currentHasProviderEvidence) {
    return incomingHasProviderEvidence;
  }

  const currentReceivedAt = timestamp(current.state_received_at);
  if (currentReceivedAt === null) {
    throw new Error("invalid current connection-state receive order");
  }
  if (incomingReceivedAt !== currentReceivedAt) {
    return incomingReceivedAt > currentReceivedAt;
  }
  const currentEventId = current.state_webhook_event_id;
  return typeof currentEventId !== "string" || input.eventId > currentEventId;
};

export const makeWebhookEventRepository = (
  provider: WebhookEventConnectionProvider,
): WebhookEventRepository => ({
  complete: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterPersonalAccountContext(connection, input.personalAccountId);
        const result = await connection.query(
          `UPDATE app.webhook_events
           SET
             processing_completed_at = coalesce(
               processing_completed_at,
               $4::timestamptz
             ),
             updated_at = greatest(updated_at, $4::timestamptz)
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2
             AND id = $3
           RETURNING id`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.eventId,
            input.completedAt,
          ],
        );
        if (result.rows.length !== 1) {
          throw new Error("Webhook Event completion target unavailable");
        }
        const resolved = await connection.query<{ resolved: unknown }>(
          `SELECT app_private.resolve_webhook_processing_gap($1, $2, $3)
             AS resolved`,
          [input.personalAccountId, input.whatsappConnectionId, input.eventId],
        );
        if (resolved.rows[0]?.resolved !== true) {
          throw new Error("failed to resolve Webhook Event processing gap");
        }
      }),
    ),

  deadLetter: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterPersonalAccountContext(connection, input.personalAccountId);
        const active = await connection.query(
          `SELECT connections.id
           FROM app.whatsapp_connections AS connections
           JOIN app.personal_accounts AS accounts
             ON accounts.id = connections.personal_account_id
           WHERE connections.personal_account_id = $1
             AND connections.id = $2
             AND connections.state <> 'deleting'
             AND accounts.state = 'active'`,
          [input.personalAccountId, input.whatsappConnectionId],
        );
        if (active.rows.length === 0) {
          return {
            incidentReference: null,
            outcome: "source_unavailable" as const,
          };
        }

        await connection.query(
          `INSERT INTO app.webhook_events (
             personal_account_id,
             whatsapp_connection_id,
             id,
             ciphertext_sha256,
             payload_bytes,
             received_at,
             source_expires_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '7 days')
           ON CONFLICT (personal_account_id, whatsapp_connection_id, id)
           DO NOTHING`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.eventId,
            input.ciphertextSha256,
            input.payloadBytes,
            input.receivedAt,
          ],
        );
        const persisted = await connection.query<EventProcessingRow>(
          `SELECT
             ciphertext_sha256,
             payload_bytes,
             processing_completed_at,
             received_at
           FROM app.webhook_events
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2
             AND id = $3
           FOR UPDATE`,
          [input.personalAccountId, input.whatsappConnectionId, input.eventId],
        );
        const event = persisted.rows[0];
        if (!sameEvent(input, event)) {
          throw new Error("conflicting dead-letter Webhook Event");
        }
        if (event?.processing_completed_at !== null) {
          return {
            incidentReference: null,
            outcome: "already_completed" as const,
          };
        }

        await connection.query(
          `UPDATE app.webhook_events
           SET
             dead_lettered_at = coalesce(dead_lettered_at, $4::timestamptz),
             updated_at = greatest(updated_at, $4::timestamptz)
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2
             AND id = $3`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.eventId,
            input.deadLetteredAt,
          ],
        );
        const recorded = await connection.query<{ recorded: unknown }>(
          `SELECT app_private.record_webhook_dead_letter_gap(
             $1, $2, $3, $4
           ) AS recorded`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.eventId,
            input.deadLetteredAt,
          ],
        );
        if (recorded.rows[0]?.recorded !== true) {
          throw new Error("failed to record dead-letter Ingestion Gap");
        }
        const incident = await connection.query<{
          incident_reference: unknown;
        }>(
          `INSERT INTO app.webhook_dead_letter_incidents (
             personal_account_id,
             whatsapp_connection_id,
             webhook_event_id,
             detected_at,
             source_expires_at
           )
           SELECT
             events.personal_account_id,
             events.whatsapp_connection_id,
             events.id,
             $4::timestamptz,
             events.source_expires_at
           FROM app.webhook_events AS events
           WHERE events.personal_account_id = $1
             AND events.whatsapp_connection_id = $2
             AND events.id = $3
           ON CONFLICT (webhook_event_id) DO NOTHING
           RETURNING id AS incident_reference`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.eventId,
            input.deadLetteredAt,
          ],
        );
        const existingIncident =
          incident.rows[0] ??
          (
            await connection.query<{ incident_reference: unknown }>(
              `SELECT id AS incident_reference
               FROM app.webhook_dead_letter_incidents
               WHERE personal_account_id = $1
                 AND whatsapp_connection_id = $2
                 AND webhook_event_id = $3`,
              [
                input.personalAccountId,
                input.whatsappConnectionId,
                input.eventId,
              ],
            )
          ).rows[0];
        const incidentReference = existingIncident?.incident_reference;
        if (typeof incidentReference !== "string") {
          throw new Error("failed to create Webhook Event incident reference");
        }
        return {
          incidentReference,
          outcome: "gap_recorded" as const,
        };
      }),
    ),

  filterUnclaimed: <Input extends PrepareWebhookEventInput>(
    inputs: ReadonlyArray<Input>,
  ) =>
    provider.withConnection(async (connection) => {
      if (inputs.length === 0) return [];
      const candidates = inputs.map((input, candidateIndex) => ({
        candidate_index: candidateIndex + 1,
        ciphertext_sha256: input.ciphertextSha256,
        event_id: input.eventId,
        payload_bytes: input.payloadBytes,
        personal_account_id: input.personalAccountId,
        received_at: input.receivedAt,
        whatsapp_connection_id: input.whatsappConnectionId,
      }));
      const classified = await connection.query<RecoveryCandidateRow>(
        `SELECT candidate_index, status
         FROM app_private.classify_webhook_recovery_candidates($1::jsonb)`,
        [JSON.stringify(candidates)],
      );
      if (classified.rows.length !== inputs.length) {
        throw new Error("incomplete Webhook Event recovery classification");
      }
      const unclaimed: Input[] = [];
      for (const row of classified.rows) {
        const candidateIndex = positiveInteger(row.candidate_index);
        const input =
          candidateIndex === null ? undefined : inputs[candidateIndex - 1];
        if (
          input === undefined ||
          (row.status !== "claimed" &&
            row.status !== "conflict" &&
            row.status !== "source_unavailable" &&
            row.status !== "unclaimed")
        ) {
          throw new Error("invalid Webhook Event recovery classification");
        }
        if (row.status === "conflict") {
          throw new Error("conflicting Webhook Event recovery candidate");
        }
        if (row.status === "unclaimed") unclaimed.push(input);
      }
      return unclaimed;
    }),

  prepare: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const loaded = await connection.query<MaterialRow>(
          `SELECT *
           FROM app_private.load_webhook_event_processing_material($1, $2)`,
          [input.personalAccountId, input.whatsappConnectionId],
        );
        const material = processingMaterial(input, loaded.rows[0]);
        if (material === null) return null;

        await enterPersonalAccountContext(connection, input.personalAccountId);
        await connection.query(
          `INSERT INTO app.webhook_events (
             personal_account_id,
             whatsapp_connection_id,
             id,
             ciphertext_sha256,
             payload_bytes,
             received_at,
             source_expires_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '7 days')
           ON CONFLICT (personal_account_id, whatsapp_connection_id, id)
           DO NOTHING`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.eventId,
            input.ciphertextSha256,
            input.payloadBytes,
            input.receivedAt,
          ],
        );
        const persisted = await connection.query<EventRow>(
          `SELECT ciphertext_sha256, payload_bytes, received_at
           FROM app.webhook_events
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2
             AND id = $3`,
          [input.personalAccountId, input.whatsappConnectionId, input.eventId],
        );
        if (!sameEvent(input, persisted.rows[0])) {
          throw new Error("conflicting Webhook Event replay");
        }
        return material;
      }),
    ),

  projectConnectionState: (input, compareVersions) => {
    return provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterPersonalAccountContext(connection, input.personalAccountId);
        const currentResult = await connection.query<StateRow>(
          `SELECT
             state_provider_occurred_at,
             state_provider_version,
             state_received_at,
             state_snapshot_observed_at,
             state_webhook_event_id
           FROM app.whatsapp_connections
           WHERE personal_account_id = $1
             AND id = $2
             AND state <> 'deleting'
             AND EXISTS (
               SELECT 1
               FROM app.webhook_events AS events
               WHERE events.personal_account_id = $1
                 AND events.whatsapp_connection_id = $2
                 AND events.id = $3
             )
           FOR UPDATE`,
          [input.personalAccountId, input.whatsappConnectionId, input.eventId],
        );
        const current = currentResult.rows[0];
        if (current === undefined) {
          throw new Error("connection-state projection target unavailable");
        }
        const claimed = await connection.query(
          `INSERT INTO app.webhook_items (
             personal_account_id,
             whatsapp_connection_id,
             deduplication_identity,
             first_webhook_event_id,
             item_index,
             item_kind,
             outcome,
             provider_occurred_at,
             provider_version,
             received_at
           )
           VALUES ($1, $2, $3, $4, $5, 'connection_state', 'superseded', $6, $7, $8)
           ON CONFLICT (
             personal_account_id,
             whatsapp_connection_id,
             deduplication_identity
           ) DO NOTHING
           RETURNING deduplication_identity`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.itemIdentity,
            input.eventId,
            input.itemIndex,
            input.evidence.occurredAt,
            input.evidence.version,
            input.receivedAt,
          ],
        );
        if (claimed.rows.length === 0) return "duplicate" as const;

        const apply = await shouldApply(input, current, compareVersions);
        if (!apply) return "superseded" as const;

        await connection.query(
          `UPDATE app.whatsapp_connections
           SET
             state = $3,
             state_changed_at = CASE
               WHEN state = $3 THEN state_changed_at
               ELSE coalesce($4::timestamptz, $5::timestamptz)
             END,
             state_provider_occurred_at = $4,
             state_provider_version = $6,
             state_received_at = $5,
             state_webhook_event_id = $7,
             state_webhook_item_identity = $8,
             updated_at = greatest(updated_at, $5::timestamptz)
           WHERE personal_account_id = $1
             AND id = $2`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.state,
            input.evidence.occurredAt,
            input.receivedAt,
            input.evidence.version,
            input.eventId,
            input.itemIdentity,
          ],
        );
        await connection.query(
          `UPDATE app.webhook_items
           SET outcome = 'applied'
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2
             AND deduplication_identity = $3`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.itemIdentity,
          ],
        );
        return "applied" as const;
      }),
    );
  },

  quarantine: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterPersonalAccountContext(connection, input.personalAccountId);
        let claimed = true;
        if (input.itemIdentity !== null) {
          const claim = await connection.query(
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
             VALUES ($1, $2, $3, $4, $5, $6, 'quarantined', $7)
             ON CONFLICT (
               personal_account_id,
               whatsapp_connection_id,
               deduplication_identity
             ) DO NOTHING
             RETURNING deduplication_identity`,
            [
              input.personalAccountId,
              input.whatsappConnectionId,
              input.itemIdentity,
              input.eventId,
              input.itemIndex,
              input.itemKind,
              input.receivedAt,
            ],
          );
          claimed = claim.rows.length === 1;
        }
        if (!claimed) return;
        await connection.query(
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
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (
             personal_account_id,
             whatsapp_connection_id,
             webhook_event_id,
             item_index
           ) DO NOTHING`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.eventId,
            input.itemIndex,
            input.itemIdentity,
            input.itemKind,
            input.classification,
            input.receivedAt,
          ],
        );
      }),
    ),
});

const makePgConnectionProvider = (
  connectionString: string,
): WebhookEventConnectionProvider => ({
  withConnection: async <Value>(
    use: (connection: WebhookEventConnection) => Promise<Value>,
  ): Promise<Value> => {
    const { Client } = await import("pg");
    const client: PgClient = new Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
    });
    await client.connect();
    try {
      return await use({
        query: async (text, values) => {
          const result = await client.query(text, values);
          return { rows: result.rows };
        },
      });
    } finally {
      await client.end();
    }
  },
});

export const makePgWebhookEventRepository = (
  connectionString: string,
): WebhookEventRepository =>
  makeWebhookEventRepository(makePgConnectionProvider(connectionString));
