import { AsyncLocalStorage } from "node:async_hooks";
import type { Client as PgClient } from "pg";

interface ConnectionScope<Client> {
  active: boolean;
  readonly connections: Map<string, Promise<Client>>;
}

interface RequestConnectionManager<Client> {
  readonly run: <Value>(use: () => Promise<Value>) => Promise<Value>;
  readonly withConnection: <Value>(
    key: string,
    use: (client: Client) => Promise<Value>,
  ) => Promise<Value>;
}

export const makeRequestConnectionManager = <Client>(input: {
  readonly close: (client: Client) => Promise<void>;
  readonly connect: (key: string) => Promise<Client>;
}): RequestConnectionManager<Client> => {
  const storage = new AsyncLocalStorage<ConnectionScope<Client>>();

  const acquire = (scope: ConnectionScope<Client>, key: string) => {
    const existing = scope.connections.get(key);
    if (existing !== undefined) return existing;
    const connected = input.connect(key);
    scope.connections.set(key, connected);
    return connected;
  };

  return {
    run: async (use) => {
      if (storage.getStore() !== undefined) return use();
      const scope: ConnectionScope<Client> = {
        active: true,
        connections: new Map(),
      };
      return storage.run(scope, async () => {
        try {
          return await use();
        } finally {
          scope.active = false;
          const clients = await Promise.allSettled(scope.connections.values());
          await Promise.allSettled(
            clients.flatMap((client) =>
              client.status === "fulfilled" ? [input.close(client.value)] : [],
            ),
          );
        }
      });
    },
    withConnection: async (key, use) => {
      const scope = storage.getStore();
      if (scope?.active === true) return use(await acquire(scope, key));
      const client = await input.connect(key);
      try {
        return await use(client);
      } finally {
        await input.close(client);
      }
    },
  };
};

const pgRequestConnections = makeRequestConnectionManager<PgClient>({
  close: (client) => client.end(),
  connect: async (connectionString) => {
    const { Client } = await import("pg");
    const client: PgClient = new Client({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
    });
    await client.connect();
    return client;
  },
});

export const withPgRequestConnectionScope = pgRequestConnections.run;

export const withPgRequestConnection = pgRequestConnections.withConnection;
