import { describe, expect, test } from "bun:test";
import {
  loadObservabilityConfig,
  validateObservabilityConfig,
} from "./validate-observability";

describe("production observability configuration", () => {
  test("covers the operational surface with separate availability objectives", async () => {
    const config = await loadObservabilityConfig();
    expect(() => validateObservabilityConfig(config)).not.toThrow();

    expect(config.slos.map(({ id }) => id)).toEqual([
      "first-party-availability",
      "wasender-availability",
      "whatsapp-availability",
    ]);
    expect(config.slos[0]).toMatchObject({ objective: 99.5, window: "30d" });
  });

  test("rejects sensitive dimensions and incomplete alert delivery", async () => {
    const config = await loadObservabilityConfig();
    const unsafe = structuredClone(config);
    unsafe.dashboards[0]?.panels[0]?.groupBy.push("personalAccountId");
    expect(() => validateObservabilityConfig(unsafe)).toThrow(
      "field personalAccountId is not telemetry-allowlisted",
    );

    const invented = structuredClone(config);
    invented.sources.workerTelemetry.fields.push("tenantHash");
    expect(() => validateObservabilityConfig(invented)).toThrow(
      "field tenantHash is not runtime telemetry-allowlisted",
    );

    const noCanary = structuredClone(config);
    noCanary.delivery.canary.enabled = false;
    expect(() => validateObservabilityConfig(noCanary)).toThrow(
      "production alert delivery canary must be enabled",
    );
  });
});
