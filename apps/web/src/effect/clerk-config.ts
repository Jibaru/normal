export const CLERK_JWT_TEMPLATE = "whatsapp-api";

export const isClerkPublishableKey = (value: unknown): value is string =>
  typeof value === "string" &&
  /^pk_(?:test|live)_[A-Za-z0-9_-]{20,}\$?$/.test(value);
