import type { WhatsAppConnectionState } from "@whatsapp-mcp/domain/whatsapp-connection";
import type { Client as PgClient } from "pg";
import type { ProtectedGroupFields } from "./group";

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

export interface PersistedDirectoryCiphertext extends VersionedCiphertext {}

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

interface EvidenceOrderedProjectionInput extends WebhookItemBase {
  readonly evidence: {
    readonly occurredAt: string | null;
    readonly version: string | null;
  };
  readonly itemIdentity: string;
}

export interface ProjectConnectionStateInput
  extends EvidenceOrderedProjectionInput {
  readonly state: Exclude<WhatsAppConnectionState, "deleting">;
}

export interface ProjectGroupInput extends WebhookItemBase {
  readonly displayName: string | null;
  readonly evidence: {
    readonly occurredAt: string | null;
    readonly version: string | null;
  };
  readonly groupId: string;
  readonly itemIdentity: string;
  readonly joined: boolean;
  readonly locator: string;
  readonly namePrefixIndexes: ReadonlyArray<string>;
  readonly providerIdentity: string;
  readonly publicId: string;
}

export interface ProjectDirectoryContactInput
  extends EvidenceOrderedProjectionInput {
  readonly active: boolean;
  readonly displayNameCiphertext: PersistedDirectoryCiphertext | null;
  readonly displayNameSort: string;
  readonly namePrefixIndexes: ReadonlyArray<string>;
  readonly phoneCiphertext: PersistedDirectoryCiphertext | null;
  readonly phoneIndex: string | null;
  readonly providerIdentityCiphertext: PersistedDirectoryCiphertext;
  readonly providerIdentityIndex: string;
  readonly publicId: string;
}

export interface ProjectStoredMessageInput
  extends EvidenceOrderedProjectionInput {
  readonly content: PersistedDirectoryCiphertext;
  readonly contentType:
    | "audio"
    | "document"
    | "image"
    | "sticker"
    | "text"
    | "unknown"
    | "video";
  readonly conversationId: string;
  readonly conversationPublicId: string;
  readonly direction: "inbound" | "outbound";
  readonly messageIdentity: string;
  readonly messageId: string;
  readonly messagePublicId: string;
  readonly recipientLocator: string;
  readonly recipientKind: "direct" | "group";
  readonly recipientPublicId: string;
  readonly sentAt: string;
}

export interface ProjectSendEvidenceInput
  extends EvidenceOrderedProjectionInput {
  readonly messageIdentity: string;
  readonly status: "accepted" | "sent" | "delivered" | "read" | "failed";
}

export interface ProjectStoredMessageEditInput
  extends EvidenceOrderedProjectionInput {
  readonly content: PersistedDirectoryCiphertext;
  readonly contentType: ProjectStoredMessageInput["contentType"];
  readonly editedAt: string;
  readonly messageIdentity: string;
}

