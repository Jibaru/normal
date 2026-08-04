import { makePgConnectionSetupRepository } from "@whatsapp-mcp/db/connection-setup";
import { Effect, Layer } from "effect";
import { describe, expect, test, vi } from "vitest";
import { ConnectionSetupPersistence } from "../src/connection-setup";
import { ConnectionSetupCleanupPersistence } from "../src/connection-setup-cleanup";
import { makeConnectionSetupPersistenceLayers } from "../src/connection-setup-production";
import { ConnectionSetupProvisioningPersistence } from "../src/connection-setup-provisioning";

vi.mock("@whatsapp-mcp/db/connection-setup", () => ({
  makePgConnectionSetupRepository: vi.fn(),
}));

const rejection = new Error("repository unavailable");

const rejectingRepository = () => ({
  cancel: vi.fn().mockRejectedValue(rejection),
  claimCleanup: vi.fn().mockRejectedValue(rejection),
  claimProvisioning: vi.fn().mockRejectedValue(rejection),
  failProvisioning: vi.fn().mockRejectedValue(rejection),
  finishCleanup: vi.fn().mockRejectedValue(rejection),
  finishProvisioning: vi.fn().mockRejectedValue(rejection),
  listCleanupCandidates: vi.fn().mockRejectedValue(rejection),
  listProvisioningCandidates: vi.fn().mockRejectedValue(rejection),
  prepare: vi.fn().mockRejectedValue(rejection),
  releaseCleanupLease: vi.fn().mockRejectedValue(rejection),
  releaseProvisioningLease: vi.fn().mockRejectedValue(rejection),
  renewCleanupLease: vi.fn().mockRejectedValue(rejection),
  renewProvisioningLease: vi.fn().mockRejectedValue(rejection),
  start: vi.fn().mockRejectedValue(rejection),
});

describe("Connection Setup production persistence", () => {
  test("constructs one repository for all three persistence layers", () => {
    vi.mocked(makePgConnectionSetupRepository).mockReturnValue(
      rejectingRepository() as never,
    );

    makeConnectionSetupPersistenceLayers({
      HYPERDRIVE: { connectionString: "postgresql://connection-setup.test/db" },
    });

    expect(makePgConnectionSetupRepository).toHaveBeenCalledTimes(1);
    expect(makePgConnectionSetupRepository).toHaveBeenCalledWith(
      "postgresql://connection-setup.test/db",
    );
  });

  test("maps missing configuration lazily to each role specific error", async () => {
    vi.mocked(makePgConnectionSetupRepository).mockClear();
    const layers = makeConnectionSetupPersistenceLayers({});
    const layer = Layer.mergeAll(
      layers.setup,
      layers.provisioning,
      layers.cleanup,
    );

    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* ConnectionSetupPersistence;
        const provisioning = yield* ConnectionSetupProvisioningPersistence;
        const cleanup = yield* ConnectionSetupCleanupPersistence;
        return yield* Effect.all([
          Effect.exit(
            setup.cancel({
              cancelledAt: "2026-08-04T00:00:00.000Z",
              clerkUserId: "user_1",
              setupId: "setup_1",
            }),
          ),
          Effect.exit(
            provisioning.claim({
              claimedAt: "2026-08-04T00:00:00.000Z",
              setupId: "setup_1",
              workerId: "worker_1",
            }),
          ),
          Effect.exit(
            cleanup.claim({
              claimedAt: "2026-08-04T00:00:00.000Z",
              setupId: "setup_1",
              workerId: "worker_1",
            }),
          ),
        ]);
      }).pipe(Effect.provide(layer)),
    );

    expect(makePgConnectionSetupRepository).not.toHaveBeenCalled();
    expect(exits.map((exit) => String(exit))).toEqual([
      expect.stringContaining("ConnectionSetupPersistenceError"),
      expect.stringContaining("ConnectionSetupProvisioningPersistenceError"),
      expect.stringContaining("ConnectionSetupCleanupPersistenceError"),
    ]);
  });

  test("maps repository rejections to the setup persistence error", async () => {
    vi.mocked(makePgConnectionSetupRepository).mockReturnValue(
      rejectingRepository() as never,
    );
    const { setup } = makeConnectionSetupPersistenceLayers({
      HYPERDRIVE: { connectionString: "postgresql://connection-setup.test/db" },
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const persistence = yield* ConnectionSetupPersistence;
        return yield* persistence.cancel({
          cancelledAt: "2026-08-04T00:00:00.000Z",
          clerkUserId: "user_1",
          setupId: "setup_1",
        });
      }).pipe(Effect.provide(setup)),
    );

    expect(String(exit)).toContain("ConnectionSetupPersistenceError");
  });
});
