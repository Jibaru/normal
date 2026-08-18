import { describe, expect, test } from "bun:test";
import {
  nextConnectionSetupPollDelayMs,
  observationMetricDurationMs,
} from "../src/app/connection-setup-observation";

describe("connection setup observation policy", () => {
  test("uses a fast first poll and bounded backoff while waiting for state changes", () => {
    expect(nextConnectionSetupPollDelayMs("pending", 0)).toBe(250);
    expect(nextConnectionSetupPollDelayMs("pending", 1)).toBe(500);
    expect(nextConnectionSetupPollDelayMs("pending", 4)).toBe(1_000);
    expect(nextConnectionSetupPollDelayMs("qr_available", 0)).toBe(250);
    expect(nextConnectionSetupPollDelayMs("qr_available", 3)).toBe(1_000);
    expect(nextConnectionSetupPollDelayMs("qr_available", 20)).toBe(2_000);
    expect(nextConnectionSetupPollDelayMs("connecting", 20)).toBe(2_000);
  });

  test("rounds anonymous timing metrics and rejects invalid durations", () => {
    expect(observationMetricDurationMs(100.1, 450.6)).toBe(351);
    expect(observationMetricDurationMs(null, 450.6)).toBeNull();
    expect(observationMetricDurationMs(500, 450.6)).toBeNull();
  });
});
