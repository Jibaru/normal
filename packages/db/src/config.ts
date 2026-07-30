import { Config } from "effect";

export const databaseConfig = Config.all({
  databaseUrl: Config.redacted("DATABASE_URL"),
});