export interface ProjectStoredMessageDeletionInput
  extends EvidenceOrderedProjectionInput {
  readonly conversationId: string;
  readonly conversationPublicId: string;
  readonly deletedAt: string;
  readonly direction: "inbound" | "outbound";
  readonly messageId: string;
  readonly messageIdentity: string;
  readonly messagePublicId: string;
  readonly recipientKind: "direct" | "group";
  readonly recipientLocator: string;
  readonly recipientPublicId: string;
  readonly sentAt: string;
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
  readonly projectGroup: (
    input: ProjectGroupInput,
    protect: (recordId: string) => Promise<ProtectedGroupFields>,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectDirectoryContact: (
    input: ProjectDirectoryContactInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectStoredMessage: (
    input: ProjectStoredMessageInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectSendEvidence: (
    input: ProjectSendEvidenceInput,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectStoredMessageEdit: (
    input: ProjectStoredMessageEditInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectStoredMessageDeletion: (
    input: ProjectStoredMessageDeletionInput,
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

interface ContactOrderRow extends Record<string, unknown> {
  readonly provider_occurred_at: unknown;
  readonly provider_version: unknown;
  readonly received_at: unknown;
  readonly snapshot_observed_at: unknown;
  readonly webhook_event_id: unknown;
}

const shouldApplyContact = async (
  input: ProjectDirectoryContactInput,
  current: ContactOrderRow,
  compareVersions: (
    left: string,
    right: string,
  ) => Promise<WebhookVersionComparison>,
): Promise<boolean> =>
  shouldApply(
    input,
    {
      state_provider_occurred_at: current.provider_occurred_at,
      state_provider_version: current.provider_version,
      state_received_at: current.received_at,
      state_snapshot_observed_at: current.snapshot_observed_at,
      state_webhook_event_id: current.webhook_event_id,
    },
    compareVersions,
  );

const decodeCiphertext = (value: PersistedDirectoryCiphertext): Uint8Array => {
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  const nonce = Buffer.from(value.nonce, "base64");
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.keyVersion) ||
    value.keyVersion < 1 ||
    ciphertext.byteLength <= 16 ||
    nonce.byteLength !== 12
  ) {
    throw new Error("invalid Directory ciphertext");
  }
  return new Uint8Array(ciphertext);
};

const decodeNonce = (value: PersistedDirectoryCiphertext): Uint8Array =>
  new Uint8Array(Buffer.from(value.nonce, "base64"));

const shouldApply = async (
  input: EvidenceOrderedProjectionInput,
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

interface GroupEvidenceRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly last_observed_at: unknown;
  readonly provider_occurred_at: unknown;
  readonly provider_version: unknown;
  readonly received_at: unknown;
}

const shouldApplyGroup = async (
  input: ProjectGroupInput,
  current: GroupEvidenceRow | undefined,
  compareVersions: (
    left: string,
    right: string,
  ) => Promise<WebhookVersionComparison>,
): Promise<boolean> => {
  if (current === undefined) return true;
  const lastObservedAt = timestamp(current.last_observed_at);
  const receivedAt = timestamp(input.receivedAt);
  const occurredAt =
    input.evidence.occurredAt === null
      ? null
      : timestamp(input.evidence.occurredAt);
  if (
    receivedAt === null ||
    (input.evidence.occurredAt !== null && occurredAt === null) ||
    lastObservedAt === null
  ) {
    throw new Error("invalid group projection evidence");
  }
  const currentVersion = current.provider_version;
  if (currentVersion !== null && typeof currentVersion !== "string") {
    throw new Error("invalid group provider version");
  }
  if (input.evidence.version !== null && currentVersion !== null) {
    const comparison = await compareVersions(
      input.evidence.version,
      currentVersion,
    );
    if (comparison === "after") return true;
    if (comparison === "before" || comparison === "equal") return false;
    throw new Error("incomparable group provider version");
  }
  const effective = occurredAt ?? receivedAt;
  return effective > lastObservedAt;
};

const protectedGroupValues = (value: ProtectedGroupFields) => {
  const valid = (field: NonNullable<ProtectedGroupFields["displayName"]>) =>
    field.version === 1 &&
    Number.isSafeInteger(field.keyVersion) &&
    field.keyVersion > 0 &&
    field.nonce.byteLength === 12 &&
    field.ciphertext.byteLength > 16;
  if (
    !valid(value.providerIdentity) ||
    (value.displayName !== null && !valid(value.displayName))
  ) {
    throw new Error("invalid protected group projection");
  }
  return [
    value.displayName?.version ?? null,
    value.displayName?.keyVersion ?? null,
    value.displayName?.nonce ?? null,
    value.displayName?.ciphertext ?? null,
    value.providerIdentity.version,
    value.providerIdentity.keyVersion,
    value.providerIdentity.nonce,
    value.providerIdentity.ciphertext,
  ] as const;
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

  projectSendEvidence: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterPersonalAccountContext(connection, input.personalAccountId);
        const claimed = await connection.query(
          `INSERT INTO app.webhook_items (personal_account_id, whatsapp_connection_id,
             deduplication_identity, first_webhook_event_id, item_index, item_kind,
             outcome, received_at)
           VALUES ($1,$2,$3,$4,$5,'send_evidence','superseded',$6)
           ON CONFLICT (personal_account_id, whatsapp_connection_id, deduplication_identity)
           DO NOTHING RETURNING deduplication_identity`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.itemIdentity,
            input.eventId,
            input.itemIndex,
            input.receivedAt,
          ],
        );
        if (claimed.rows.length === 0) return "duplicate" as const;
        const changedAt = input.evidence.occurredAt ?? input.receivedAt;
        const updated = await connection.query(
          `UPDATE app.send_operations SET status=$4,status_changed_at=$5
           WHERE personal_account_id=$1 AND whatsapp_connection_id=$2
             AND message_identity=$3 AND expires_at>$6
             AND (
               status='unknown'
               OR ($4='failed' AND status IN ('processing','accepted','sent'))
               OR ($4<>'failed' AND (
                 status='failed'
                 OR CASE $4 WHEN 'accepted' THEN 1 WHEN 'sent' THEN 2
                    WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 END >
                    CASE status WHEN 'processing' THEN 0 WHEN 'accepted' THEN 1
                    WHEN 'sent' THEN 2 WHEN 'delivered' THEN 3 WHEN 'read' THEN 4
                    ELSE 0 END
               ))
             ) RETURNING id`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.messageIdentity,
            input.status,
            changedAt,
            input.receivedAt,
          ],
        );
        const outcome = updated.rows.length === 1 ? "applied" : "superseded";
        await connection.query(
          `UPDATE app.webhook_items SET outcome=$4
           WHERE personal_account_id=$1 AND whatsapp_connection_id=$2
             AND deduplication_identity=$3`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.itemIdentity,
            outcome,
          ],
        );
        return outcome;
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

  projectGroup: (input, protect, compareVersions) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          input.namePrefixIndexes.length > 62 ||
          input.namePrefixIndexes.some(
            (index) => !/^gi1_[A-Za-z0-9_-]{43}$/u.test(index),
          ) ||
          new Set(input.namePrefixIndexes).size !==
            input.namePrefixIndexes.length ||
          (!input.joined && input.namePrefixIndexes.length > 0)
        ) {
          throw new Error("invalid group name prefix indexes");
        }
        await enterPersonalAccountContext(connection, input.personalAccountId);
        const target = await connection.query(
          `SELECT connections.id
           FROM app.whatsapp_connections AS connections
           WHERE connections.personal_account_id = $1
             AND connections.id = $2
             AND connections.state <> 'deleting'
             AND EXISTS (
               SELECT 1 FROM app.webhook_events AS events
               WHERE events.personal_account_id = $1
                 AND events.whatsapp_connection_id = $2
                 AND events.id = $3
             )
           FOR UPDATE`,
          [input.personalAccountId, input.whatsappConnectionId, input.eventId],
        );
        if (target.rows.length !== 1) {
          throw new Error("group projection target unavailable");
        }
        const claimed = await connection.query(
          `INSERT INTO app.webhook_items (
             personal_account_id, whatsapp_connection_id,
             deduplication_identity, first_webhook_event_id, item_index,
             item_kind, outcome, provider_occurred_at, provider_version,
             received_at
           ) VALUES ($1, $2, $3, $4, $5, 'directory_group',
             'superseded', $6, $7, $8)
           ON CONFLICT (
             personal_account_id, whatsapp_connection_id,
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

        const current = await connection.query<GroupEvidenceRow>(
          `SELECT id, last_observed_at, provider_occurred_at,
             provider_version, received_at
           FROM app.whatsapp_groups
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2
             AND provider_locator = $3
           FOR UPDATE`,
          [input.personalAccountId, input.whatsappConnectionId, input.locator],
        );
        if (
          !(await shouldApplyGroup(input, current.rows[0], compareVersions))
        ) {
          return "superseded" as const;
        }
        const currentId = current.rows[0]?.id;
        const recordId =
          typeof currentId === "string" ? currentId : input.groupId;
        const fields = protectedGroupValues(await protect(recordId));
        const effectiveObservedAt =
          input.evidence.occurredAt ?? input.receivedAt;
        await connection.query(
          `INSERT INTO app.whatsapp_groups (
               id, personal_account_id, whatsapp_connection_id, public_id,
               provider_locator, name_prefix_indexes,
               display_name_ciphertext_version,
             display_name_key_version, display_name_nonce,
             display_name_ciphertext, provider_identity_ciphertext_version,
             provider_identity_key_version, provider_identity_nonce,
             provider_identity_ciphertext, joined, last_observed_at,
             provider_occurred_at, provider_version, received_at,
             webhook_event_id, webhook_item_identity, created_at, updated_at
             ) VALUES (
             $1, $2, $3, $4, $5,
             $6::text[]::app.group_name_blind_index[],
             $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18, $19, $20, $21, $19, $19
           )
           ON CONFLICT (personal_account_id, whatsapp_connection_id, provider_locator)
           DO UPDATE SET
             name_prefix_indexes = EXCLUDED.name_prefix_indexes,
             display_name_ciphertext_version = EXCLUDED.display_name_ciphertext_version,
             display_name_key_version = EXCLUDED.display_name_key_version,
             display_name_nonce = EXCLUDED.display_name_nonce,
             display_name_ciphertext = EXCLUDED.display_name_ciphertext,
             provider_identity_ciphertext_version = EXCLUDED.provider_identity_ciphertext_version,
             provider_identity_key_version = EXCLUDED.provider_identity_key_version,
             provider_identity_nonce = EXCLUDED.provider_identity_nonce,
             provider_identity_ciphertext = EXCLUDED.provider_identity_ciphertext,
             joined = EXCLUDED.joined,
             last_observed_at = EXCLUDED.last_observed_at,
             provider_occurred_at = EXCLUDED.provider_occurred_at,
             provider_version = EXCLUDED.provider_version,
             received_at = EXCLUDED.received_at,
             webhook_event_id = EXCLUDED.webhook_event_id,
             webhook_item_identity = EXCLUDED.webhook_item_identity,
             updated_at = EXCLUDED.updated_at`,
          [
            recordId,
            input.personalAccountId,
            input.whatsappConnectionId,
            input.publicId,
            input.locator,
            input.namePrefixIndexes,
            ...fields,
            input.joined,
            effectiveObservedAt,
            input.evidence.occurredAt,
            input.evidence.version,
            input.receivedAt,
            input.eventId,
            input.itemIdentity,
          ],
        );
        await connection.query(
          `INSERT INTO app.whatsapp_group_directory_states (
             personal_account_id, whatsapp_connection_id, as_of,
             stale, partial, updated_at
           ) VALUES ($1, $2, $3, false, true, $3)
           ON CONFLICT (personal_account_id, whatsapp_connection_id)
           DO UPDATE SET
             as_of = greatest(app.whatsapp_group_directory_states.as_of, EXCLUDED.as_of),
             stale = app.whatsapp_group_directory_states.stale,
             partial = app.whatsapp_group_directory_states.partial,
             updated_at = greatest(app.whatsapp_group_directory_states.updated_at, EXCLUDED.updated_at)`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.receivedAt,
          ],
        );
        await connection.query(
          `UPDATE app.webhook_items SET outcome = 'applied'
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
    ),

  projectDirectoryContact: (input, compareVersions) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          !/^ctc_[A-Za-z0-9_-]{21}$/u.test(input.publicId) ||
          !/^di1_[A-Za-z0-9_-]{43}$/u.test(input.providerIdentityIndex) ||
          (input.phoneIndex !== null &&
            !/^di1_[A-Za-z0-9_-]{43}$/u.test(input.phoneIndex)) ||
          input.namePrefixIndexes.some(
            (value) => !/^di1_[A-Za-z0-9_-]{43}$/u.test(value),
          ) ||
          new TextEncoder().encode(input.displayNameSort).byteLength > 1_024 ||
          (!input.active &&
            (input.displayNameCiphertext !== null ||
              input.displayNameSort !== "" ||
              input.phoneCiphertext !== null ||
              input.phoneIndex !== null ||
              input.namePrefixIndexes.length !== 0))
        ) {
          throw new Error("invalid Directory contact projection");
        }
        const providerCiphertext = decodeCiphertext(
          input.providerIdentityCiphertext,
        );
        const providerNonce = decodeNonce(input.providerIdentityCiphertext);
        const displayNameCiphertext =
          input.displayNameCiphertext === null
            ? null
            : decodeCiphertext(input.displayNameCiphertext);
        const displayNameNonce =
          input.displayNameCiphertext === null
            ? null
            : decodeNonce(input.displayNameCiphertext);
        const phoneCiphertext =
          input.phoneCiphertext === null
            ? null
            : decodeCiphertext(input.phoneCiphertext);
        const phoneNonce =
          input.phoneCiphertext === null
            ? null
            : decodeNonce(input.phoneCiphertext);

        await enterPersonalAccountContext(connection, input.personalAccountId);
        const lockedConnection = await connection.query(
          `SELECT id
           FROM app.whatsapp_connections
           WHERE personal_account_id = $1
             AND id = $2
           FOR UPDATE`,
          [input.personalAccountId, input.whatsappConnectionId],
        );
        if (lockedConnection.rows.length !== 1) {
          throw new Error("Directory contact projection target unavailable");
        }
        const currentResult = await connection.query<ContactOrderRow>(
          `SELECT
             contacts.provider_occurred_at,
             contacts.provider_version,
             contacts.snapshot_observed_at,
             contacts.received_at,
             contacts.webhook_event_id
           FROM app.directory_contacts AS contacts
           WHERE contacts.personal_account_id = $1
             AND contacts.whatsapp_connection_id = $2
             AND contacts.provider_identity_index = $3
             AND EXISTS (
               SELECT 1
               FROM app.webhook_events AS events
               WHERE events.personal_account_id = $1
                 AND events.whatsapp_connection_id = $2
                 AND events.id = $4
             )
           FOR UPDATE`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.providerIdentityIndex,
            input.eventId,
          ],
        );
        const eventExists = await connection.query(
          `SELECT id
           FROM app.webhook_events
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2
             AND id = $3`,
          [input.personalAccountId, input.whatsappConnectionId, input.eventId],
        );
        if (eventExists.rows.length !== 1) {
          throw new Error("Directory contact projection target unavailable");
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
           ) VALUES (
             $1, $2, $3, $4, $5, 'directory_contact', 'superseded', $6, $7, $8
           )
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
        const current = currentResult.rows[0];
        if (
          current !== undefined &&
          !(await shouldApplyContact(input, current, compareVersions))
        ) {
          return "superseded" as const;
        }

        await connection.query(
          `INSERT INTO app.directory_contact_projections (
             personal_account_id,
             whatsapp_connection_id,
             as_of,
             stale,
             partial,
             updated_at
           ) VALUES ($1, $2, $3, false, true, $3)
           ON CONFLICT (personal_account_id, whatsapp_connection_id)
           DO UPDATE SET
             as_of = greatest(
               app.directory_contact_projections.as_of,
               excluded.as_of
             ),
             updated_at = greatest(
               app.directory_contact_projections.updated_at,
               excluded.updated_at
             )`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.receivedAt,
          ],
        );
        await connection.query(
          `INSERT INTO app.directory_contacts (
             personal_account_id,
             whatsapp_connection_id,
             public_id,
             provider_identity_index,
             provider_identity_ciphertext_version,
             provider_identity_key_version,
             provider_identity_nonce,
             provider_identity_ciphertext,
             display_name_ciphertext_version,
             display_name_key_version,
             display_name_nonce,
             display_name_ciphertext,
             display_name_sort,
             phone_ciphertext_version,
             phone_key_version,
             phone_nonce,
             phone_ciphertext,
             name_prefix_indexes,
             phone_index,
             active,
             provider_occurred_at,
             provider_version,
             received_at,
             webhook_event_id,
             webhook_item_identity,
             updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14, $15, $16, $17,
             ARRAY(
               SELECT value::app.directory_blind_index
               FROM jsonb_array_elements_text($18::jsonb) AS value
             ),
             $19, $20, $21, $22, $23,
             $24, $25, $23
           )
           ON CONFLICT (
             personal_account_id,
             whatsapp_connection_id,
             provider_identity_index
           ) DO UPDATE SET
             provider_identity_ciphertext_version =
               excluded.provider_identity_ciphertext_version,
             provider_identity_key_version = excluded.provider_identity_key_version,
             provider_identity_nonce = excluded.provider_identity_nonce,
             provider_identity_ciphertext = excluded.provider_identity_ciphertext,
             display_name_ciphertext_version = excluded.display_name_ciphertext_version,
             display_name_key_version = excluded.display_name_key_version,
             display_name_nonce = excluded.display_name_nonce,
             display_name_ciphertext = excluded.display_name_ciphertext,
             display_name_sort = excluded.display_name_sort,
             phone_ciphertext_version = excluded.phone_ciphertext_version,
             phone_key_version = excluded.phone_key_version,
             phone_nonce = excluded.phone_nonce,
             phone_ciphertext = excluded.phone_ciphertext,
             name_prefix_indexes = excluded.name_prefix_indexes,
             phone_index = excluded.phone_index,
             active = excluded.active,
             provider_occurred_at = excluded.provider_occurred_at,
             provider_version = excluded.provider_version,
             received_at = excluded.received_at,
             webhook_event_id = excluded.webhook_event_id,
             webhook_item_identity = excluded.webhook_item_identity,
             updated_at = excluded.updated_at`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.publicId,
            input.providerIdentityIndex,
            input.providerIdentityCiphertext.version,
            input.providerIdentityCiphertext.keyVersion,
            providerNonce,
            providerCiphertext,
            input.displayNameCiphertext?.version ?? null,
            input.displayNameCiphertext?.keyVersion ?? null,
            displayNameNonce,
            displayNameCiphertext,
            input.displayNameSort,
            input.phoneCiphertext?.version ?? null,
            input.phoneCiphertext?.keyVersion ?? null,
            phoneNonce,
            phoneCiphertext,
            JSON.stringify(input.namePrefixIndexes),
            input.phoneIndex,
            input.active,
            input.evidence.occurredAt,
            input.evidence.version,
            input.receivedAt,
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
    ),

  projectStoredMessage: (input, compareVersions) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          !/^cvs_[A-Za-z0-9_-]{21}$/u.test(input.conversationPublicId) ||
          !/^msg_[A-Za-z0-9_-]{21}$/u.test(input.messagePublicId) ||
          !/^wi1_[A-Za-z0-9_-]{43}$/u.test(input.messageIdentity) ||
          (input.recipientKind === "direct"
            ? !/^ctc_[A-Za-z0-9_-]{21}$/u.test(input.recipientPublicId)
            : !/^grp_[A-Za-z0-9_-]{21}$/u.test(input.recipientPublicId))
        ) {
          throw new Error("invalid Stored Message projection");
        }
        const ciphertext = decodeCiphertext(input.content);
        const nonce = decodeNonce(input.content);
        await enterPersonalAccountContext(connection, input.personalAccountId);
        const lockedConnection = await connection.query(
          `SELECT id FROM app.whatsapp_connections
           WHERE personal_account_id=$1 AND id=$2 FOR UPDATE`,
          [input.personalAccountId, input.whatsappConnectionId],
        );
        if (lockedConnection.rows.length !== 1) {
          throw new Error("Stored Message projection target unavailable");
        }
        const recipient =
          input.recipientKind === "group"
            ? await connection.query<{ id: unknown; public_id: unknown }>(
                `SELECT id, public_id FROM app.whatsapp_groups
               WHERE personal_account_id=$1 AND whatsapp_connection_id=$2
                 AND provider_locator=$3`,
                [
                  input.personalAccountId,
                  input.whatsappConnectionId,
                  input.recipientLocator,
                ],
              )
            : await connection.query<{ id: unknown; public_id: unknown }>(
                `SELECT id, public_id FROM app.directory_contacts
               WHERE personal_account_id=$1 AND whatsapp_connection_id=$2
                 AND provider_identity_index=$3`,
                [
                  input.personalAccountId,
                  input.whatsappConnectionId,
                  input.recipientLocator,
                ],
              );
        const recipientPublicId =
          typeof recipient.rows[0]?.public_id === "string"
            ? recipient.rows[0].public_id
            : input.recipientPublicId;
        const claimed = await connection.query(
          `INSERT INTO app.webhook_items (personal_account_id, whatsapp_connection_id,
             deduplication_identity, first_webhook_event_id, item_index, item_kind,
             outcome, provider_occurred_at, provider_version, received_at)
           VALUES ($1,$2,$3,$4,$5,'message_upsert','superseded',$6,$7,$8)
           ON CONFLICT (personal_account_id, whatsapp_connection_id, deduplication_identity)
           DO NOTHING RETURNING deduplication_identity`,
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
        const current = await connection.query<{
          deleted_at: unknown;
          edited_at: unknown;
          provider_occurred_at: unknown;
          provider_version: unknown;
          received_at: unknown;
        }>(
          `SELECT deleted_at, edited_at, provider_occurred_at, provider_version, received_at FROM app.stored_messages
           WHERE personal_account_id=$1 AND whatsapp_connection_id=$2 AND message_identity=$3 FOR UPDATE`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.messageIdentity,
          ],
        );
        const row = current.rows[0];
        if (row !== undefined) {
          if (timestamp(row.deleted_at) !== null) return "superseded" as const;
          const oldOccurred = timestamp(row.provider_occurred_at);
          const newOccurred = timestamp(input.evidence.occurredAt);
          const editedAt = timestamp(row.edited_at);
          if (
            editedAt !== null &&
            (newOccurred === null || newOccurred <= editedAt)
          )
            return "superseded" as const;
          if (
            oldOccurred !== null &&
            newOccurred !== null &&
            newOccurred < oldOccurred
          )
            return "superseded" as const;
          if (
            oldOccurred?.valueOf() === newOccurred?.valueOf() &&
            typeof row.provider_version === "string" &&
            input.evidence.version !== null &&
            (await compareVersions(
              input.evidence.version,
              row.provider_version,
            )) === "before"
          )
            return "superseded" as const;
        }
        await connection.query(
          `INSERT INTO app.whatsapp_conversations (id,personal_account_id,whatsapp_connection_id,
             public_id,kind,recipient_locator,recipient_public_id,last_activity_at,last_activity_direction)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (personal_account_id,whatsapp_connection_id,recipient_locator) DO NOTHING`,
          [
            input.conversationId,
            input.personalAccountId,
            input.whatsappConnectionId,
            input.conversationPublicId,
            input.recipientKind,
            input.recipientLocator,
            recipientPublicId,
            input.sentAt,
            input.direction,
          ],
        );
        const conversation = await connection.query<{ id: unknown }>(
          `SELECT id FROM app.whatsapp_conversations WHERE personal_account_id=$1 AND whatsapp_connection_id=$2 AND recipient_locator=$3`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.recipientLocator,
          ],
        );
        const conversationId = conversation.rows[0]?.id;
        if (typeof conversationId !== "string")
          throw new Error("invalid WhatsApp Conversation");
        await connection.query(
          `INSERT INTO app.stored_messages (id,personal_account_id,whatsapp_connection_id,conversation_id,
             public_id,message_identity,direction,sent_at,content_type,content_ciphertext_version,
             content_key_version,content_nonce,content_ciphertext,provider_occurred_at,provider_version,
             received_at,webhook_event_id,webhook_item_identity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           ON CONFLICT (personal_account_id,whatsapp_connection_id,message_identity) DO UPDATE SET
             direction=excluded.direction,sent_at=excluded.sent_at,content_type=excluded.content_type,
             content_ciphertext_version=excluded.content_ciphertext_version,content_key_version=excluded.content_key_version,
             content_nonce=excluded.content_nonce,content_ciphertext=excluded.content_ciphertext,
             provider_occurred_at=excluded.provider_occurred_at,provider_version=excluded.provider_version,
             received_at=excluded.received_at,webhook_event_id=excluded.webhook_event_id,
             webhook_item_identity=excluded.webhook_item_identity,updated_at=transaction_timestamp()`,
          [
            input.messageId,
            input.personalAccountId,
            input.whatsappConnectionId,
            conversationId,
            input.messagePublicId,
            input.messageIdentity,
            input.direction,
            input.sentAt,
            input.contentType,
            input.content.version,
            input.content.keyVersion,
            nonce,
            ciphertext,
            input.evidence.occurredAt,
            input.evidence.version,
            input.receivedAt,
            input.eventId,
            input.itemIdentity,
          ],
        );
        await connection.query(
          `UPDATE app.whatsapp_conversations AS conversations SET
             last_activity_at=latest.sent_at,last_activity_direction=latest.direction,updated_at=transaction_timestamp()
           FROM (SELECT sent_at,direction FROM app.stored_messages WHERE personal_account_id=$1
             AND whatsapp_connection_id=$2 AND conversation_id=$3 ORDER BY sent_at DESC, public_id DESC LIMIT 1) latest
           WHERE conversations.personal_account_id=$1 AND conversations.whatsapp_connection_id=$2 AND conversations.id=$3`,
          [input.personalAccountId, input.whatsappConnectionId, conversationId],
        );
        if (input.direction === "outbound") {
          const correlated = await connection.query<{ id: unknown }>(
            `SELECT id FROM app.send_operations
             WHERE personal_account_id=$1 AND whatsapp_connection_id=$2
               AND message_identity=$3 AND expires_at>$4 FOR UPDATE`,
            [
              input.personalAccountId,
              input.whatsappConnectionId,
              input.messageIdentity,
              input.receivedAt,
            ],
          );
          const sendId = correlated.rows[0]?.id;
          if (typeof sendId === "string") {
            await connection.query(
              `UPDATE app.send_operations SET status='sent',status_changed_at=$2
               WHERE id=$1 AND status IN ('processing','accepted','failed','unknown')`,
              [sendId, input.sentAt],
            );
            await connection.query(
              `DELETE FROM app.pending_send_contents
               WHERE personal_account_id=$1 AND send_operation_id=$2`,
              [input.personalAccountId, sendId],
            );
          }
        }
        await connection.query(
          `UPDATE app.webhook_items SET outcome='applied' WHERE personal_account_id=$1 AND whatsapp_connection_id=$2 AND deduplication_identity=$3`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.itemIdentity,
          ],
        );
        return "applied" as const;
      }),
    ),

  projectStoredMessageEdit: (input, compareVersions) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const ciphertext = decodeCiphertext(input.content);
        const nonce = decodeNonce(input.content);
        await enterPersonalAccountContext(connection, input.personalAccountId);
        const claimed = await connection.query(
          `INSERT INTO app.webhook_items (personal_account_id, whatsapp_connection_id,
             deduplication_identity, first_webhook_event_id, item_index, item_kind,
             outcome, provider_occurred_at, provider_version, received_at)
           VALUES ($1,$2,$3,$4,$5,'message_edit','superseded',$6,$7,$8)
           ON CONFLICT (personal_account_id, whatsapp_connection_id, deduplication_identity)
           DO NOTHING RETURNING deduplication_identity`,
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
        const current = await connection.query<Record<string, unknown>>(
          `SELECT deleted_at, edited_at, provider_occurred_at, provider_version,
             received_at, webhook_event_id FROM app.stored_messages
           WHERE personal_account_id=$1 AND whatsapp_connection_id=$2 AND message_identity=$3 FOR UPDATE`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.messageIdentity,
          ],
        );
        const row = current.rows[0];
        if (row === undefined || timestamp(row.deleted_at) !== null)
          return "superseded" as const;
        if (
          !(await shouldApply(
            input,
            {
              state_provider_occurred_at: row.provider_occurred_at,
              state_provider_version: row.provider_version,
              state_received_at: row.received_at,
              state_snapshot_observed_at: null,
              state_webhook_event_id: row.webhook_event_id,
            },
            compareVersions,
          ))
        )
          return "superseded" as const;
        const oldEditedAt = timestamp(row.edited_at);
        const newEditedAt = timestamp(input.editedAt);
        if (newEditedAt === null) throw new Error("invalid edit timestamp");
        if (oldEditedAt !== null && newEditedAt < oldEditedAt)
          return "superseded" as const;
        await connection.query(
          `UPDATE app.stored_messages SET content_type=$4,content_ciphertext_version=$5,
             content_key_version=$6,content_nonce=$7,content_ciphertext=$8,edited_at=$9,
             provider_occurred_at=$10,provider_version=$11,received_at=$12,
             webhook_event_id=$13,webhook_item_identity=$14,updated_at=transaction_timestamp()
           WHERE personal_account_id=$1 AND whatsapp_connection_id=$2 AND message_identity=$3`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.messageIdentity,
            input.contentType,
            input.content.version,
            input.content.keyVersion,
            nonce,
            ciphertext,
            input.editedAt,
            input.evidence.occurredAt,
            input.evidence.version,
            input.receivedAt,
            input.eventId,
            input.itemIdentity,
          ],
        );
        await connection.query(
          `UPDATE app.webhook_items SET outcome='applied' WHERE personal_account_id=$1 AND whatsapp_connection_id=$2 AND deduplication_identity=$3`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.itemIdentity,
          ],
        );
        return "applied" as const;
      }),
    ),

  projectStoredMessageDeletion: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        await enterPersonalAccountContext(connection, input.personalAccountId);
        const claimed = await connection.query(
          `INSERT INTO app.webhook_items (personal_account_id, whatsapp_connection_id,
             deduplication_identity, first_webhook_event_id, item_index, item_kind,
             outcome, provider_occurred_at, provider_version, received_at)
           VALUES ($1,$2,$3,$4,$5,'message_delete','superseded',$6,$7,$8)
           ON CONFLICT (personal_account_id, whatsapp_connection_id, deduplication_identity)
           DO NOTHING RETURNING deduplication_identity`,
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
        await connection.query(
          `INSERT INTO app.whatsapp_conversations (id,personal_account_id,whatsapp_connection_id,
             public_id,kind,recipient_locator,recipient_public_id,last_activity_at,last_activity_direction)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (personal_account_id,whatsapp_connection_id,recipient_locator) DO NOTHING`,
          [
            input.conversationId,
            input.personalAccountId,
            input.whatsappConnectionId,
            input.conversationPublicId,
            input.recipientKind,
            input.recipientLocator,
            input.recipientPublicId,
            input.sentAt,
            input.direction,
          ],
        );
        const conversation = await connection.query<{ id: unknown }>(
          `SELECT id FROM app.whatsapp_conversations WHERE personal_account_id=$1 AND whatsapp_connection_id=$2 AND recipient_locator=$3`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.recipientLocator,
          ],
        );
        const conversationId = conversation.rows[0]?.id;
        if (typeof conversationId !== "string")
          throw new Error("invalid WhatsApp Conversation");
        await connection.query(
          `INSERT INTO app.stored_messages (id,personal_account_id,whatsapp_connection_id,
             conversation_id,public_id,message_identity,direction,sent_at,deleted_at,
             provider_occurred_at,provider_version,received_at,webhook_event_id,webhook_item_identity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (personal_account_id,whatsapp_connection_id,message_identity) DO UPDATE SET
             content_type=NULL,content_ciphertext_version=NULL,content_key_version=NULL,
             content_nonce=NULL,content_ciphertext=NULL,deleted_at=excluded.deleted_at,
             provider_occurred_at=excluded.provider_occurred_at,provider_version=excluded.provider_version,
             received_at=excluded.received_at,webhook_event_id=excluded.webhook_event_id,
             webhook_item_identity=excluded.webhook_item_identity,updated_at=transaction_timestamp()`,
          [
            input.messageId,
            input.personalAccountId,
            input.whatsappConnectionId,
            conversationId,
            input.messagePublicId,
            input.messageIdentity,
            input.direction,
            input.sentAt,
            input.deletedAt,
            input.evidence.occurredAt,
            input.evidence.version,
            input.receivedAt,
            input.eventId,
            input.itemIdentity,
          ],
        );
        await connection.query(
          `UPDATE app.webhook_items SET outcome='applied' WHERE personal_account_id=$1 AND whatsapp_connection_id=$2 AND deduplication_identity=$3`,
          [
            input.personalAccountId,
            input.whatsappConnectionId,
            input.itemIdentity,
          ],
        );
        return "applied" as const;
      }),
    ),

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
