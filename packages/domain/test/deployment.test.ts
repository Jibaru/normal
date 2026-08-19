import { describe, expect, test } from "bun:test";
import {
  deployableNames,
  isProductionDeploymentEnvironment,
} from "../src/deployment";

describe("deployment rules", () => {
  test("names every independently deployed application", () => {
    expect(deployableNames).toEqual([
      "web",
      "docs",
      "api",
      "provider-control",
      "deletion-coordinator",
      "restore-coordinator",
      "operations-control",
      "recovery-game-day",
      "recovery-verifier",
      "recovery-control",
    ]);
  });

  test("does not admit the test environment into a production composition root", () => {
    expect(isProductionDeploymentEnvironment("production")).toBe(true);
    expect(isProductionDeploymentEnvironment("test")).toBe(false);
  });
});
