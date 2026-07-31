import { describe, expect, test } from "bun:test";
import {
  canStartNewSend,
  isWhatsAppConnectionState,
  whatsappConnectionStates,
} from "../src/whatsapp-connection";

describe("WhatsApp Connection state", () => {
  test("keeps the complete stable lifecycle vocabulary", () => {
    expect(whatsappConnectionStates).toEqual([
      "connected",
      "connecting",
      "disconnected",
      "reconnect_required",
      "degraded",
      "deleting",
    ]);
    for (const state of whatsappConnectionStates) {
      expect(isWhatsAppConnectionState(state)).toBe(true);
    }
    expect(isWhatsAppConnectionState("active")).toBe(false);
  });

  test("allows new sends only while connected", () => {
    expect(
      whatsappConnectionStates.filter((state) => canStartNewSend(state)),
    ).toEqual(["connected"]);
  });
});
