import { describe, expect, test } from "bun:test";
import {
  connectionSetupExpiresAt,
  normalizeWhatsAppNumber,
} from "../src/connection-setup";

describe("Connection Setup rules", () => {
  test("normalizes an explicitly international WhatsApp Number", () => {
    expect(normalizeWhatsAppNumber("+1 (555) 012-3456")).toBe("+15550123456");
    expect(normalizeWhatsAppNumber("+44 20 7946 0958")).toBe("+442079460958");
  });

  test.each([
    "",
    "15550123456",
    "+0123456789",
    "+1234567",
    "+1234567890123456",
    "+1 555 CALL-NOW",
    "+1.555.012.3456",
    "+1 555 012 3456 ext 7",
  ])("rejects a non-E.164 WhatsApp Number: %s", (value) => {
    expect(normalizeWhatsAppNumber(value)).toBeNull();
  });

  test("expires a Connection Setup exactly 15 minutes after creation", () => {
    expect(connectionSetupExpiresAt("2026-07-31T12:00:00.000Z")).toBe(
      "2026-07-31T12:15:00.000Z",
    );
    expect(connectionSetupExpiresAt("not-a-timestamp")).toBeNull();
  });
});
