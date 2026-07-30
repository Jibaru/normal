import { describe, expect, test } from "bun:test";
import packageManifest from "../package.json";

describe("@whatsapp-mcp/wasender boundaries", () => {
  test("exports control, session, and webhook seams without a catch-all barrel", () => {
    expect(Object.keys(packageManifest.exports).sort()).toEqual([
      "./control",
      "./session",
      "./webhook",
    ]);
    expect(packageManifest.exports).not.toHaveProperty(".");
  });
});
