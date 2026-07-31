import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  makeWasenderSessionLifecycle,
  type ProviderNeutralFailure,
  type SessionAuthority,
  type SetupMarker,
  type WasenderLifecycleTelemetryEvent,
  type WhatsAppNumber,
} from "../src/control";

const credential = Redacted.make("pat_0123456789abcdef0123456789abcdef");
const referenceSecret = Redacted.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const setupMarker = "cst_0123456789abcdefghijk" as SetupMarker;
const phoneNumber = Redacted.make("+15550123456") as WhatsAppNumber;

const providerSession = (overrides: Record<string, unknown> = {}) => ({
  account_protection: true,
  api_key: "session_credential",
  created_at: "2026-07-30T12:00:00Z",
  id: 41,
  log_messages: false,
  name: setupMarker,
  phone_number: "+15550123456",
  status: "NEED_SCAN",
  updated_at: "2026-07-30T12:00:00Z",
  webhook_enabled: false,
  webhook_events: null,
  webhook_url: null,
  webhook_secret: "webhook_secret",
  ...overrides,
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

const runFailure = async <A>(
  effect: Effect.Effect<A, ProviderNeutralFailure>,
) => Effect.runPromise(Effect.flip(effect));

describe("real Wasender lifecycle adapter", () => {
  test("creates one safely configured provider session with protected outputs", async () => {
    const requests: Request[] = [];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          requests.push(request);
          return requests.length === 1
            ? json({ success: true, data: [] })
            : json({ success: true, data: providerSession() });
        },
      },
    );

    const result = await Effect.runPromise(
      lifecycle.createSession({ phoneNumber, setupMarker }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.url).toBe(
      "https://www.wasenderapi.com/api/whatsapp-sessions",
    );
    expect(requests[1]?.headers.get("authorization")).toBe(
      `Bearer ${Redacted.value(credential)}`,
    );
    expect(await requests[1]?.json()).toEqual({
      account_protection: true,
      log_messages: false,
      name: setupMarker,
      phone_number: "+15550123456",
      read_incoming_messages: false,
    });
    expect(result.connectionState).toBe("connecting");
    expect(JSON.stringify(result)).not.toContain("41");
    expect(JSON.stringify(result)).not.toContain("session_credential");
    expect(JSON.stringify(result)).not.toContain("webhook_secret");
    expect(Redacted.value(result.authority as SessionAuthority)).toContain(
      "session_credential",
    );
  });

  test("adopts one deterministic marker and reports duplicates for quarantine", async () => {
    const responses = [
      json({
        success: true,
        data: [
          providerSession({ api_key: undefined }),
          providerSession({ api_key: undefined, id: 42, name: "other" }),
        ],
      }),
      json({ success: true, data: providerSession() }),
      json({
        success: true,
        data: [
          providerSession({ api_key: undefined }),
          providerSession({ api_key: undefined, id: 43 }),
        ],
      }),
      json({ success: true, data: providerSession() }),
      json({ success: true, data: providerSession({ id: 43 }) }),
    ];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses[calls++] ?? json({}, { status: 500 }),
      },
    );

    const adopted = await Effect.runPromise(
      lifecycle.createSession({ phoneNumber, setupMarker }),
    );
    const duplicates = await Effect.runPromise(
      lifecycle.reconcileSession({ setupMarker }),
    );

    expect(adopted.connectionState).toBe("connecting");
    expect(duplicates.outcome).toBe("duplicates");
    if (duplicates.outcome === "duplicates") {
      expect(duplicates.sessions).toHaveLength(2);
      expect(duplicates.sessions[0]?.session).not.toBe(
        duplicates.sessions[1]?.session,
      );
    }
    expect(calls).toBe(5);
  });

  test("quarantines duplicate markers instead of creating another session", async () => {
    const responses = [
      json({
        success: true,
        data: [
          providerSession({ api_key: undefined }),
          providerSession({ api_key: undefined, id: 43 }),
        ],
      }),
      json({ success: true, data: providerSession() }),
      json({ success: true, data: providerSession({ id: 43 }) }),
    ];
    const methods: string[] = [];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          methods.push(request.method);
          return responses[calls++] ?? json({}, { status: 500 });
        },
      },
    );

    const failure = await runFailure(
      lifecycle.createSession({ phoneNumber, setupMarker }),
    );

    expect(failure.code).toBe("integrity_failed");
    expect(failure.retryDecision).toBe("do_not_retry");
    expect(methods).toEqual(["GET", "GET", "GET"]);
  });

  test("honors bounded throttling delay within the safe-read retry budget", async () => {
    const sleeps: number[] = [];
    const telemetry: WasenderLifecycleTelemetryEvent[] = [];
    let calls = 0;
    let now = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? json({ message: "slow down", retry_after: 60 }, { status: 429 })
            : json({ success: true, data: [] });
        },
        now: () => now,
        random: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
        telemetry: (event) => telemetry.push(event),
      },
    );

    expect(
      await Effect.runPromise(lifecycle.listSessions({ setupMarker })),
    ).toEqual([]);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([5_000]);
    expect(telemetry.map(({ outcome }) => outcome)).toEqual([
      "throttled",
      "success",
    ]);
    expect(JSON.stringify(telemetry)).not.toContain("slow down");
    expect(JSON.stringify(telemetry)).not.toContain(setupMarker);
  });

  test("classifies malformed bounded responses without exposing provider data", async () => {
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => json({ success: true, data: { secret: "raw" } }),
      },
    );

    const failure = await runFailure(lifecycle.listSessions({ setupMarker }));

    expect(failure).toEqual({
      _tag: "ProviderNeutralFailure",
      code: "invalid_response",
      operation: "safe-read",
      retryAfterMs: null,
      retryDecision: "do_not_retry",
    });
    expect(JSON.stringify(failure)).not.toContain("raw");
  });

  test("does not repeat an ambiguous create timeout", async () => {
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => {
          calls += 1;
          if (calls === 1) return json({ success: true, data: [] });
          throw new DOMException("timed out", "AbortError");
        },
      },
    );

    const failure = await runFailure(
      lifecycle.createSession({ phoneNumber, setupMarker }),
    );

    expect(calls).toBe(2);
    expect(failure).toEqual({
      _tag: "ProviderNeutralFailure",
      code: "timed_out",
      operation: "lifecycle-write",
      retryAfterMs: null,
      retryDecision: "reconcile_before_repeat",
    });
  });

  test("connects by opaque locator with one lifecycle write", async () => {
    const responses = [
      json({ success: true, data: [] }),
      json({ success: true, data: providerSession() }),
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      }),
      json({ success: true, data: providerSession() }),
      json({ success: true, data: { status: "NEED_SCAN" } }),
    ];
    const requests: Request[] = [];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          requests.push(request);
          return responses[calls++] ?? json({}, { status: 500 });
        },
      },
    );
    const created = await Effect.runPromise(
      lifecycle.createSession({ phoneNumber, setupMarker }),
    );

    const connected = await Effect.runPromise(
      lifecycle.connectSession({ session: created.session }),
    );

    expect(connected.connectionState).toBe("connecting");
    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "GET",
      "GET",
      "POST",
    ]);
    expect(requests[4]?.url).toBe(
      "https://www.wasenderapi.com/api/whatsapp-sessions/41/connect",
    );
    expect(await requests[4]?.json()).toEqual({ linkMethod: "qr" });
  });

  test("rejects oversized provider JSON before parsing or retrying", async () => {
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => {
          calls += 1;
          return new Response("x".repeat(1_048_577), { status: 200 });
        },
      },
    );

    const failure = await runFailure(lifecycle.listSessions({ setupMarker }));

    expect(calls).toBe(1);
    expect(failure.code).toBe("response_too_large");
    expect(failure.retryDecision).toBe("do_not_retry");
  });

  test("reconciles between delete attempts until absence is observed", async () => {
    const listPresent = () =>
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      });
    const responses = [
      listPresent(),
      json({ success: true, data: providerSession() }),
      listPresent(),
      new Response(null, { status: 204 }),
      listPresent(),
      listPresent(),
      new Response(null, { status: 204 }),
      json({ success: true, data: [] }),
    ];
    const methods: string[] = [];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          methods.push(request.method);
          return responses[calls++] ?? json({}, { status: 500 });
        },
      },
    );
    const reconciliation = await Effect.runPromise(
      lifecycle.listSessions({ setupMarker }),
    );
    const session = reconciliation[0];
    if (!session) throw new Error("missing session fixture");

    const first = await Effect.runPromise(
      lifecycle.deleteSession({ session: session.session }),
    );
    const second = await Effect.runPromise(
      lifecycle.deleteSession({ session: session.session }),
    );

    expect(first).toEqual({ state: "present" });
    expect(second).toEqual({ state: "absent" });
    expect(methods).toEqual([
      "GET",
      "GET",
      "GET",
      "DELETE",
      "GET",
      "GET",
      "DELETE",
      "GET",
    ]);
  });

  test("returns ephemeral SVG QR bytes without retaining the provider payload", async () => {
    const responses = [
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      }),
      json({ success: true, data: providerSession() }),
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      }),
      json({ success: true, data: { qrCode: "provider-qr-payload" } }),
    ];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses[calls++] ?? json({}, { status: 500 }),
      },
    );
    const sessions = await Effect.runPromise(
      lifecycle.listSessions({ setupMarker }),
    );
    const session = sessions[0];
    if (!session) throw new Error("missing session fixture");

    const observation = await Effect.runPromise(
      lifecycle.getQrCode({ session: session.session }),
    );

    expect(observation.state).toBe("available");
    if (observation.state === "available") {
      const image = new TextDecoder().decode(observation.image);
      expect(image.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(
        true,
      );
      expect(image).not.toContain("provider-qr-payload");
      expect(observation.expiresAt).toBeNull();
    }
  });
});
