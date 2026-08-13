export type ProductAnalyticsEvent =
  | {
      event: "onboarding_stage_viewed";
      stage:
        | "welcome"
        | "profile"
        | "security"
        | "connection_setup"
        | "success";
    }
  | {
      event: "onboarding_stage_completed";
      stage:
        | "welcome"
        | "profile"
        | "security"
        | "connection_setup"
        | "success";
    }
  | { event: "onboarding_profile_completed" }
  | { event: "onboarding_security_reached" }
  | { event: "connection_setup_started" }
  | {
      event: "connection_setup_completed";
      outcome: "success" | "failed" | "cancelled" | "capacity_unavailable";
    }
  | { event: "onboarding_completed" }
  | {
      event: "feature_used";
      feature:
        | "additional_connection_setup"
        | "mcp_guide_opened"
        | "tool_call_logs_viewed";
    };

export interface ProductAnalytics {
  readonly capture: (event: ProductAnalyticsEvent) => void;
}

export interface ProductAnalyticsConfiguration {
  readonly host: string;
  readonly projectKey: string;
}

const allowedEventNames = new Set<ProductAnalyticsEvent["event"]>([
  "onboarding_stage_viewed",
  "onboarding_stage_completed",
  "onboarding_profile_completed",
  "onboarding_security_reached",
  "connection_setup_started",
  "connection_setup_completed",
  "onboarding_completed",
  "feature_used",
]);

let configuredAnalytics: ProductAnalyticsConfiguration | null = null;
let ephemeralSessionId: string | null = null;
let captureImpl: ProductAnalytics["capture"] | null = null;

const randomSessionId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sess_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
};

const sessionId = (): string => {
  ephemeralSessionId ??= randomSessionId();
  return ephemeralSessionId;
};

export const isAllowlistedProductAnalyticsEvent = (
  event: ProductAnalyticsEvent,
): boolean => allowedEventNames.has(event.event);

const posthogCapture =
  (configuration: ProductAnalyticsConfiguration): ProductAnalytics["capture"] =>
  (event) => {
    if (!isAllowlistedProductAnalyticsEvent(event)) return;
    const { event: eventName, ...properties } = event;
    const body = {
      api_key: configuration.projectKey,
      distinct_id: sessionId(),
      event: eventName,
      properties: {
        ...properties,
        $process_person_profile: false,
        $session_id: sessionId(),
      },
    };
    void fetch(new URL("/capture/", configuration.host), {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      keepalive: true,
      method: "POST",
      mode: "cors",
    }).catch(() => undefined);
  };

export const configureProductAnalytics = (
  configuration: ProductAnalyticsConfiguration | null,
): void => {
  configuredAnalytics = configuration;
  captureImpl = configuration === null ? null : posthogCapture(configuration);
};

export const getProductAnalyticsConfiguration =
  (): ProductAnalyticsConfiguration | null => configuredAnalytics;

export const parseProductAnalyticsConfiguration = (input: {
  readonly host?: string | undefined;
  readonly projectKey?: string | undefined;
}): ProductAnalyticsConfiguration | null => {
  const projectKey = input.projectKey?.trim() ?? "";
  const hostValue = input.host?.trim() ?? "";
  if (projectKey.length === 0 && hostValue.length === 0) return null;
  if (projectKey.length === 0 || hostValue.length === 0) return null;
  let host: URL;
  try {
    host = new URL(hostValue);
  } catch {
    return null;
  }
  if (
    host.protocol !== "https:" ||
    host.username !== "" ||
    host.password !== "" ||
    host.pathname !== "/" ||
    host.search !== "" ||
    host.hash !== ""
  ) {
    return null;
  }
  return {
    host: host.origin,
    projectKey,
  };
};

/** Replaces the capture implementation for controlled tests. */
export const installProductAnalyticsCapture = (
  capture: ProductAnalytics["capture"] | null,
): void => {
  captureImpl = capture;
};

export function captureProductAnalyticsEvent(
  event: ProductAnalyticsEvent,
): void {
  try {
    if (captureImpl === null) return;
    if (!isAllowlistedProductAnalyticsEvent(event)) return;
    captureImpl(event);
  } catch {
    // Analytics must never affect the product journey.
  }
}
