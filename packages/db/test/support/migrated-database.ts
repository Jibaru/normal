import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../../src/migrations";

const migratedDatabaseSnapshot = (async (): Promise<Blob> => {
  const database = new PGlite({ relaxedDurability: true });
  await database.exec(`
    CREATE ROLE neon_superuser NOLOGIN BYPASSRLS;
    CREATE ROLE whatsapp_api_runtime LOGIN;
    CREATE ROLE whatsapp_webhook_runtime LOGIN;
    GRANT neon_superuser TO whatsapp_api_runtime;
    GRANT neon_superuser TO whatsapp_webhook_runtime;
  `);
  await runMigrations(database);
  const snapshot = await database.dumpDataDir();
  await database.close();
  return snapshot;
})();

export const createMigratedDatabase = async (): Promise<PGlite> => {
  const database = new PGlite({
    loadDataDir: await migratedDatabaseSnapshot,
    relaxedDurability: true,
  });
  await database.waitReady;
  return database;
};
