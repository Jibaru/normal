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
  readonly complete: (branchId: string, verifiedAt: string) => Promise<void>;
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
