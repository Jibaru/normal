export const whatsappConnectionStates = [
  "connected",
  "connecting",
  "disconnected",
  "reconnect_required",
  "degraded",
  "deleting",
] as const;

export type WhatsAppConnectionState = (typeof whatsappConnectionStates)[number];

export const isWhatsAppConnectionState = (
  value: unknown,
): value is WhatsAppConnectionState =>
  typeof value === "string" &&
  whatsappConnectionStates.some((state) => state === value);

export const canStartNewSend = (state: WhatsAppConnectionState): boolean =>
  connectionSideEffectAvailability(state).decision === "allowed";

export type ConnectionSideEffectAvailability =
  | {
      readonly decision: "allowed";
    }
  | {
      readonly decision: "blocked";
      readonly reason: Exclude<WhatsAppConnectionState, "connected">;
    };

export const connectionSideEffectAvailability = (
  state: WhatsAppConnectionState,
): ConnectionSideEffectAvailability =>
  state === "connected"
    ? { decision: "allowed" }
    : { decision: "blocked", reason: state };
