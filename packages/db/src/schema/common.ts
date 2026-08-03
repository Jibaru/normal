import { customType, pgSchema } from "drizzle-orm/pg-core";

export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const directoryBlindIndex = customType<{ data: string }>({
  dataType: () => "app.directory_blind_index",
});

export const groupNameBlindIndex = customType<{ data: string }>({
  dataType: () => "app.group_name_blind_index",
});

export const appPrivate = pgSchema("app_private");
export const app = pgSchema("app");
