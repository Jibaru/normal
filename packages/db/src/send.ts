import type { Client as PgClient } from "pg";
import type {
  McpAccessAuthorization,
  McpToolConnectionProvider,
} from "./mcp-tool";

export interface SendCiphertext {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
}

export interface SendEncryptionMaterial {
  readonly accountKey: {
    readonly ciphertext: Uint8Array;
    readonly keyVersion: number;
    readonly kmsKeyId: string;
    readonly personalAccountId: string;
  };
  readonly connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: Uint8Array;
    readonly connectionId: string;
    readonly keyVersion: number;
    readonly nonce: Uint8Array;
    readonly personalAccountId: string;
  };
}

export interface SendProviderMaterial extends SendEncryptionMaterial {
  readonly authority: SendCiphertext;
  readonly identityKey: SendCiphertext;
  readonly recipient: SendCiphertext;
  readonly recipientType: "contact" | "group";
  readonly recipientRecordId: string;
}

export interface SendReceiptRecord {
  readonly createdAt: Date;
  readonly publicId: string;
  readonly status:
    | "processing"
    | "accepted"
    | "sent"
    | "delivered"
    | "read"
    | "failed"
    | "unknown";
  readonly statusChangedAt: Date;
}

export type CommitSendResult =
  | {
      readonly outcome:
        | "authorization_denied"
        | "connection_unavailable"
        | "idempotency_conflict"
        | "recipient_not_found";
    }
  | {
      readonly outcome: "rate_limited";
      readonly resetsAt: Date;
      readonly retryAfterSeconds: number;
    }
  | { readonly outcome: "replay"; readonly receipt: SendReceiptRecord }
  | {
      readonly outcome: "created";
      readonly provider: SendProviderMaterial;
      readonly receipt: SendReceiptRecord;
    };

export interface AtomicSendRepository {
  readonly commit: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly connectionPublicId: string;
      readonly fingerprint: string;
      readonly hourRequestLimit: number;
      readonly idempotencyKey: string;
      readonly minuteRequestLimit: number;
      readonly observedAt: Date;
      readonly pendingExpiresAt: Date;
      readonly recipientPublicId: string;
      readonly sendDailyLimit: number;
      readonly sendId: string;
      readonly sendPublicId: string;
      readonly sendPerMinuteLimit: number;
    },
    encrypt: (material: SendEncryptionMaterial) => Promise<SendCiphertext>,
  ) => Promise<CommitSendResult>;
  readonly recordProviderOutcome: (input: {
    readonly changedAt: Date;
    readonly sendId: string;
    readonly status:
      | "accepted"
      | "sent"
      | "delivered"
      | "read"
      | "failed"
      | "unknown";
  }) => Promise<SendReceiptRecord>;
}

const scalar = (
  row: Record<string, unknown> | undefined,
  key: string,
): string => {
  const value = row?.[key];
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
};
const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value))
    return new Uint8Array(value);
  throw new Error("invalid ciphertext");
};
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid version");
  return value;
};
const date = (value: unknown): Date => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.valueOf())) throw new Error("invalid timestamp");
  return parsed;
};
const receipt = (row: Record<string, unknown>): SendReceiptRecord => ({
  createdAt: date(row.created_at),
  publicId: scalar(row, "public_id"),
  status: scalar(row, "status") as SendReceiptRecord["status"],
  statusChangedAt: date(row.status_changed_at),
});

