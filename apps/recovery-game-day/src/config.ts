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
