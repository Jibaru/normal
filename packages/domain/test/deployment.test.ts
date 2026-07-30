import { describe, expect, test } from "bun:test";
import {
  deployableNames,
  isProductionDeploymentEnvironment,
} from "../src/deployment";

describe("deployment rules", () => {
  test("names exactly the three independently deployed applications", () => {
    expect(deployableNames).toEqual(["web", "api", "provider-control"]);
  });

  test("does not admit the test environment into a production composition root", () => {
    expect(isProductionDeploymentEnvironment("production")).toBe(true);
    expect(isProductionDeploymentEnvironment("test")).toBe(false);
  });
});
