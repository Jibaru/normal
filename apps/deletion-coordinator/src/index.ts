import { KMSClient } from "@aws-sdk/client-kms";
import {
  makeDeletionCapsuleCoordinator,
  makeDeletionCapsuleCoordinatorStore,
} from "@whatsapp-mcp/api/deletion/capsule";
import { makeAwsDeletionCapsuleKmsReader } from "@whatsapp-mcp/api/encryption/aws-kms";
import type { ProviderControlService } from "@whatsapp-mcp/contracts/provider-control";
import { restrictedDeletionRuntimeConnectionString } from "@whatsapp-mcp/db/config";
import { makePgWhatsAppConnectionRepository } from "@whatsapp-mcp/db/whatsapp-connection";
import { Effect } from "effect";

interface Environment {
  readonly AWS_ACCESS_KEY_ID: string;
  readonly AWS_SECRET_ACCESS_KEY: string;
  readonly AWS_SESSION_TOKEN: string;
  readonly AWS_KMS_REGION: string;
  readonly DELETION_CAPSULES: R2Bucket;
  readonly DELETION_COORDINATOR_DATABASE_URL: string;
  readonly KMS_DELETION_COORDINATOR_KEY_ARN: string;
  readonly PROVIDER_CONTROL: ProviderControlService;
  readonly ENVIRONMENT: "development" | "preview" | "production";
}

const required = (value: string | undefined, name: string): string => {
  if (!value || /example|placeholder|replace/iu.test(value)) {
    throw new Error(`${name} is unavailable`);
  }
  return value;
};

const deletionKeyArn = (value: string): string => {
  if (!/^arn:aws:kms:us-east-1:[0-9]{12}:key\/[0-9a-f-]{36}$/u.test(value)) {
    throw new Error("Deletion coordinator KMS key is invalid");
  }
  return value;
};

const scheduled: ExportedHandlerScheduledHandler<Environment> = async (
  controller,
  environment,
) => {
  if (environment.AWS_KMS_REGION !== "us-east-1") {
    throw new Error("Deletion coordinator KMS region is invalid");
  }
  if (
    !(["development", "preview", "production"] as const).includes(
      environment.ENVIRONMENT,
    )
  ) {
    throw new Error("Deletion coordinator environment is invalid");
  }
  const connectionString = restrictedDeletionRuntimeConnectionString(
    required(
      environment.DELETION_COORDINATOR_DATABASE_URL,
      "Deletion coordinator database",
    ),
  );
  const repository = makePgWhatsAppConnectionRepository(connectionString);
  const observedAt = new Date(controller.scheduledTime).toISOString();
  const candidates = await repository.listDeletionCandidates({
    limit: 100,
    observedAt,
  });
  const kms = new KMSClient({
    credentials: {
      accessKeyId: required(environment.AWS_ACCESS_KEY_ID, "AWS access key"),
      secretAccessKey: required(
        environment.AWS_SECRET_ACCESS_KEY,
        "AWS secret access key",
      ),
      sessionToken: required(
        environment.AWS_SESSION_TOKEN,
        "AWS session token",
      ),
    },
    region: environment.AWS_KMS_REGION,
  });
  const capsules = makeDeletionCapsuleCoordinatorStore({
    bucket: environment.DELETION_CAPSULES,
    environment: environment.ENVIRONMENT,
    keyId: deletionKeyArn(
      required(
        environment.KMS_DELETION_COORDINATOR_KEY_ARN,
        "Deletion coordinator KMS key",
      ),
    ),
  });
  const coordinator = makeDeletionCapsuleCoordinator({
    capsuleStore: capsules,
    kmsReader: makeAwsDeletionCapsuleKmsReader(kms),
    confirmProviderAbsence: ({ deletionMarkerId }) =>
      Effect.tryPromise({
        try: async () => ({
          state: (await repository.confirmProviderAbsence({
            confirmedAt: observedAt,
            deletionMarkerId,
          }))
            ? ("complete" as const)
            : ("pending" as const),
        }),
        catch: (error) => error,
      }),
    reconcileProviderAbsence: ({ sessionLocator }) =>
      Effect.tryPromise({
        try: async () => {
          const result = await environment.PROVIDER_CONTROL.deleteSession({
            session: sessionLocator,
          });
          if (!result.ok) throw new Error(result.error.code);
          return result.value;
        },
        catch: (error) => error,
      }),
  });
  await Promise.all(
    candidates.map(async (candidate) => {
      if (candidate.deadlineRisk) {
        console.error(
          JSON.stringify({
            deadlineAt: candidate.deadlineAt,
            event: "whatsapp_connection.deletion.deadline_risk",
            marker: candidate.deletionMarkerId,
            service: "deletion-coordinator",
          }),
        );
      }
      try {
        const result = await Effect.runPromise(
          coordinator.reconcile({
            deletionMarkerId: candidate.deletionMarkerId,
          }),
        );
        console.info(
          JSON.stringify({
            event: "whatsapp_connection.deletion.reconciled",
            marker: candidate.deletionMarkerId,
            outcome: result.state,
            service: "deletion-coordinator",
          }),
        );
      } catch {
        console.error(
          JSON.stringify({
            event: "whatsapp_connection.deletion.reconciled",
            marker: candidate.deletionMarkerId,
            outcome: "retry",
            service: "deletion-coordinator",
          }),
        );
      }
    }),
  );
};

export default { scheduled } satisfies ExportedHandler<Environment>;
