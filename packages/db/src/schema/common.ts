import { customType, pgTable } from "drizzle-orm/pg-core";

export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const directoryBlindIndex = customType<{ data: string }>({
  dataType: () => "public.directory_blind_index",
});

export const groupNameBlindIndex = customType<{ data: string }>({
  dataType: () => "public.group_name_blind_index",
});

export const publicSchema = { table: pgTable } as const;
