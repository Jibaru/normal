const encoder = new TextEncoder();

const decodeSecret = (secretHex: string): Uint8Array<ArrayBuffer> => {
  if (!/^[a-f0-9]{64}$/u.test(secretHex)) {
    throw new Error("API Key HMAC secret must be a 32-byte hex value");
  }
  const bytes = new Uint8Array(new ArrayBuffer(32));
  for (const [index, byte] of (secretHex.match(/../gu) ?? []).entries()) {
    bytes[index] = Number.parseInt(byte, 16);
  }
  return bytes;
};

export const digestApiKeyCredential = async (
  secretHex: string,
  credential: string,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeSecret(secretHex),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(credential)),
  );
};
