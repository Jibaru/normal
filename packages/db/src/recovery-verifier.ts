import { sql } from "drizzle-orm";
import { makeDatabase, withPgQueryConnection } from "./database";
import { restrictedRecoveryVerifierConnectionString } from "./restricted-runtime-config";

export interface RecoveryVerification {
  readonly apiKeyOk: boolean;
  readonly auditOk: boolean;
  readonly deletionOk: boolean;
  readonly expiryOk: boolean;
  readonly invariantsOk: boolean;
  readonly objectIntentOk: boolean;
  readonly quotaOk: boolean;
  readonly rlsOk: boolean;
  readonly recipientContentOk: boolean;
  readonly recipientCutoffOk: boolean;
  readonly recipientTransitionOk: boolean;
  readonly schemaOk: boolean;
}

export interface RecoveryVerifierRepository {
  readonly completeRlsProbe: (
    branchId: string,
    firstAccountId: string,
    secondAccountId: string,
  ) => Promise<void>;
  readonly complete: (branchId: string, verifiedAt: string) => Promise<void>;
  readonly prepareRlsProbe: (
    branchId: string,
    firstAccountId: string,
    secondAccountId: string,
  ) => Promise<boolean>;
  readonly prepareMediaLossProbe: (
    branchId: string,
    accountId: string,
    connectionId: string,
    conversationId: string,
    messageId: string,
    mediaId: string,
    authorizationId: string,
    auditLogId: string,
  ) => Promise<boolean>;
  readonly verifyMediaLossProbe: (
    branchId: string,
    accountId: string,
    mediaId: string,
    auditLogId: string,
  ) => Promise<boolean>;
  readonly verify: (
    branchId: string,
    observedAt: string,
  ) => Promise<RecoveryVerification>;
}

export const makePgRecoveryVerifierRepository = (
  connectionString: string,
): RecoveryVerifierRepository => {
  const restrictedConnectionString =
    restrictedRecoveryVerifierConnectionString(connectionString);

  return {
    completeRlsProbe: (branchId, firstAccountId, secondAccountId) =>
      withPgQueryConnection(
        restrictedConnectionString,
        async (connection) => {
          await makeDatabase(connection).execute(sql`
            SELECT public.complete_recovery_rls_probe(
              ${branchId}, ${firstAccountId}, ${secondAccountId}
            )
          `);
        },
        30_000,
        10_000,
      ),
    complete: (branchId, verifiedAt) =>
      withPgQueryConnection(
        restrictedConnectionString,
        async (connection) => {
          await makeDatabase(connection).execute(sql`
            SELECT public.complete_recovery_drill_verification(
              ${branchId}, ${verifiedAt}
            )
          `);
        },
        30_000,
        10_000,
      ),
    prepareRlsProbe: (branchId, firstAccountId, secondAccountId) =>
      withPgQueryConnection(
        restrictedConnectionString,
        async (connection) => {
          const result = await makeDatabase(connection).execute<{
            prepared: boolean;
          }>(sql`
            SELECT public.prepare_recovery_rls_probe(
              ${branchId}, ${firstAccountId}, ${secondAccountId}
            ) AS prepared
          `);
          const prepared = result[0]?.prepared;
          if (prepared !== true && prepared !== false)
            throw new Error("recovery RLS probe returned no result");
          return prepared;
        },
        30_000,
        10_000,
      ),
    prepareMediaLossProbe: (
      branchId,
      accountId,
      connectionId,
      conversationId,
      messageId,
      mediaId,
      authorizationId,
      auditLogId,
    ) =>
      withPgQueryConnection(
        restrictedConnectionString,
        async (connection) => {
          const result = await makeDatabase(connection).execute<{
            prepared: boolean;
          }>(sql`
            SELECT public.prepare_recovery_media_loss_probe(
              ${branchId}, ${accountId}, ${connectionId}, ${conversationId},
              ${messageId}, ${mediaId}, ${authorizationId}, ${auditLogId}
            ) AS prepared
          `);
          const prepared = result[0]?.prepared;
          if (prepared !== true && prepared !== false)
            throw new Error("recovery Stored Media probe returned no result");
          return prepared;
        },
        30_000,
        10_000,
      ),
    verifyMediaLossProbe: (branchId, accountId, mediaId, auditLogId) =>
      withPgQueryConnection(
        restrictedConnectionString,
        async (connection) => {
          const result = await makeDatabase(connection).execute<{
            verified: boolean;
          }>(sql`
            SELECT public.verify_recovery_media_loss_probe(
              ${branchId}, ${accountId}, ${mediaId}, ${auditLogId}
            ) AS verified
          `);
          return result[0]?.verified === true;
        },
        30_000,
        10_000,
      ),
    verify: (branchId, observedAt) =>
      withPgQueryConnection(
        restrictedConnectionString,
        async (connection) => {
          const result = await makeDatabase(connection).execute<{
            api_key_ok: boolean;
            audit_ok: boolean;
            deletion_ok: boolean;
            expiry_ok: boolean;
            invariants_ok: boolean;
            object_intent_ok: boolean;
            quota_ok: boolean;
            rls_ok: boolean;
            recipient_content_ok: boolean;
            recipient_cutoff_ok: boolean;
            recipient_transition_ok: boolean;
            schema_ok: boolean;
          }>(sql`
            SELECT * FROM public.verify_recovery_branch(
              ${branchId}, ${observedAt}
            )
          `);
          const verification = result[0];
          if (verification === undefined)
            throw new Error("recovery verification returned no result");
          return {
            apiKeyOk: verification.api_key_ok === true,
            auditOk: verification.audit_ok === true,
            deletionOk: verification.deletion_ok === true,
            expiryOk: verification.expiry_ok === true,
            invariantsOk: verification.invariants_ok === true,
            objectIntentOk: verification.object_intent_ok === true,
            quotaOk: verification.quota_ok === true,
            rlsOk: verification.rls_ok === true,
            recipientContentOk: verification.recipient_content_ok === true,
            recipientCutoffOk: verification.recipient_cutoff_ok === true,
            recipientTransitionOk:
              verification.recipient_transition_ok === true,
            schemaOk: verification.schema_ok === true,
          };
        },
        30_000,
        10_000,
      ),
  };
};

export const verifyRecoveryRlsIsolation = (
  connectionString: string,
  firstAccountId: string,
  secondAccountId: string,
): Promise<void> =>
  withPgQueryConnection(
    connectionString,
    async (connection) => {
      const visibleProbeAccounts = async (accountId?: string) => {
        await connection.query("BEGIN");
        try {
          if (accountId !== undefined) {
            await connection.query(
              "SELECT pg_catalog.set_config('public.personal_account_id', $1, true)",
              [accountId],
            );
          }
          return await connection.query<{ id: string }>(
            `SELECT id::text FROM public.personal_accounts
             WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [[firstAccountId, secondAccountId]],
          );
        } finally {
          await connection.query("ROLLBACK");
        }
      };

      const withoutContext = await visibleProbeAccounts();
      const first = await visibleProbeAccounts(firstAccountId);
      const second = await visibleProbeAccounts(secondAccountId);
      if (
        withoutContext.rows.length !== 0 ||
        first.rows.length !== 1 ||
        first.rows[0]?.id !== firstAccountId ||
        second.rows.length !== 1 ||
        second.rows[0]?.id !== secondAccountId
      ) {
        throw new Error("recovery RLS isolation failed");
      }
    },
    30_000,
    10_000,
  );
