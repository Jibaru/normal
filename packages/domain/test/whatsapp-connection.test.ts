import { describe, expect, test } from "bun:test";
import {
  canStartNewSend,
  connectionSideEffectAvailability,
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

  test("provides one stable availability decision for unsafe new side effects", () => {
    expect(connectionSideEffectAvailability("connected")).toEqual({
      decision: "allowed",
    });
    for (const state of whatsappConnectionStates.filter(
      (candidate) => candidate !== "connected",
    )) {
      expect(connectionSideEffectAvailability(state)).toEqual({
        decision: "blocked",
        reason: state,
      });
    }
  });
});
