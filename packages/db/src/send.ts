import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { makeDatabase, makeQueryConnection } from "./database";
import type {
  McpAccessAuthorization,
  McpToolConnectionProvider,
} from "./mcp-tool";
import {
  directoryContactsInApp,
  mcpAuthorizationConnectionsInApp,
  mcpAuthorizationsInApp,
  pendingSendContentsInApp,
  personalAccountsInApp,
  sendIdempotencyBindingsInApp,
  sendOperationsInApp,
  sendQuotaReservationsInApp,
  storedMessagesInApp,
  toolCallLogsInApp,
  whatsappConnectionsInApp,
  whatsappConversationsInApp,
  whatsappGroupsInApp,
} from "./schema";

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
  readonly contactPhone?: SendCiphertext | null;
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
  readonly expireLeases: (observedAt: Date) => Promise<number>;
  readonly recordProviderOutcome: (input: {
    readonly changedAt: Date;
    readonly messageIdentity?: string;
    readonly sendId: string;
    readonly status:
      | "accepted"
      | "sent"
      | "delivered"
      | "read"
      | "failed"
      | "unknown";
    readonly storedMessage?: {
      readonly content: SendCiphertext;
      readonly contentType: "text";
      readonly conversationId: string;
      readonly conversationPublicId: string;
      readonly messageId: string;
      readonly messagePublicId: string;
    };
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
      const db = makeDatabase(connection);
      await db.execute(sql`BEGIN`);
      try {
        const boot = await db.execute<{ personal_account_id: unknown }>(
          sql`SELECT app_private.bootstrap_mcp_tool_call(${input.authorizationId},${input.oauthSubject},${input.clientId ?? null}) AS personal_account_id`,
        );
        const accountId = boot[0]?.personal_account_id;
        if (typeof accountId !== "string") {
          await db.execute(sql`ROLLBACK`);
          return { outcome: "authorization_denied" as const };
        }
        await db.execute(
          sql`SELECT set_config('app.personal_account_id',${accountId},true)`,
        );
        const finishAudit = async (
          outcome:
            | "authorization_denied"
            | "execution_error"
            | "rate_limited"
            | "success",
          errorCode: string | null,
          sendPublicId: string | null = null,
        ) => {
          await db.insert(toolCallLogsInApp).values({
            id: input.auditLogId,
            personalAccountId: accountId,
            mcpAuthorizationId: input.authorizationId,
            toolName: "send_text_message",
            startedAt: input.observedAt.toISOString(),
            completedAt: input.observedAt.toISOString(),
            outcome,
            errorCode,
            resultCount: outcome === "success" ? 1 : null,
            latencyMs: 0,
            quotaReserved: false,
            expiresAt: sql`${input.observedAt}::timestamptz + interval '90 days'`,
            connectionPublicId: input.connectionPublicId,
            sendPublicId,
          });
          await db.execute(sql`COMMIT`);
        };
        const lockedAccount = await db
          .select({
            message_retention_days: personalAccountsInApp.messageRetentionDays,
          })
          .from(personalAccountsInApp)
          .where(eq(personalAccountsInApp.id, accountId))
          .for("update");
        await db
          .select({ id: mcpAuthorizationsInApp.id })
          .from(mcpAuthorizationsInApp)
          .where(eq(mcpAuthorizationsInApp.id, input.authorizationId))
          .for("update");
        const retentionDays = integer(lockedAccount[0]?.message_retention_days);
        const active = await db.execute<{ personal_account_id: unknown }>(
          sql`SELECT app_private.bootstrap_active_mcp_tool_call(${input.authorizationId},${input.oauthSubject},${input.clientId ?? null},${input.observedAt}) AS personal_account_id`,
        );
        if (typeof active[0]?.personal_account_id !== "string") {
          await finishAudit("authorization_denied", "authorization_denied");
          return { outcome: "authorization_denied" as const };
        }
        const authorized = await db
          .select({ connection_id: whatsappConnectionsInApp.id })
          .from(mcpAuthorizationsInApp)
          .innerJoin(
            mcpAuthorizationConnectionsInApp,
            and(
              eq(
                mcpAuthorizationConnectionsInApp.personalAccountId,
                mcpAuthorizationsInApp.personalAccountId,
              ),
              eq(
                mcpAuthorizationConnectionsInApp.mcpAuthorizationId,
                mcpAuthorizationsInApp.id,
              ),
            ),
          )
          .innerJoin(
            whatsappConnectionsInApp,
            and(
              eq(
                whatsappConnectionsInApp.personalAccountId,
                mcpAuthorizationConnectionsInApp.personalAccountId,
              ),
              eq(
                whatsappConnectionsInApp.id,
                mcpAuthorizationConnectionsInApp.whatsappConnectionId,
              ),
            ),
          )
          .where(
            and(
              eq(mcpAuthorizationsInApp.id, input.authorizationId),
              sql`${"messages:send"} = ANY(${mcpAuthorizationsInApp.scopes})`,
              eq(whatsappConnectionsInApp.publicId, input.connectionPublicId),
            ),
          );
        if (authorized.length === 0) {
          await finishAudit("authorization_denied", "authorization_denied");
          return { outcome: "authorization_denied" as const };
        }
        const connectionId = scalar(authorized[0], "connection_id");
        const bound = await db
          .select({
            id: sendOperationsInApp.id,
            public_id: sendOperationsInApp.publicId,
            status: sendOperationsInApp.status,
            created_at: sendOperationsInApp.createdAt,
            status_changed_at: sendOperationsInApp.statusChangedAt,
            lease_expires_at: sendOperationsInApp.leaseExpiresAt,
            request_fingerprint:
              sendIdempotencyBindingsInApp.requestFingerprint,
          })
          .from(sendIdempotencyBindingsInApp)
          .innerJoin(
            sendOperationsInApp,
            eq(
              sendOperationsInApp.id,
              sendIdempotencyBindingsInApp.sendOperationId,
            ),
          )
          .where(
            and(
              eq(
                sendIdempotencyBindingsInApp.mcpAuthorizationId,
                input.authorizationId,
              ),
              eq(
                sendIdempotencyBindingsInApp.idempotencyKey,
                input.idempotencyKey,
              ),
              gt(
                sendIdempotencyBindingsInApp.expiresAt,
                input.observedAt.toISOString(),
              ),
            ),
          )
          .for("update");
        if (bound[0] !== undefined) {
          if (
            bound[0].status === "processing" &&
            date(bound[0].lease_expires_at) <= input.observedAt
          ) {
            await db
              .update(sendOperationsInApp)
              .set({
                status: "unknown",
                statusChangedAt: input.observedAt.toISOString(),
              })
              .where(eq(sendOperationsInApp.id, bound[0].id));
            bound[0].status = "unknown";
            bound[0].status_changed_at = input.observedAt.toISOString();
          }
          const result =
            scalar(bound[0], "request_fingerprint") === input.fingerprint
              ? { outcome: "replay" as const, receipt: receipt(bound[0]) }
              : { outcome: "idempotency_conflict" as const };
          await finishAudit(
            result.outcome === "replay" ? "success" : "execution_error",
            result.outcome === "replay" ? null : "idempotency_conflict",
            scalar(bound[0], "public_id"),
          );
          return result;
        }
        const connectionState = await db
          .select({ state: whatsappConnectionsInApp.state })
          .from(whatsappConnectionsInApp)
          .where(eq(whatsappConnectionsInApp.id, connectionId))
          .for("update");
        if (connectionState[0]?.state !== "connected") {
          await finishAudit("execution_error", "connection_unavailable");
          return { outcome: "connection_unavailable" as const };
        }
        const recipientType = input.recipientPublicId.startsWith("ctc_")
          ? "contact"
          : "group";
        const recipient =
          recipientType === "contact"
            ? await db
                .select({
                  phone_ciphertext_version:
                    directoryContactsInApp.phoneCiphertextVersion,
                  phone_key_version: directoryContactsInApp.phoneKeyVersion,
                  phone_nonce: directoryContactsInApp.phoneNonce,
                  phone_ciphertext: directoryContactsInApp.phoneCiphertext,
                  recipient_record_id:
                    directoryContactsInApp.providerIdentityIndex,
                  provider_identity_ciphertext_version:
                    directoryContactsInApp.providerIdentityCiphertextVersion,
                  provider_identity_key_version:
                    directoryContactsInApp.providerIdentityKeyVersion,
                  provider_identity_nonce:
                    directoryContactsInApp.providerIdentityNonce,
                  provider_identity_ciphertext:
                    directoryContactsInApp.providerIdentityCiphertext,
                })
                .from(directoryContactsInApp)
                .where(
                  and(
                    eq(directoryContactsInApp.personalAccountId, accountId),
                    eq(
                      directoryContactsInApp.whatsappConnectionId,
                      connectionId,
                    ),
                    eq(
                      directoryContactsInApp.publicId,
                      input.recipientPublicId,
                    ),
                    eq(directoryContactsInApp.active, true),
                  ),
                )
            : await db
                .select({
                  phone_ciphertext_version: sql<null>`NULL`,
                  phone_key_version: sql<null>`NULL`,
                  phone_nonce: sql<null>`NULL`,
                  phone_ciphertext: sql<null>`NULL`,
                  recipient_record_id: whatsappGroupsInApp.id,
                  provider_identity_ciphertext_version:
                    whatsappGroupsInApp.providerIdentityCiphertextVersion,
                  provider_identity_key_version:
                    whatsappGroupsInApp.providerIdentityKeyVersion,
                  provider_identity_nonce:
                    whatsappGroupsInApp.providerIdentityNonce,
                  provider_identity_ciphertext:
                    whatsappGroupsInApp.providerIdentityCiphertext,
                })
                .from(whatsappGroupsInApp)
                .where(
                  and(
                    eq(whatsappGroupsInApp.personalAccountId, accountId),
                    eq(whatsappGroupsInApp.whatsappConnectionId, connectionId),
                    eq(whatsappGroupsInApp.publicId, input.recipientPublicId),
                    eq(whatsappGroupsInApp.joined, true),
                  ),
                );
        if (recipient[0] === undefined) {
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
        const hourStart = new Date(input.observedAt.valueOf() - 3_600_000);
        const quotas = await db.execute<Record<string, unknown>>(
          sql`SELECT
             (SELECT count(*)::int FROM app.tool_call_logs WHERE personal_account_id=${accountId} AND quota_reserved AND started_at>${minuteStart} AND started_at<=${input.observedAt}) AS request_minute,
             (SELECT (array_agg(started_at ORDER BY started_at DESC))[(${input.minuteRequestLimit}::int)] FROM app.tool_call_logs WHERE personal_account_id=${accountId} AND quota_reserved AND started_at>${minuteStart} AND started_at<=${input.observedAt}) AS request_minute_reset,
             (SELECT count(*)::int FROM app.tool_call_logs WHERE personal_account_id=${accountId} AND quota_reserved AND started_at>${hourStart} AND started_at<=${input.observedAt}) AS request_hour,
             (SELECT (array_agg(started_at ORDER BY started_at DESC))[(${input.hourRequestLimit}::int)] FROM app.tool_call_logs WHERE personal_account_id=${accountId} AND quota_reserved AND started_at>${hourStart} AND started_at<=${input.observedAt}) AS request_hour_reset,
             (SELECT count(*)::int FROM app.send_quota_reservations WHERE mcp_authorization_id=${input.authorizationId} AND reserved_at>${minuteStart} AND reserved_at<=${input.observedAt}) AS send_minute,
             (SELECT (array_agg(reserved_at ORDER BY reserved_at DESC))[(${input.sendPerMinuteLimit}::int)] FROM app.send_quota_reservations WHERE mcp_authorization_id=${input.authorizationId} AND reserved_at>${minuteStart} AND reserved_at<=${input.observedAt}) AS send_minute_reset,
             (SELECT count(*)::int FROM app.send_quota_reservations WHERE personal_account_id=${accountId} AND reserved_at>=${dayStart} AND reserved_at<=${input.observedAt}) AS send_day`,
        );
        const q = quotas[0] ?? {};
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
              new Date(date(q.request_minute_reset).valueOf() + 60_000),
            );
          if (Number(q.request_hour) >= input.hourRequestLimit)
            candidates.push(
              new Date(date(q.request_hour_reset).valueOf() + 3_600_000),
            );
          if (Number(q.send_minute) >= input.sendPerMinuteLimit)
            candidates.push(
              new Date(date(q.send_minute_reset).valueOf() + 60_000),
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
        await db.insert(toolCallLogsInApp).values({
          id: input.auditLogId,
          personalAccountId: accountId,
          mcpAuthorizationId: input.authorizationId,
          toolName: "send_text_message",
          startedAt: input.observedAt.toISOString(),
          completedAt: null,
          outcome: "started",
          errorCode: null,
          resultCount: null,
          latencyMs: null,
          quotaReserved: true,
          expiresAt: sql`${input.observedAt}::timestamptz + interval '90 days'`,
          connectionPublicId: input.connectionPublicId,
          sendPublicId: input.sendPublicId,
        });
        const materialRows = await db.execute<Record<string, unknown>>(
          sql`SELECT * FROM app_private.load_send_key_material(${accountId},${connectionId})`,
        );
        const row = materialRows[0];
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
        const observedAt = input.observedAt.toISOString();
        await db.insert(sendOperationsInApp).values({
          id: input.sendId,
          publicId: input.sendPublicId,
          personalAccountId: accountId,
          mcpAuthorizationId: input.authorizationId,
          toolCallLogId: input.auditLogId,
          whatsappConnectionId: connectionId,
          recipientType,
          recipientPublicId: input.recipientPublicId,
          status: "processing",
          createdAt: observedAt,
          statusChangedAt: observedAt,
          attemptClaimedAt: observedAt,
          leaseExpiresAt: sql`${input.observedAt}::timestamptz + interval '30 seconds'`,
          expiresAt: sql`${input.observedAt}::timestamptz + interval '90 days'`,
        });
        await db.insert(sendIdempotencyBindingsInApp).values({
          personalAccountId: accountId,
          mcpAuthorizationId: input.authorizationId,
          idempotencyKey: input.idempotencyKey,
          sendOperationId: input.sendId,
          requestFingerprint: input.fingerprint,
          createdAt: observedAt,
          expiresAt: sql`${input.observedAt}::timestamptz + interval '90 days'`,
        });
        await db.insert(pendingSendContentsInApp).values({
          sendOperationId: input.sendId,
          personalAccountId: accountId,
          whatsappConnectionId: connectionId,
          ciphertextVersion: 1,
          keyVersion: pending.keyVersion,
          nonce: pending.nonce,
          ciphertext: pending.ciphertext,
          expiresAt: pendingExpiresAt.toISOString(),
        });
        await db.insert(sendQuotaReservationsInApp).values({
          sendOperationId: input.sendId,
          personalAccountId: accountId,
          mcpAuthorizationId: input.authorizationId,
          reservedAt: observedAt,
        });
        await db.execute(sql`COMMIT`);
        const recipientRow = recipient[0];
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
            contactPhone:
              recipientType === "contact" &&
              recipientRow.phone_ciphertext !== null &&
              recipientRow.phone_key_version !== null &&
              recipientRow.phone_nonce !== null
                ? {
                    ciphertext: bytes(recipientRow.phone_ciphertext),
                    keyVersion: integer(recipientRow.phone_key_version),
                    nonce: bytes(recipientRow.phone_nonce),
                  }
                : null,
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
        await db.execute(sql`ROLLBACK`);
        throw error;
      }
    }),
  expireLeases: (observedAt) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{ expired_count: unknown }>(
        "SELECT app_private.expire_send_dispatch_leases($1) AS expired_count",
        [observedAt],
      );
      const count = Number(result.rows[0]?.expired_count);
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error("invalid expired send lease count");
      return count;
    }),
  recordProviderOutcome: (input) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      await db.execute(sql`BEGIN`);
      const context = await db.execute<{ personal_account_id: unknown }>(
        sql`SELECT app_private.bootstrap_send_operation(${input.sendId}) AS personal_account_id`,
      );
      const accountId = context[0]?.personal_account_id;
      if (typeof accountId !== "string") {
        await db.execute(sql`ROLLBACK`);
        throw new Error("send operation unavailable");
      }
      await db.execute(
        sql`SELECT set_config('app.personal_account_id',${accountId},true)`,
      );
      const operationSelection = {
        id: sendOperationsInApp.id,
        public_id: sendOperationsInApp.publicId,
        personal_account_id: sendOperationsInApp.personalAccountId,
        whatsapp_connection_id: sendOperationsInApp.whatsappConnectionId,
        recipient_type: sendOperationsInApp.recipientType,
        recipient_public_id: sendOperationsInApp.recipientPublicId,
        status: sendOperationsInApp.status,
        created_at: sendOperationsInApp.createdAt,
        status_changed_at: sendOperationsInApp.statusChangedAt,
        lease_expires_at: sendOperationsInApp.leaseExpiresAt,
      };
      const result = await db
        .update(sendOperationsInApp)
        .set({
          status: input.status,
          statusChangedAt: input.changedAt.toISOString(),
          messageIdentity: input.messageIdentity ?? null,
        })
        .where(
          and(
            eq(sendOperationsInApp.id, input.sendId),
            eq(sendOperationsInApp.status, "processing"),
            gt(
              sendOperationsInApp.leaseExpiresAt,
              input.changedAt.toISOString(),
            ),
          ),
        )
        .returning(operationSelection);
      const operation =
        result[0] ??
        (
          await db
            .update(sendOperationsInApp)
            .set({
              status: "unknown",
              statusChangedAt: sendOperationsInApp.leaseExpiresAt,
            })
            .where(
              and(
                eq(sendOperationsInApp.id, input.sendId),
                eq(sendOperationsInApp.status, "processing"),
                lte(
                  sendOperationsInApp.leaseExpiresAt,
                  input.changedAt.toISOString(),
                ),
              ),
            )
            .returning(operationSelection)
        )[0] ??
        (
          await db
            .select(operationSelection)
            .from(sendOperationsInApp)
            .where(eq(sendOperationsInApp.id, input.sendId))
            .for("update")
        )[0];
      if (operation === undefined) {
        await db.execute(sql`ROLLBACK`);
        throw new Error("send operation unavailable");
      }
      if (
        result[0] !== undefined &&
        input.messageIdentity !== undefined &&
        input.storedMessage !== undefined &&
        ["sent", "delivered", "read"].includes(input.status)
      ) {
        const recipient = await db
          .select({
            recipient_type: sendOperationsInApp.recipientType,
            recipient_public_id: sendOperationsInApp.recipientPublicId,
            recipient_locator: sql<string>`CASE ${sendOperationsInApp.recipientType}
              WHEN 'contact' THEN ${directoryContactsInApp.providerIdentityIndex}
              ELSE ${whatsappGroupsInApp.providerLocator}
            END`,
          })
          .from(sendOperationsInApp)
          .leftJoin(
            directoryContactsInApp,
            and(
              eq(sendOperationsInApp.recipientType, "contact"),
              eq(
                directoryContactsInApp.personalAccountId,
                sendOperationsInApp.personalAccountId,
              ),
              eq(
                directoryContactsInApp.whatsappConnectionId,
                sendOperationsInApp.whatsappConnectionId,
              ),
              eq(
                directoryContactsInApp.publicId,
                sendOperationsInApp.recipientPublicId,
              ),
            ),
          )
          .leftJoin(
            whatsappGroupsInApp,
            and(
              eq(sendOperationsInApp.recipientType, "group"),
              eq(
                whatsappGroupsInApp.personalAccountId,
                sendOperationsInApp.personalAccountId,
              ),
              eq(
                whatsappGroupsInApp.whatsappConnectionId,
                sendOperationsInApp.whatsappConnectionId,
              ),
              eq(
                whatsappGroupsInApp.publicId,
                sendOperationsInApp.recipientPublicId,
              ),
            ),
          )
          .where(eq(sendOperationsInApp.id, input.sendId));
        const recipientLocator = scalar(recipient[0], "recipient_locator");
        const recipientType = scalar(recipient[0], "recipient_type");
        const recipientPublicId = scalar(recipient[0], "recipient_public_id");
        await db
          .insert(whatsappConversationsInApp)
          .values({
            id: input.storedMessage.conversationId,
            personalAccountId: scalar(operation, "personal_account_id"),
            whatsappConnectionId: scalar(operation, "whatsapp_connection_id"),
            publicId: input.storedMessage.conversationPublicId,
            kind: recipientType === "contact" ? "direct" : "group",
            recipientLocator,
            recipientPublicId,
            lastActivityAt: input.changedAt.toISOString(),
            lastActivityDirection: "outbound",
          })
          .onConflictDoNothing();
        const conversation = await db
          .select({ id: whatsappConversationsInApp.id })
          .from(whatsappConversationsInApp)
          .where(
            and(
              eq(
                whatsappConversationsInApp.personalAccountId,
                scalar(operation, "personal_account_id"),
              ),
              eq(
                whatsappConversationsInApp.whatsappConnectionId,
                scalar(operation, "whatsapp_connection_id"),
              ),
              eq(whatsappConversationsInApp.recipientLocator, recipientLocator),
            ),
          );
        const conversationId = scalar(conversation[0], "id");
        await db
          .insert(storedMessagesInApp)
          .values({
            id: input.storedMessage.messageId,
            personalAccountId: scalar(operation, "personal_account_id"),
            whatsappConnectionId: scalar(operation, "whatsapp_connection_id"),
            conversationId,
            publicId: input.storedMessage.messagePublicId,
            messageIdentity: input.messageIdentity,
            direction: "outbound",
            sentAt: input.changedAt.toISOString(),
            contentType: input.storedMessage.contentType,
            contentCiphertextVersion: 1,
            contentKeyVersion: input.storedMessage.content.keyVersion,
            contentNonce: input.storedMessage.content.nonce,
            contentCiphertext: input.storedMessage.content.ciphertext,
            receivedAt: input.changedAt.toISOString(),
            webhookItemIdentity: null,
          })
          .onConflictDoNothing();
        const latest = await db
          .select({
            direction: storedMessagesInApp.direction,
            sentAt: storedMessagesInApp.sentAt,
          })
          .from(storedMessagesInApp)
          .innerJoin(
            sendOperationsInApp,
            and(
              eq(
                sendOperationsInApp.personalAccountId,
                storedMessagesInApp.personalAccountId,
              ),
              eq(
                sendOperationsInApp.whatsappConnectionId,
                storedMessagesInApp.whatsappConnectionId,
              ),
            ),
          )
          .where(
            and(
              eq(sendOperationsInApp.id, input.sendId),
              eq(storedMessagesInApp.conversationId, conversationId),
              isNull(storedMessagesInApp.contentExpiredAt),
            ),
          )
          .orderBy(
            desc(storedMessagesInApp.sentAt),
            desc(storedMessagesInApp.publicId),
          )
          .limit(1);
        if (latest[0] !== undefined) {
          await db
            .update(whatsappConversationsInApp)
            .set({
              lastActivityAt: latest[0].sentAt,
              lastActivityDirection: latest[0].direction,
              updatedAt: sql`transaction_timestamp()`,
            })
            .where(eq(whatsappConversationsInApp.id, conversationId));
        }
        await db
          .delete(pendingSendContentsInApp)
          .where(eq(pendingSendContentsInApp.sendOperationId, input.sendId));
      }
      if (result[0] !== undefined && input.status === "failed") {
        await db
          .delete(pendingSendContentsInApp)
          .where(eq(pendingSendContentsInApp.sendOperationId, input.sendId));
      }
      await db.execute(sql`COMMIT`);
      try {
        await db.execute(sql`BEGIN`);
        await db.execute(
          sql`SELECT set_config('app.personal_account_id',${accountId},true)`,
        );
        const send = await db
          .select({ toolCallLogId: sendOperationsInApp.toolCallLogId })
          .from(sendOperationsInApp)
          .where(eq(sendOperationsInApp.id, input.sendId));
        await db
          .update(toolCallLogsInApp)
          .set({
            completedAt: input.changedAt.toISOString(),
            outcome: "success",
            resultCount: 1,
            latencyMs: sql`greatest(0,floor(extract(epoch FROM (${input.changedAt}::timestamptz-${toolCallLogsInApp.startedAt}))*1000)::int)`,
          })
          .where(eq(toolCallLogsInApp.id, scalar(send[0], "toolCallLogId")));
        await db.execute(sql`COMMIT`);
      } catch {
        await db.execute(sql`ROLLBACK`);
      }
      return receipt(operation);
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
        return await use(makeQueryConnection(client));
      } finally {
        await client.end();
      }
    },
  });
