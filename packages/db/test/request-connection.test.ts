import { describe, expect, test } from "bun:test";
import { makeRequestConnectionManager } from "../src/request-connection";

describe("request connection manager", () => {
  test("reuses one connection within a request and closes it afterward", async () => {
    let connectCount = 0;
    let closeCount = 0;
    const manager = makeRequestConnectionManager({
      close: async () => {
        closeCount += 1;
      },
      connect: async (key: string) => ({ id: ++connectCount, key }),
    });

    await manager.run(async () => {
      const first = await manager.withConnection(
        "database",
        async (client) => client.id,
      );
      const second = await manager.withConnection(
        "database",
        async (client) => client.id,
      );
      expect(first).toBe(second);
      expect(connectCount).toBe(1);
      expect(closeCount).toBe(0);
    });

    expect(closeCount).toBe(1);
  });

  test("keeps unscoped calls isolated", async () => {
    let connectCount = 0;
    let closeCount = 0;
    const manager = makeRequestConnectionManager({
      close: async () => {
        closeCount += 1;
      },
      connect: async () => ({ id: ++connectCount }),
    });

    await manager.withConnection("database", async () => undefined);
    await manager.withConnection("database", async () => undefined);

    expect(connectCount).toBe(2);
    expect(closeCount).toBe(2);
  });

  test("isolates deferred work after the request scope closes", async () => {
    let connectCount = 0;
    let closeCount = 0;
    const releaseDeferred = Promise.withResolvers<void>();
    let deferred: Promise<number> | undefined;
    const manager = makeRequestConnectionManager({
      close: async () => {
        closeCount += 1;
      },
      connect: async () => ({ id: ++connectCount }),
    });

    await manager.run(async () => {
      await manager.withConnection("database", async () => undefined);
      deferred = (async () => {
        await releaseDeferred.promise;
        return manager.withConnection("database", async (client) => client.id);
      })();
    });

    expect(connectCount).toBe(1);
    expect(closeCount).toBe(1);
    releaseDeferred.resolve();
    await expect(deferred).resolves.toBe(2);
    expect(connectCount).toBe(2);
    expect(closeCount).toBe(2);
  });
});
