import {
  decodeConnectSessionRequest,
  decodeCreateSessionRequest,
  decodeDeleteSessionRequest,
  decodeGetQrCodeRequest,
  decodeListSessionsRequest,
  decodeReconcileSessionRequest,
  type LifecycleSession,
  type ProviderControlFailure,
  type ProviderControlFailureCode,
  type ProviderControlResult,
  type ProviderControlRpcMethod,
  type ProviderControlRpcTelemetryEvent,
  type ProviderControlService,
} from "@whatsapp-mcp/contracts/provider-control";
import type {
  LifecycleSession as AdapterLifecycleSession,
  ProviderNeutralFailure,
  SessionLifecycle,
  SetupMarker,
  WhatsAppNumber,
} from "@whatsapp-mcp/wasender/control";
import { Effect, Either, Redacted } from "effect";

export interface ProviderControlRpcOptions {
  readonly loadLifecycle: () => Promise<SessionLifecycle>;
  readonly telemetry?: (
    event: ProviderControlRpcTelemetryEvent,
  ) => void | Promise<void>;
}

const boundaryFailure = (
  code: "configuration_invalid" | "invalid_request",
): ProviderControlFailure => ({
  _tag: "ProviderControlFailure",
  code,
  operation: "boundary",
  retryAfterMs: null,
  retryDecision: "do_not_retry",
});

const invalidResponseFailure = (
  operation: "lifecycle-write" | "safe-read",
): ProviderControlFailure => ({
  _tag: "ProviderControlFailure",
  code: "invalid_response",
  operation,
  retryAfterMs: null,
  retryDecision: "do_not_retry",
});

const providerFailureCodes = new Set<ProviderNeutralFailure["code"]>([
  "authentication_failed",
  "integrity_failed",
  "invalid_response",
  "response_too_large",
  "source_rejected",
  "throttled",
  "timed_out",
  "unavailable",
]);
const providerControlRetryDecisions = new Set([
  "do_not_retry",
  "reconcile_before_repeat",
  "retry_within_safe_read_budget",
]);

const isProviderNeutralFailure = (
  value: unknown,
): value is ProviderNeutralFailure => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("_tag" in value) ||
    value._tag !== "ProviderNeutralFailure" ||
    !("code" in value) ||
    !providerFailureCodes.has(value.code as ProviderNeutralFailure["code"]) ||
    !("operation" in value) ||
    !("retryAfterMs" in value) ||
    !("retryDecision" in value)
  ) {
    return false;
  }
  return (
    (value.retryAfterMs === null ||
      (Number.isSafeInteger(value.retryAfterMs) &&
        (value.retryAfterMs as number) >= 0 &&
        (value.retryAfterMs as number) <= 5_000)) &&
    typeof value.retryDecision === "string" &&
    providerControlRetryDecisions.has(value.retryDecision)
  );
};

const providerFailure = (
  value: unknown,
  operation: "lifecycle-write" | "safe-read",
): ProviderControlFailure =>
  isProviderNeutralFailure(value) && value.operation === operation
    ? {
        _tag: "ProviderControlFailure",
        code: value.code,
        operation: value.operation,
        retryAfterMs: value.retryAfterMs,
        retryDecision: value.retryDecision,
      }
    : invalidResponseFailure(operation);

const lifecycleSession = (
  value: AdapterLifecycleSession,
  operation: "lifecycle-write" | "safe-read",
): LifecycleSession => {
  const authority = Redacted.value(value.authority);
  if (
    typeof authority !== "string" ||
    authority.length === 0 ||
    authority.length > 8_192 ||
    ![
      "connected",
      "connecting",
      "degraded",
      "disconnected",
      "reconnect_required",
    ].includes(value.connectionState) ||
    !/^wsl_[A-Za-z0-9_-]{43}$/u.test(value.session)
  ) {
    throw invalidResponseFailure(operation);
  }
  return {
    authority,
    connectionState: value.connectionState,
    session: value.session,
  };
};

const success = <Value>(value: Value): ProviderControlResult<Value> => ({
  ok: true,
  value,
});

const failure = <Value>(
  error: ProviderControlFailure,
): ProviderControlResult<Value> => ({
  error,
  ok: false,
});

