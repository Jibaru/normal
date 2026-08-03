export const deployableNames = [
  "web",
  "api",
  "provider-control",
  "deletion-coordinator",
] as const;

export type DeployableName = (typeof deployableNames)[number];

export const productionDeploymentEnvironments = [
  "development",
  "preview",
  "production",
] as const;

export type ProductionDeploymentEnvironment =
  (typeof productionDeploymentEnvironments)[number];

export type DeploymentEnvironment = ProductionDeploymentEnvironment | "test";

export const isProductionDeploymentEnvironment = (
  value: string,
): value is ProductionDeploymentEnvironment =>
  productionDeploymentEnvironments.some((environment) => environment === value);
