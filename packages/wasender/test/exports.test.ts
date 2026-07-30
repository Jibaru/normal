import { describe, expect, test } from "bun:test";
import packageManifest from "../package.json";
import { jsonReadPolicy, textSendPolicy } from "../src/session";

describe("@whatsapp-mcp/wasender boundaries", () => {
  test("exports control, session, and webhook seams without a catch-all barrel", () => {
    expect(Object.keys(packageManifest.exports).sort()).toEqual([
      "./control",
      "./session",
      "./webhook",
    ]);
    expect(packageManifest.exports).not.toHaveProperty(".");
  });

  test("keeps retry policy operation-specific", () => {
    expect(jsonReadPolicy).toEqual({
      attemptTimeoutMs: 10_000,
      jittered: true,
      maxAttempts: 3,
      retryHttpStatuses: [408, 429, "5xx"],
      retryNetworkErrors: true,
      totalTimeoutMs: 25_000,
    });
    expect(textSendPolicy).toEqual({
      attemptTimeoutMs: 15_000,
      maxAttempts: 1,
      retryAmbiguousResult: false,
    });
  });
});
