import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import { HumanIdentity } from "../src/auth/human-identity";
import {
  createMessageRetentionHandler,
  MessageRetentionClock,
  MessageRetentionPersistence,
  type MessageRetentionPersistenceService,
} from "../src/message-retention";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const origin = "https://app.example.test";
const endpoint =
  "https://api.example.test/v1/whatsapp-connections/con_000000000000000000052/retention-policy";

const harness = () => {
  let days: number | null = 30;
  const events: SafeTelemetryEvent[] = [];
  const persistence: MessageRetentionPersistenceService = {
    get: () => Effect.succeed({ days, updatedAt: "2026-08-01T00:00:00.000Z" }),
    update: (input) =>
      Effect.sync(() => {
        if (input.expectedDays !== days) return null;
        days = input.days;
        return { days, updatedAt: input.updatedAt };
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: () => Effect.succeed("user_52"),
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(MessageRetentionPersistence, persistence),
    Layer.succeed(MessageRetentionClock, {
      now: Effect.succeed("2026-08-03T12:00:00.000Z"),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) => Effect.sync(() => events.push(event)),
    }),
  );
  return {
    events,
    handler: createMessageRetentionHandler(layer, origin, [7, 30, 90]),
  };
};

const request = (method: string, body?: unknown) =>
  new Request(endpoint, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      authorization: "Bearer token",
      origin,
      "content-type": "application/json",
    },
    method,
  });

describe("Message Retention Policy HTTP boundary", () => {
  test("shows the current policy and configured choices", async () => {
    const response = await harness().handler(request("GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      allowed_days: [7, 30, 90],
      policy: { days: 30, updated_at: "2026-08-01T00:00:00.000Z" },
    });
  });

  test("shortens without an extension acknowledgement", async () => {
    const fixture = harness();
    const response = await fixture.handler(
      request("PUT", { days: 7, expected_days: 30 }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ policy: { days: 7 } });
  });

  test("requires an explicit acknowledgement to broaden retention", async () => {
    const fixture = harness();
    const rejected = await fixture.handler(
      request("PUT", { days: null, expected_days: 30 }),
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: "extension_not_acknowledged",
    });
    const accepted = await fixture.handler(
      request("PUT", {
        acknowledge_extension: true,
        days: null,
        expected_days: 30,
      }),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ policy: { days: null } });
  });

  test("rejects omissions, unconfigured values, and stale updates", async () => {
    const fixture = harness();
    expect((await fixture.handler(request("PUT", {}))).status).toBe(400);
    expect(
      (await fixture.handler(request("PUT", { days: 365, expected_days: 30 })))
        .status,
    ).toBe(400);
    expect(
      (await fixture.handler(request("PUT", { days: 7, expected_days: 90 })))
        .status,
    ).toBe(409);
  });
});