export const makePgAtomicSendRepository = (
  provider: McpToolConnectionProvider,
): AtomicSendRepository => ({
  commit: (input, encrypt) =>
    provider.withConnection(async (connection) => {
      await connection.query("BEGIN");
      try {
        const boot = await connection.query<{ personal_account_id: unknown }>(
          "SELECT app_private.bootstrap_mcp_tool_call($1,$2,$3) AS personal_account_id",
          [input.authorizationId, input.oauthSubject, input.clientId ?? null],
        );
        const accountId = boot.rows[0]?.personal_account_id;
        if (typeof accountId !== "string") {
          await connection.query("ROLLBACK");
          return { outcome: "authorization_denied" as const };
        }
        await connection.query(
          "SELECT set_config('app.personal_account_id',$1,true)",
          [accountId],
        );
        const finishAudit = async (
          outcome:
            | "authorization_denied"
            | "execution_error"
            | "rate_limited"
            | "success",
          errorCode: string | null,
        ) => {
          await connection.query(
            `INSERT INTO app.tool_call_logs (id,personal_account_id,mcp_authorization_id,tool_name,started_at,completed_at,outcome,error_code,result_count,latency_ms,quota_reserved,expires_at)
             VALUES ($1,$2,$3,'send_text_message',$4,$4,$5,$6,CASE WHEN $5='success' THEN 1 ELSE NULL END,0,false,$4::timestamptz+interval '90 days')`,
            [
              input.auditLogId,
              accountId,
              input.authorizationId,
              input.observedAt,
              outcome,
              errorCode,
            ],
          );
          await connection.query("COMMIT");
        };
        const lockedAccount = await connection.query<{
          message_retention_days: unknown;
        }>(
          "SELECT message_retention_days FROM app.personal_accounts WHERE id=$1 FOR UPDATE",
          [accountId],
        );
        await connection.query(
          "SELECT id FROM app.mcp_authorizations WHERE id=$1 FOR UPDATE",
          [input.authorizationId],
        );
        const retentionDays = integer(
          lockedAccount.rows[0]?.message_retention_days,
        );
        const active = await connection.query<{ personal_account_id: unknown }>(
          "SELECT app_private.bootstrap_active_mcp_tool_call($1,$2,$3,$4) AS personal_account_id",
          [
            input.authorizationId,
            input.oauthSubject,
            input.clientId ?? null,
            input.observedAt,
          ],
        );
        if (typeof active.rows[0]?.personal_account_id !== "string") {
          await finishAudit("authorization_denied", "authorization_denied");
          return { outcome: "authorization_denied" as const };
        }
        const authorized = await connection.query<Record<string, unknown>>(
          `SELECT connections.id AS connection_id
           FROM app.mcp_authorizations AS authorizations
           JOIN app.mcp_authorization_connections AS grants
             ON grants.personal_account_id=authorizations.personal_account_id AND grants.mcp_authorization_id=authorizations.id
           JOIN app.whatsapp_connections AS connections
             ON connections.personal_account_id=grants.personal_account_id AND connections.id=grants.whatsapp_connection_id
           WHERE authorizations.id=$1 AND 'messages:send'=ANY(authorizations.scopes) AND connections.public_id=$2`,
          [input.authorizationId, input.connectionPublicId],
        );
        if (authorized.rows.length === 0) {
          await finishAudit("authorization_denied", "authorization_denied");
          return { outcome: "authorization_denied" as const };
        }
        const connectionId = scalar(authorized.rows[0], "connection_id");
        const bound = await connection.query<Record<string, unknown>>(
          `SELECT operations.* , bindings.request_fingerprint
           FROM app.send_idempotency_bindings AS bindings
           JOIN app.send_operations AS operations ON operations.id=bindings.send_operation_id
           WHERE bindings.mcp_authorization_id=$1 AND bindings.idempotency_key=$2 AND bindings.expires_at>$3
           FOR UPDATE`,
          [input.authorizationId, input.idempotencyKey, input.observedAt],
        );
        if (bound.rows[0] !== undefined) {
          if (
            bound.rows[0].status === "processing" &&
            date(bound.rows[0].lease_expires_at) <= input.observedAt
          ) {
            await connection.query(
              "UPDATE app.send_operations SET status='unknown',status_changed_at=$2 WHERE id=$1",
              [bound.rows[0].id, input.observedAt],
            );
            bound.rows[0].status = "unknown";
            bound.rows[0].status_changed_at = input.observedAt;
          }
          const result =
            scalar(bound.rows[0], "request_fingerprint") === input.fingerprint
              ? { outcome: "replay" as const, receipt: receipt(bound.rows[0]) }
              : { outcome: "idempotency_conflict" as const };
          await finishAudit(
            result.outcome === "replay" ? "success" : "execution_error",
            result.outcome === "replay" ? null : "idempotency_conflict",
          );
          return result;
        }
        const connectionState = await connection.query<{ state: unknown }>(
          "SELECT state FROM app.whatsapp_connections WHERE id=$1 FOR UPDATE",
          [connectionId],
        );
        if (connectionState.rows[0]?.state !== "connected") {
          await finishAudit("execution_error", "connection_unavailable");
          return { outcome: "connection_unavailable" as const };
        }
        const recipientType = input.recipientPublicId.startsWith("ctc_")
          ? "contact"
          : "group";
        const recipient = await connection.query<Record<string, unknown>>(
          recipientType === "contact"
            ? `SELECT provider_identity_index AS recipient_record_id, provider_identity_ciphertext_version, provider_identity_key_version,
                      provider_identity_nonce, provider_identity_ciphertext
               FROM app.directory_contacts WHERE personal_account_id=$1 AND whatsapp_connection_id=$2
                 AND public_id=$3 AND active`
            : `SELECT id::text AS recipient_record_id, provider_identity_ciphertext_version, provider_identity_key_version,
                      provider_identity_nonce, provider_identity_ciphertext
               FROM app.whatsapp_groups WHERE personal_account_id=$1 AND whatsapp_connection_id=$2
                 AND public_id=$3 AND joined`,
          [accountId, connectionId, input.recipientPublicId],
        );
        if (recipient.rows[0] === undefined) {
          await finishAudit("execution_error", "recipient_not_found");
          return { outcome: "recipient_not_found" as const };
        }
        const policyPendingExpiry = new Date(
          input.observedAt.valueOf() + retentionDays * 86_400_000,
        );
        const pendingExpiresAt =
          policyPendingExpiry < input.pendingExpiresAt
            ? policyPendingExpiry
            : input.pendingExpiresAt;
        const minuteStart = new Date(input.observedAt.valueOf() - 60_000);
        const dayStart = new Date(
          Date.UTC(
            input.observedAt.getUTCFullYear(),
            input.observedAt.getUTCMonth(),
            input.observedAt.getUTCDate(),
          ),
        );
        const quotas = await connection.query<Record<string, unknown>>(
          `SELECT
             (SELECT count(*)::int FROM app.tool_call_logs WHERE personal_account_id=$1 AND quota_reserved AND started_at>$2) AS request_minute,
             (SELECT max(started_at) FROM app.tool_call_logs WHERE personal_account_id=$1 AND quota_reserved AND started_at>$2) AS request_minute_latest,
             (SELECT count(*)::int FROM app.tool_call_logs WHERE personal_account_id=$1 AND quota_reserved AND started_at>$3) AS request_hour,
             (SELECT max(started_at) FROM app.tool_call_logs WHERE personal_account_id=$1 AND quota_reserved AND started_at>$3) AS request_hour_latest,
             (SELECT count(*)::int FROM app.send_quota_reservations WHERE mcp_authorization_id=$4 AND reserved_at>$2) AS send_minute,
             (SELECT max(reserved_at) FROM app.send_quota_reservations WHERE mcp_authorization_id=$4 AND reserved_at>$2) AS send_minute_latest,
             (SELECT count(*)::int FROM app.send_quota_reservations WHERE personal_account_id=$1 AND reserved_at>=$5) AS send_day`,
          [
            accountId,
            minuteStart,
            new Date(input.observedAt.valueOf() - 3_600_000),
            input.authorizationId,
            dayStart,
          ],
        );
        const q = quotas.rows[0] ?? {};
        const limited =
          Number(q.request_minute) >= input.minuteRequestLimit ||
          Number(q.request_hour) >= input.hourRequestLimit ||
          Number(q.send_minute) >= input.sendPerMinuteLimit ||
          Number(q.send_day) >= input.sendDailyLimit;
        if (limited) {
          await finishAudit("rate_limited", "rate_limited");
          const candidates: Date[] = [];
          if (Number(q.request_minute) >= input.minuteRequestLimit)
            candidates.push(
              new Date(date(q.request_minute_latest).valueOf() + 60_000),
            );
          if (Number(q.request_hour) >= input.hourRequestLimit)
            candidates.push(
              new Date(date(q.request_hour_latest).valueOf() + 3_600_000),
            );
          if (Number(q.send_minute) >= input.sendPerMinuteLimit)
            candidates.push(
              new Date(date(q.send_minute_latest).valueOf() + 60_000),
            );
          if (Number(q.send_day) >= input.sendDailyLimit)
            candidates.push(new Date(dayStart.valueOf() + 86_400_000));
          const resetsAt = new Date(
            Math.max(...candidates.map((candidate) => candidate.valueOf())),
          );
          return {
            outcome: "rate_limited" as const,
            resetsAt,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil(
                (resetsAt.valueOf() - input.observedAt.valueOf()) / 1_000,
              ),
            ),
          };
        }
        await connection.query(
          `INSERT INTO app.tool_call_logs (id,personal_account_id,mcp_authorization_id,tool_name,started_at,completed_at,outcome,error_code,result_count,latency_ms,quota_reserved,expires_at)
           VALUES ($1,$2,$3,'send_text_message',$4::timestamptz,NULL,'started',NULL,NULL,NULL,true,$4::timestamptz+interval '90 days')`,
          [
            input.auditLogId,
            accountId,
            input.authorizationId,
            input.observedAt,
          ],
        );
        const materialRows = await connection.query<Record<string, unknown>>(
          "SELECT * FROM app_private.load_send_key_material($1,$2)",
          [accountId, connectionId],
        );
        const row = materialRows.rows[0];
        if (row === undefined) throw new Error("send key material unavailable");
        const encryptionMaterial: SendEncryptionMaterial = {
          accountKey: {
            ciphertext: bytes(row.account_key_ciphertext),
            keyVersion: integer(row.account_key_version),
            kmsKeyId: scalar(row, "kms_key_id"),
            personalAccountId: accountId,
          },
          connectionKey: {
            accountKeyVersion: integer(row.connection_account_key_version),
            ciphertext: bytes(row.connection_key_ciphertext),
            connectionId,
            keyVersion: integer(row.connection_key_version),
            nonce: bytes(row.connection_key_nonce),
            personalAccountId: accountId,
          },
        };
        const pending = await encrypt(encryptionMaterial);
        await connection.query(
          `INSERT INTO app.send_operations (id,public_id,personal_account_id,mcp_authorization_id,tool_call_log_id,whatsapp_connection_id,recipient_type,recipient_public_id,status,created_at,status_changed_at,attempt_claimed_at,lease_expires_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9::timestamptz,$9::timestamptz,$9::timestamptz,$9::timestamptz+interval '30 seconds',$9::timestamptz+interval '90 days')`,
          [
            input.sendId,
            input.sendPublicId,
            accountId,
            input.authorizationId,
            input.auditLogId,
            connectionId,
            recipientType,
            input.recipientPublicId,
            input.observedAt,
          ],
        );
        await connection.query(
          `INSERT INTO app.send_idempotency_bindings VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz+interval '90 days')`,
          [
            accountId,
            input.authorizationId,
            input.idempotencyKey,
            input.sendId,
            input.fingerprint,
            input.observedAt,
          ],
        );
        await connection.query(
          `INSERT INTO app.pending_send_contents VALUES ($1,$2,$3,1,$4,$5,$6,$7)`,
          [
            input.sendId,
            accountId,
            connectionId,
            pending.keyVersion,
            pending.nonce,
            pending.ciphertext,
            pendingExpiresAt,
          ],
        );
        await connection.query(
          "INSERT INTO app.send_quota_reservations VALUES ($1,$2,$3,$4)",
          [input.sendId, accountId, input.authorizationId, input.observedAt],
        );
        await connection.query("COMMIT");
        const recipientRow = recipient.rows[0];
        return {
          outcome: "created" as const,
          receipt: {
            createdAt: input.observedAt,
            publicId: input.sendPublicId,
            status: "processing" as const,
            statusChangedAt: input.observedAt,
          },
          provider: {
            ...encryptionMaterial,
            authority: {
              ciphertext: bytes(row.authority_ciphertext),
              keyVersion: integer(row.authority_key_version),
              nonce: bytes(row.authority_nonce),
            },
            identityKey: {
              ciphertext: bytes(row.identity_ciphertext),
              keyVersion: integer(row.identity_key_version),
              nonce: bytes(row.identity_nonce),
            },
            recipient: {
              ciphertext: bytes(recipientRow.provider_identity_ciphertext),
              keyVersion: integer(recipientRow.provider_identity_key_version),
              nonce: bytes(recipientRow.provider_identity_nonce),
            },
            recipientType,
            recipientRecordId: scalar(recipientRow, "recipient_record_id"),
          },
        };
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      }
    }),
  recordProviderOutcome: (input) =>
    provider.withConnection(async (connection) => {
      await connection.query("BEGIN");
      const context = await connection.query<{ personal_account_id: unknown }>(
        "SELECT app_private.bootstrap_send_operation($1) AS personal_account_id",
        [input.sendId],
      );
      const accountId = context.rows[0]?.personal_account_id;
      if (typeof accountId !== "string") {
        await connection.query("ROLLBACK");
        throw new Error("send operation unavailable");
      }
      await connection.query(
        "SELECT set_config('app.personal_account_id',$1,true)",
        [accountId],
      );
      const result = await connection.query<Record<string, unknown>>(
        `UPDATE app.send_operations SET status=$2,status_changed_at=$3
         WHERE id=$1 RETURNING *`,
        [input.sendId, input.status, input.changedAt],
      );
      if (result.rows[0] === undefined) {
        await connection.query("ROLLBACK");
        throw new Error("send operation unavailable");
      }
      if (input.status === "failed") {
        await connection.query(
          "DELETE FROM app.pending_send_contents WHERE send_operation_id=$1",
          [input.sendId],
        );
      }
      await connection.query("COMMIT");
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT set_config('app.personal_account_id',$1,true)",
          [accountId],
        );
        await connection.query(
          `UPDATE app.tool_call_logs SET completed_at=$2,outcome='success',result_count=1,
             latency_ms=greatest(0,floor(extract(epoch FROM ($2-started_at))*1000)::int)
           WHERE id=(SELECT tool_call_log_id FROM app.send_operations WHERE id=$1)`,
          [input.sendId, input.changedAt],
        );
        await connection.query("COMMIT");
      } catch {
        await connection.query("ROLLBACK");
      }
      return receipt(result.rows[0]);
    }),
});

export const makePgAtomicSendRepositoryFromConnectionString = (
  connectionString: string,
): AtomicSendRepository =>
  makePgAtomicSendRepository({
    withConnection: async (use) => {
      const { Client } = await import("pg");
      const client = new Client({ connectionString });
      await client.connect();
      try {
        return await use(client as PgClient);
      } finally {
        await client.end();
      }
    },
  });