export const makeProviderControlRpc = (
  options: ProviderControlRpcOptions,
): ProviderControlService => {
  const emit = async (
    method: ProviderControlRpcMethod,
    outcome: "success" | ProviderControlFailureCode,
  ) => {
    try {
      await options.telemetry?.({
        event: "provider_control.rpc.completed",
        method,
        outcome,
        service: "provider-control",
      });
    } catch {
      // Telemetry is deliberately non-authoritative for lifecycle calls.
    }
  };

  const invoke = async <Request, Value, Output>(
    method: ProviderControlRpcMethod,
    input: unknown,
    decode: (input: unknown) => Request,
    operation: "lifecycle-write" | "safe-read",
    run: (
      lifecycle: SessionLifecycle,
      request: Request,
    ) => Effect.Effect<Value, unknown>,
    map: (value: Value) => Output,
  ): Promise<ProviderControlResult<Output>> => {
    let request: Request;
    try {
      request = decode(input);
    } catch {
      const error = boundaryFailure("invalid_request");
      await emit(method, error.code);
      return failure(error);
    }

    let lifecycle: SessionLifecycle;
    try {
      lifecycle = await options.loadLifecycle();
    } catch {
      const error = boundaryFailure("configuration_invalid");
      await emit(method, error.code);
      return failure(error);
    }

    let result: Either.Either<Value, unknown>;
    try {
      result = await Effect.runPromise(Effect.either(run(lifecycle, request)));
    } catch {
      const error = invalidResponseFailure(operation);
      await emit(method, error.code);
      return failure(error);
    }
    if (Either.isLeft(result)) {
      const error = providerFailure(result.left, operation);
      await emit(method, error.code);
      return failure(error);
    }

    try {
      const output = map(result.right);
      await emit(method, "success");
      return success(output);
    } catch (cause) {
      const error =
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        cause._tag === "ProviderControlFailure"
          ? (cause as ProviderControlFailure)
          : invalidResponseFailure(operation);
      await emit(method, error.code);
      return failure(error);
    }
  };

  return {
    connectSession: (input) =>
      invoke(
        "connectSession",
        input,
        decodeConnectSessionRequest,
        "lifecycle-write",
        (lifecycle, request) =>
          lifecycle.connectSession({
            session: request.session as never,
          }),
        (value) => lifecycleSession(value, "lifecycle-write"),
      ),
    createSession: (input) =>
      invoke(
        "createSession",
        input,
        decodeCreateSessionRequest,
        "lifecycle-write",
        (lifecycle, request) =>
          lifecycle.createSession({
            phoneNumber: Redacted.make(request.phoneNumber) as WhatsAppNumber,
            setupMarker: request.setupMarker as SetupMarker,
          }),
        (value) => lifecycleSession(value, "lifecycle-write"),
      ),
    deleteSession: (input) =>
      invoke(
        "deleteSession",
        input,
        decodeDeleteSessionRequest,
        "lifecycle-write",
        (lifecycle, request) =>
          lifecycle.deleteSession({
            session: request.session as never,
          }),
        (value) => value,
      ),
    getQrCode: (input) =>
      invoke(
        "getQrCode",
        input,
        decodeGetQrCodeRequest,
        "safe-read",
        (lifecycle, request) =>
          lifecycle.getQrCode({
            session: request.session as never,
          }),
        (value) => value,
      ),
    listSessions: (input) =>
      invoke(
        "listSessions",
        input,
        decodeListSessionsRequest,
        "safe-read",
        (lifecycle, request) =>
          lifecycle.listSessions({
            setupMarker: request.setupMarker as SetupMarker,
          }),
        (sessions) =>
          sessions.map((session) => lifecycleSession(session, "safe-read")),
      ),
    reconcileSession: (input) =>
      invoke(
        "reconcileSession",
        input,
        decodeReconcileSessionRequest,
        "safe-read",
        (lifecycle, request) =>
          lifecycle.reconcileSession({
            setupMarker: request.setupMarker as SetupMarker,
          }),
        (reconciliation) => {
          switch (reconciliation.outcome) {
            case "absent":
              return reconciliation;
            case "present":
              return {
                outcome: "present" as const,
                session: lifecycleSession(reconciliation.session, "safe-read"),
              };
            case "duplicates":
              return {
                outcome: "duplicates" as const,
                sessions: reconciliation.sessions.map((session) =>
                  lifecycleSession(session, "safe-read"),
                ) as [
                  LifecycleSession,
                  LifecycleSession,
                  ...LifecycleSession[],
                ],
              };
          }
        },
      ),
  };
};
