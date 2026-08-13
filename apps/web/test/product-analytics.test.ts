import { afterEach, describe, expect, test } from "bun:test";
import {
  captureProductAnalyticsEvent,
  configureProductAnalytics,
  installProductAnalyticsCapture,
  isAllowlistedProductAnalyticsEvent,
  type ProductAnalyticsEvent,
  parseProductAnalyticsConfiguration,
} from "../src/effect/product-analytics";

afterEach(() => {
  installProductAnalyticsCapture(null);
  configureProductAnalytics(null);
});

describe("product analytics boundary", () => {
  test("parses only bare HTTPS PostHog origins with a project key", () => {
    expect(
      parseProductAnalyticsConfiguration({
        host: "https://us.i.posthog.com",
        projectKey: "phc_example",
      }),
    ).toEqual({
      host: "https://us.i.posthog.com",
      projectKey: "phc_example",
    });
    expect(
      parseProductAnalyticsConfiguration({
        host: "http://us.i.posthog.com",
        projectKey: "phc_example",
      }),
    ).toBeNull();
    expect(
      parseProductAnalyticsConfiguration({
        host: "https://us.i.posthog.com/path",
        projectKey: "phc_example",
      }),
    ).toBeNull();
    expect(
      parseProductAnalyticsConfiguration({
        host: "https://us.i.posthog.com",
        projectKey: "",
      }),
    ).toBeNull();
    expect(parseProductAnalyticsConfiguration({})).toBeNull();
  });

  test("captures only allowlisted events and bounded properties", () => {
    const captured: Array<ProductAnalyticsEvent> = [];
    installProductAnalyticsCapture((event) => {
      captured.push(event);
    });

    const allowed: ProductAnalyticsEvent = {
      event: "onboarding_stage_viewed",
      stage: "welcome",
    };
    expect(isAllowlistedProductAnalyticsEvent(allowed)).toBe(true);
    expect(
      isAllowlistedProductAnalyticsEvent({
        ...allowed,
        personal_account_id: "account-secret",
      }),
    ).toBe(false);
    expect(
      isAllowlistedProductAnalyticsEvent({
        event: "connection_setup_completed",
        outcome: "provider_error",
      }),
    ).toBe(false);
    captureProductAnalyticsEvent(allowed);
    captureProductAnalyticsEvent({
      event: "connection_setup_completed",
      outcome: "capacity_unavailable",
    });
    captureProductAnalyticsEvent({
      event: "feature_used",
      feature: "mcp_guide_opened",
    });
    captureProductAnalyticsEvent({
      event: "feature_used",
      feature: "additional_connection_setup",
    });
    captureProductAnalyticsEvent({
      event: "feature_used",
      feature: "tool_call_logs_viewed",
    });
    captureProductAnalyticsEvent({
      event: "onboarding_completed",
      email: "user@example.test",
    } as ProductAnalyticsEvent);

    expect(captured).toEqual([
      { event: "onboarding_stage_viewed", stage: "welcome" },
      {
        event: "connection_setup_completed",
        outcome: "capacity_unavailable",
      },
      { event: "feature_used", feature: "mcp_guide_opened" },
      { event: "feature_used", feature: "additional_connection_setup" },
      { event: "feature_used", feature: "tool_call_logs_viewed" },
    ]);
    expect(JSON.stringify(captured)).not.toMatch(
      /clerk|email|personal_account|whatsapp|profile|phone|message|qr|provider/iu,
    );
  });

  test("swallows capture failures so onboarding can continue", () => {
    installProductAnalyticsCapture(() => {
      throw new Error("analytics unavailable");
    });
    expect(() =>
      captureProductAnalyticsEvent({ event: "onboarding_completed" }),
    ).not.toThrow();
  });

  test("does not capture when analytics is unconfigured", () => {
    const captured: Array<ProductAnalyticsEvent> = [];
    configureProductAnalytics(null);
    installProductAnalyticsCapture((event) => {
      captured.push(event);
    });
    // installProductAnalyticsCapture overrides; clear again to mimic boot.
    installProductAnalyticsCapture(null);
    captureProductAnalyticsEvent({ event: "onboarding_security_reached" });
    expect(captured).toEqual([]);
  });
});
