export const whatsappConnectionStates = [
  "connected",
  "connecting",
  "disconnected",
  "reconnect_required",
  "degraded",
  "deleting",
] as const;

export type WhatsAppConnectionState = (typeof whatsappConnectionStates)[number];

export const normalizeWhatsAppConnectionName = (
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim().normalize("NFC");
  const containsControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
  const containsFormatControl = /\p{Cf}/u.test(name);
  return name.length > 0 &&
    name.length <= 64 &&
    !containsControlCharacter &&
    !containsFormatControl
    ? name
    : null;
};

export const isWhatsAppConnectionState = (
  value: unknown,
): value is WhatsAppConnectionState =>
  typeof value === "string" &&
  whatsappConnectionStates.some((state) => state === value);

export const canStartNewSend = (state: WhatsAppConnectionState): boolean =>
  state === "connected";

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
