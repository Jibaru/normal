export type DeploymentEnvironment = "development" | "preview" | "production";

export const isDeploymentEnvironment = (
  value: string | undefined,
): value is DeploymentEnvironment =>
  value === "development" || value === "preview" || value === "production";

export const parseApiOrigin = (value: string | undefined): URL | null => {
  if (value === undefined) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
      ? url
      : null;
  } catch {
    return null;
  }
};
