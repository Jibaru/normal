const placeholder = /example|placeholder|replace/iu;

export const required = (value: string | undefined, name: string) => {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 4_096 ||
    placeholder.test(value)
  )
    throw new Error(`${name} is unavailable`);
  return value;
};

export const safeOrigin = (value: string | undefined, name: string) => {
  if (!value || placeholder.test(value))
    throw new Error(`${name} is unavailable`);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error(`${name} is unavailable`);
  return url.origin;
};

const bytes = (value: string) => new TextEncoder().encode(value);

export const verifyToken = async (
  provided: string | undefined,
  expected: string,
) => {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", bytes(provided ?? "")),
    crypto.subtle.digest("SHA-256", bytes(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.byteLength ^ b.byteLength;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1)
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
};

export const canonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export const safeJson = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

export const readJson = async (request: Request): Promise<unknown> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 65_536) throw new Error("request is too large");
  const text = await request.text();
  if (text.length > 65_536) throw new Error("request is too large");
  return JSON.parse(text) as unknown;
};

export const exactKeys = (
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
};
