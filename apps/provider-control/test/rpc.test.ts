import type {
  LifecycleSession,
  ProviderControlRpcTelemetryEvent,
} from "@whatsapp-mcp/contracts/provider-control";
import type {
  LifecycleSession as AdapterLifecycleSession,
  LifecycleSessionLocator,
  ProviderNeutralFailure,
  SessionAuthority,
  SessionLifecycle,
  SetupMarker,
} from "@whatsapp-mcp/wasender/control";
import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { makeProviderControlRpc } from "../src/rpc";

const setupMarker = "cst_0123456789abcdefghijk" as SetupMarker;
const lifecycleSession: AdapterLifecycleSession = {
  authority: Redacted.make(
    JSON.stringify({
      sessionCredential: "session-credential",
      webhookVerificationSecret: "webhook-secret",
    }),
  ) as SessionAuthority,
  connectionState: "connecting",
  session:
    "wsl_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG" as LifecycleSessionLocator,
};

const makeLifecycle = (
  overrides: Partial<SessionLifecycle> = {},
): SessionLifecycle => ({
  connectSession: () => Effect.succeed(lifecycleSession),
  createSession: () => Effect.succeed(lifecycleSession),
  deleteSession: () => Effect.succeed({ state: "absent" }),
  getQrCode: () => Effect.succeed({ state: "not_available" }),
  listSessions: () => Effect.succeed([lifecycleSession]),
  reconcileSession: () =>
    Effect.succeed({ outcome: "present", session: lifecycleSession }),
  ...overrides,
});

describe("provider-control RPC authority", () => {
  test("serializes protected lifecycle values for the API binding only", async () => {
    const events: ProviderControlRpcTelemetryEvent[] = [];
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () => makeLifecycle(),
      telemetry: (event) => {
        events.push(event);
      },
    });

    const result = await rpc.createSession({
      phoneNumber: "+15550123456",
      setupMarker,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful lifecycle result");
    expect(result.value).toEqual({
      authority:
        '{"sessionCredential":"session-credential","webhookVerificationSecret":"webhook-secret"}',
      connectionState: "connecting",
      session: "wsl_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
    } satisfies LifecycleSession);
    expect(events).toEqual([
      {
        event: "provider_control.rpc.completed",
        method: "createSession",
        outcome: "success",
        service: "provider-control",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("session-credential");
    expect(JSON.stringify(events)).not.toContain("+15550123456");
    expect(JSON.stringify(events)).not.toContain(setupMarker);
  });

  test("rejects excess properties without constructing production authority", async () => {
    let loads = 0;
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () => {
        loads += 1;
        return makeLifecycle();
      },
    });

    const result = await rpc.reconcileSession({
      accountCredential: "must-never-be-an-input",
      setupMarker,
    } as never);

    expect(result).toEqual({
      error: {
        _tag: "ProviderControlFailure",
        code: "invalid_request",
        operation: "boundary",
        retryAfterMs: null,
        retryDecision: "do_not_retry",
      },
      ok: false,
    });
    expect(loads).toBe(0);
  });

  test("maps provider failures to a content-free RPC result", async () => {
    const failure: ProviderNeutralFailure = {
      _tag: "ProviderNeutralFailure",
      code: "timed_out",
      operation: "lifecycle-write",
      retryAfterMs: null,
      retryDecision: "reconcile_before_repeat",
    };
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () =>
        makeLifecycle({
          deleteSession: () => Effect.fail(failure),
        }),
    });

    const result = await rpc.deleteSession({
      session: lifecycleSession.session,
    });

    expect(result).toEqual({
      error: {
        ...failure,
        _tag: "ProviderControlFailure",
      },
      ok: false,
    });
  });

  test("contains unexpected adapter defects without leaking their cause", async () => {
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () =>
        makeLifecycle({
          connectSession: () =>
            Effect.die(
              new Error(
                "account-credential-and-provider-response-must-not-cross",
              ),
            ),
        }),
    });

    const result = await rpc.connectSession({
      session: lifecycleSession.session,
    });

    expect(result).toEqual({
      error: {
        _tag: "ProviderControlFailure",
        code: "invalid_response",
        operation: "lifecycle-write",
        retryAfterMs: null,
        retryDecision: "do_not_retry",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("account-credential");
  });

  test("exposes every lifecycle method through the same validated authority", async () => {
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () => makeLifecycle(),
    });

    const [connected, listed, qr, reconciled, deleted] = await Promise.all([
      rpc.connectSession({ session: lifecycleSession.session }),
      rpc.listSessions({ setupMarker }),
      rpc.getQrCode({ session: lifecycleSession.session }),
      rpc.reconcileSession({ setupMarker }),
      rpc.deleteSession({ session: lifecycleSession.session }),
    ]);

    expect(connected.ok).toBe(true);
    expect(listed).toEqual({
      ok: true,
      value: [
        {
          authority:
            '{"sessionCredential":"session-credential","webhookVerificationSecret":"webhook-secret"}',
          connectionState: "connecting",
          session: lifecycleSession.session,
        },
      ],
    });
    expect(qr).toEqual({
      ok: true,
      value: { state: "not_available" },
    });
    expect(reconciled.ok).toBe(true);
    expect(deleted).toEqual({
      ok: true,
      value: { state: "absent" },
    });
  });

  test("rejects malformed phone numbers and opaque locators before loading authority", async () => {
    let loads = 0;
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () => {
        loads += 1;
        return makeLifecycle();
      },
    });

    const [created, connected] = await Promise.all([
      rpc.createSession({
        phoneNumber: "15550123456",
        setupMarker,
      }),
      rpc.connectSession({ session: "41" }),
    ]);

    expect(created.ok).toBe(false);
    expect(connected.ok).toBe(false);
    expect(loads).toBe(0);
  });
});
