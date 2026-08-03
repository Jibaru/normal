import { describe, expect, test } from "bun:test";
import {
  loadWebhookReplayOperatorConfig,
  requestWebhookReplay,
} from "./request-webhook-replay";

const config = {
  accountId: "1".repeat(32),
  apiToken: "test-api-token-that-is-long-enough",
  operatorReference: "2".repeat(64),
  queueId: "3".repeat(32),
};

describe("operator Webhook Event replay command", () => {
  test("publishes only an opaque, closed replay request to the dedicated Queue", async () => {
    let observed:
      | {
          input: string | URL | Request;
          init: RequestInit | undefined;
        }
      | undefined;
    const requestId = await requestWebhookReplay(
      {
        config,
        incidentReference: "50000000-0000-4000-8000-000000000035",
        reasonCode: "dependency_recovered",
      },
      {
        fetch: async (input, init) => {
          observed = { input, init };
          return Response.json({ success: true });
        },
        nextRequestId: () => "60000000-0000-4000-8000-000000000035",
        now: () => "2026-08-01T12:10:00.000Z",
      },
    );

    expect(requestId).toBe("60000000-0000-4000-8000-000000000035");
    expect(observed?.input).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/queues/${config.queueId}/messages`,
    );
    expect(observed?.init?.headers).toEqual({
      authorization: `Bearer ${config.apiToken}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(observed?.init?.body))).toEqual({
      body: {
        incident_reference: "50000000-0000-4000-8000-000000000035",
        operator_reference: config.operatorReference,
        reason_code: "dependency_recovered",
        request_id: requestId,
        requested_at: "2026-08-01T12:10:00.000Z",
        version: 1,
      },
      content_type: "json",
    });
    expect(String(observed?.init?.body)).not.toContain("payload");
  });

  test("validates least-privilege operator configuration without echoing secrets", () => {
    expect(
      loadWebhookReplayOperatorConfig({
        CLOUDFLARE_ACCOUNT_ID: config.accountId,
        CLOUDFLARE_REPLAY_API_TOKEN: config.apiToken,
        CLOUDFLARE_INGESTION_REPLAY_QUEUE_ID: config.queueId,
        WEBHOOK_REPLAY_OPERATOR_REFERENCE: config.operatorReference,
      }),
    ).toEqual(config);
    expect(() =>
      loadWebhookReplayOperatorConfig({
        CLOUDFLARE_ACCOUNT_ID: config.accountId,
        CLOUDFLARE_REPLAY_API_TOKEN: config.apiToken,
        CLOUDFLARE_INGESTION_REPLAY_QUEUE_ID: config.queueId,
        WEBHOOK_REPLAY_OPERATOR_REFERENCE: "operator@example.test",
      }),
    ).toThrow("opaque fingerprint");
  });
});
