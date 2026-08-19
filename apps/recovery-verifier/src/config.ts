const unavailable = /example|placeholder|replace-with/iu;

export const required = (value: string | undefined, name: string): string => {
  if (!value || value.trim() !== value || unavailable.test(value))
    throw new Error(`${name} is unavailable`);
  return value;
};

export const safeHttpsUrl = (value: string | undefined, name: string): URL => {
  const url = new URL(required(value, name));
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error(`${name} must be a safe HTTPS URL`);
  return url;
};

export const verifyToken = async (
  provided: string | undefined,
  expected: string,
): Promise<boolean> => {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided ?? "")),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1)
    difference |= (providedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  return difference === 0;
};
