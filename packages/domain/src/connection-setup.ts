const whatsappNumberPattern = /^\+[1-9]\d{7,14}$/u;
const allowedFormattingPattern = /^\+[0-9 ()-]+$/u;

export const normalizeWhatsAppNumber = (value: unknown): string | null => {
  if (
    typeof value !== "string" ||
    !allowedFormattingPattern.test(value) ||
    value.length > 64
  ) {
    return null;
  }

  const normalized = value.replaceAll(/[ ()-]/gu, "");
  return whatsappNumberPattern.test(normalized) ? normalized : null;
};

export const connectionSetupExpiresAt = (createdAt: string): string | null => {
  const createdAtMilliseconds = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMilliseconds)) {
    return null;
  }
  return new Date(createdAtMilliseconds + 15 * 60 * 1_000).toISOString();
};
