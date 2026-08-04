import { makePgWhatsAppConnectionRepository } from "@whatsapp-mcp/db/whatsapp-connection";
import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import { WhatsAppConnectionPersistence } from "../src/whatsapp-connection";
import { makeWhatsAppConnectionPersistenceLayer } from "../src/whatsapp-connection-production";

vi.mock("@whatsapp-mcp/db/whatsapp-connection", () => ({
  makePgWhatsAppConnectionRepository: vi.fn(),
}));

const repository = () => ({
  activate: vi.fn().mockResolvedValue({ id: "connection_1" }),
  claimLifecycle: vi.fn().mockResolvedValue(null),
  finishDeletion: vi.fn().mockResolvedValue(null),
  finishLifecycle: vi.fn().mockResolvedValue(null),
  listForUser: vi.fn().mockResolvedValue([]),
  loadSetupForActivation: vi.fn().mockResolvedValue(null),
  prepareDeletion: vi.fn().mockResolvedValue(null),
});

describe("WhatsApp Connection production persistence", () => {
  test("constructs one repository and maps all seven service methods", async () => {
    const adapter = repository();
    vi.mocked(makePgWhatsAppConnectionRepository).mockReturnValue(
      adapter as never,
    );
    const layer = makeWhatsAppConnectionPersistenceLayer({
      HYPERDRIVE: { connectionString: "postgresql://connections.test/db" },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const persistence = yield* WhatsAppConnectionPersistence;
        yield* persistence.activate({ marker: "activate" } as never);
        yield* persistence.claimLifecycle({ marker: "claim" } as never);
        yield* persistence.finishLifecycle({ marker: "lifecycle" } as never);
        yield* persistence.prepareDeletion({ marker: "prepare" } as never);
        yield* persistence.finishDeletion({ marker: "deletion" } as never);
        yield* persistence.list("user_1");
        yield* persistence.loadSetup({ marker: "setup" } as never);
      }).pipe(Effect.provide(layer)),
    );

    expect(makePgWhatsAppConnectionRepository).toHaveBeenCalledTimes(1);
    expect(makePgWhatsAppConnectionRepository).toHaveBeenCalledWith(
      "postgresql://connections.test/db",
    );
    expect(adapter.activate).toHaveBeenCalledWith({ marker: "activate" });
    expect(adapter.claimLifecycle).toHaveBeenCalledWith({ marker: "claim" });
    expect(adapter.finishLifecycle).toHaveBeenCalledWith({
      marker: "lifecycle",
    });
    expect(adapter.prepareDeletion).toHaveBeenCalledWith({ marker: "prepare" });
    expect(adapter.finishDeletion).toHaveBeenCalledWith({
      marker: "deletion",
    });
    expect(adapter.listForUser).toHaveBeenCalledWith("user_1");
    expect(adapter.loadSetupForActivation).toHaveBeenCalledWith({
      marker: "setup",
    });
  });

  test("fails lazily with the persistence error when config is missing", async () => {
    vi.mocked(makePgWhatsAppConnectionRepository).mockClear();
    const layer = makeWhatsAppConnectionPersistenceLayer({});

    expect(makePgWhatsAppConnectionRepository).not.toHaveBeenCalled();

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const persistence = yield* WhatsAppConnectionPersistence;
        return yield* persistence.list("user_1");
      }).pipe(Effect.provide(layer)),
    );

    expect(String(exit)).toContain("WhatsAppConnectionPersistenceError");
  });

  test("maps repository rejection to the persistence error", async () => {
    const adapter = repository();
    adapter.loadSetupForActivation.mockRejectedValueOnce(
      new Error("database rejected"),
    );
    vi.mocked(makePgWhatsAppConnectionRepository).mockReturnValue(
      adapter as never,
    );
    const layer = makeWhatsAppConnectionPersistenceLayer({
      HYPERDRIVE: { connectionString: "postgresql://connections.test/db" },
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const persistence = yield* WhatsAppConnectionPersistence;
        return yield* persistence.loadSetup({ marker: "setup" } as never);
      }).pipe(Effect.provide(layer)),
    );

    expect(String(exit)).toContain("WhatsAppConnectionPersistenceError");
  });
});
