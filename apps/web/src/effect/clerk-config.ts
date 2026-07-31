export const isClerkPublishableKey = (value: unknown): value is string =>
  typeof value === "string" &&
  /^pk_(?:test|live)_[A-Za-z0-9_-]{20,}\$?$/.test(value);

export const isClerkJwtTemplate = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
