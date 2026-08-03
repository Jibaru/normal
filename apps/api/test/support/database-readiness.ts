import { vi } from "vitest";

vi.mock("@whatsapp-mcp/db/connectivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whatsapp-mcp/db/connectivity")>()),
  checkDatabaseReadiness: vi.fn(async () => undefined),
}));
