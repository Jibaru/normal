import { makePgConnectionSetupRepository } from "@whatsapp-mcp/db/connection-setup";
import { Effect, Layer } from "effect";
import {
  ConnectionSetupPersistence,
  ConnectionSetupPersistenceError,
} from "./connection-setup";
import {
  ConnectionSetupCleanupPersistence,
  ConnectionSetupCleanupPersistenceError,
} from "./connection-setup-cleanup";
import {
  ConnectionSetupProvisioningPersistence,
  ConnectionSetupProvisioningPersistenceError,
} from "./connection-setup-provisioning";

export interface ConnectionSetupProductionEnvironment {
  readonly HYPERDRIVE?: { readonly connectionString: string } | undefined;
}

export const makeConnectionSetupPersistenceLayers = (
  environment: ConnectionSetupProductionEnvironment,
) => {
  const connectionString = environment.HYPERDRIVE?.connectionString;
  const repository =
    typeof connectionString === "string"
      ? makePgConnectionSetupRepository(connectionString)
      : null;
  const getRepository = () => {
    if (repository === null) throw new Error("database unavailable");
    return repository;
  };

  const setup = Layer.succeed(ConnectionSetupPersistence, {
    cancel: (input) =>
      Effect.tryPromise({
        try: () => getRepository().cancel(input),
        catch: () => new ConnectionSetupPersistenceError(),
      }),
    prepare: (input) =>
      Effect.tryPromise({
        try: () => getRepository().prepare(input),
        catch: () => new ConnectionSetupPersistenceError(),
      }),
    start: (input) =>
      Effect.tryPromise({
        try: () => getRepository().start(input),
        catch: () => new ConnectionSetupPersistenceError(),
      }),
  });

  const provisioning = Layer.succeed(ConnectionSetupProvisioningPersistence, {
    claim: (input) =>
      Effect.tryPromise({
        try: () => getRepository().claimProvisioning(input),
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
    finish: (input) =>
      Effect.tryPromise({
        try: () => getRepository().finishProvisioning(input),
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
    fail: (input) =>
      Effect.tryPromise({
        try: () => getRepository().failProvisioning(input),
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
    listCandidates: (input) =>
      Effect.tryPromise({
        try: () => getRepository().listProvisioningCandidates(input),
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
    release: (input) =>
      Effect.tryPromise({
        try: () => getRepository().releaseProvisioningLease(input),
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
    renew: (input) =>
      Effect.tryPromise({
        try: () => getRepository().renewProvisioningLease(input),
        catch: () => new ConnectionSetupProvisioningPersistenceError(),
      }),
  });

  const cleanup = Layer.succeed(ConnectionSetupCleanupPersistence, {
    claim: (input) =>
      Effect.tryPromise({
        try: () => getRepository().claimCleanup(input),
        catch: () => new ConnectionSetupCleanupPersistenceError(),
      }),
    finish: (input) =>
      Effect.tryPromise({
        try: () => getRepository().finishCleanup(input),
        catch: () => new ConnectionSetupCleanupPersistenceError(),
      }),
    listCandidates: (input) =>
      Effect.tryPromise({
        try: () => getRepository().listCleanupCandidates(input),
        catch: () => new ConnectionSetupCleanupPersistenceError(),
      }),
    release: (input) =>
      Effect.tryPromise({
        try: () => getRepository().releaseCleanupLease(input),
        catch: () => new ConnectionSetupCleanupPersistenceError(),
      }),
    renew: (input) =>
      Effect.tryPromise({
        try: () => getRepository().renewCleanupLease(input),
        catch: () => new ConnectionSetupCleanupPersistenceError(),
      }),
  });

  return { cleanup, provisioning, setup } as const;
};
