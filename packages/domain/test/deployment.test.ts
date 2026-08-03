import { describe, expect, test } from "bun:test";
import {
  deployableNames,
  isProductionDeploymentEnvironment,
} from "../src/deployment";

describe("deployment rules", () => {
  test("names every independently deployed application", () => {
    expect(deployableNames).toEqual([
      "web",
      "api",
      "provider-control",
      "deletion-coordinator",
    ]);
  });

  test("does not admit the test environment into a production composition root", () => {
    expect(isProductionDeploymentEnvironment("production")).toBe(true);
    expect(isProductionDeploymentEnvironment("test")).toBe(false);
  });
});
