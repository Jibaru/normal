import type {
  WhatsAppConnectionDeletionObjects,
  WhatsAppConnectionRepository,
} from "@whatsapp-mcp/db/whatsapp-connection";
import { Effect } from "effect";

export interface DeletionObjectStore {
  readonly delete: (key: string) => Promise<void>;
}

export interface ConnectionDeletionCleanupPersistence {
  readonly finish: (input: {
    readonly deletionMarkerId: string;
    readonly providerAbsenceConfirmedAt: string;
  }) => Promise<boolean>;
  readonly finishStoredMediaObjectDeletion: (input: {
    readonly objectKey: string;
    readonly personalAccountId: string;
  }) => Promise<void>;
  readonly finishWebhookSourceDeletion: (input: {
    readonly deletionMarkerId: string;
    readonly objectKey: string;
  }) => Promise<boolean>;
  readonly prepare: (input: {
    readonly deletionMarkerId: string;
    readonly limit: number;
    readonly requestedAt: string;
  }) => Promise<WhatsAppConnectionDeletionObjects | null>;
}

export const makeConnectionDeletionCleanupPersistence = (
  connections: Pick<
    WhatsAppConnectionRepository,
    | "finishDeletionCleanup"
    | "finishWebhookSourceDeletion"
    | "prepareDeletionCleanup"
  >,
  finishStoredMediaObjectDeletion: ConnectionDeletionCleanupPersistence["finishStoredMediaObjectDeletion"],
): ConnectionDeletionCleanupPersistence => ({
  finish: (input) => connections.finishDeletionCleanup(input),
  finishStoredMediaObjectDeletion,
  finishWebhookSourceDeletion: (input) =>
    connections.finishWebhookSourceDeletion(input),
  prepare: (input) => connections.prepareDeletionCleanup(input),
});

export const makeConnectionDeletionActiveDataPurger =
  ({
    clock,
    persistence,
    storedMedia,
    webhookSources,
  }: {
    readonly clock: () => string;
    readonly persistence: ConnectionDeletionCleanupPersistence;
    readonly storedMedia: DeletionObjectStore;
    readonly webhookSources: DeletionObjectStore;
  }) =>
  ({ deletionMarkerId }: { readonly deletionMarkerId: string }) =>
    Effect.tryPromise({
      try: async () => {
        const observedAt = clock();
        const objects = await persistence.prepare({
          deletionMarkerId,
          limit: 100,
          requestedAt: observedAt,
        });
        if (objects === null) return { state: "complete" as const };
        for (const objectKey of objects.storedMediaObjectKeys) {
          await storedMedia.delete(objectKey);
          await persistence.finishStoredMediaObjectDeletion({
            objectKey,
            personalAccountId: objects.personalAccountId,
          });
        }
        for (const objectKey of objects.webhookSourceObjectKeys) {
          await webhookSources.delete(objectKey);
          if (
            !(await persistence.finishWebhookSourceDeletion({
              deletionMarkerId,
              objectKey,
            }))
          ) {
            throw new Error("Webhook Event source deletion was not recorded");
          }
        }
        const complete = await persistence.finish({
          deletionMarkerId,
          providerAbsenceConfirmedAt: observedAt,
        });
        return {
          state: complete ? ("complete" as const) : ("pending" as const),
        };
      },
      catch: (error) => error,
    });
