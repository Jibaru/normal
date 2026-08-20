import { required } from "./config";
import type { OperationsControlEnvironment } from "./environment";

export type OperationsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const endpoint = "https://api.cloudflare.com/client/v4/graphql";

export type CloudflareAnalyticsFailure =
  | "auth"
  | "graphql"
  | "http"
  | "response";

export class CloudflareAnalyticsError extends Error {
  constructor(readonly failure: CloudflareAnalyticsFailure) {
    super("Cloudflare analytics query failed");
  }
}
const firstPartyQuery = `
  query FirstPartyAvailability(
    $zoneTag: string!
    $start: Time!
    $end: Time!
  ) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequests1hGroups(
          filter: {
            datetime_geq: $start
            datetime_leq: $end
          }
          limit: 5000
        ) {
          dimensions { clientRequestHTTPHost }
          sum { requests }
          ratio { status5xx }
        }
      }
    }
  }
`;

const emailQuery = `
  query PagerDelivery(
    $zoneTag: string!
    $start: Time!
    $end: Time!
  ) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        emailSendingAdaptive(
          filter: { datetime_geq: $start, datetime_leq: $end }
          limit: 100
          orderBy: [datetime_DESC]
        ) {
          datetime
          isLastEvent
          messageId
          status
        }
      }
    }
  }
`;

const query = async (
  env: OperationsControlEnvironment,
  body: Record<string, unknown>,
  fetcher: OperationsFetch,
) => {
  const response = await fetcher(endpoint, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${required(
        env.CLOUDFLARE_ANALYTICS_TOKEN,
        "Cloudflare analytics token",
      )}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new CloudflareAnalyticsError(
      response.status === 401 || response.status === 403 ? "auth" : "http",
    );
  if (!response.headers.get("content-type")?.startsWith("application/json"))
    throw new CloudflareAnalyticsError("response");
  const candidate = (await response.json()) as {
    readonly data?: unknown;
    readonly errors?: unknown;
  };
  if (Array.isArray(candidate.errors) && candidate.errors.length > 0)
    throw new CloudflareAnalyticsError("graphql");
  return candidate.data;
};

const zone = (value: unknown): Record<string, unknown> => {
  const zones = (value as { viewer?: { zones?: unknown } } | null)?.viewer
    ?.zones;
  if (!Array.isArray(zones) || zones.length !== 1) {
    throw new CloudflareAnalyticsError("response");
  }
  const result = zones[0];
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new CloudflareAnalyticsError("response");
  return result as Record<string, unknown>;
};

export const queryFirstPartyAvailability = async (
  env: OperationsControlEnvironment,
  input: { readonly completedAt: string; readonly startedAt: string },
  fetcher: OperationsFetch = fetch,
) => {
  const api = new URL(env.API_ORIGIN);
  const result = zone(
    await query(
      env,
      {
        query: firstPartyQuery,
        variables: {
          end: input.completedAt,
          start: input.startedAt,
          zoneTag: required(env.CLOUDFLARE_ZONE_ID, "Cloudflare zone"),
        },
      },
      fetcher,
    ),
  );
  const groups = result.httpRequests1hGroups;
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > 5000)
    throw new CloudflareAnalyticsError("response");
  let total = 0;
  let failed = 0;
  for (const group of groups) {
    if (typeof group !== "object" || group === null || Array.isArray(group))
      throw new CloudflareAnalyticsError("response");
    const candidate = group as {
      readonly dimensions?: { readonly clientRequestHTTPHost?: unknown };
      readonly ratio?: { readonly status5xx?: unknown };
      readonly sum?: { readonly requests?: unknown };
    };
    const hostname = candidate.dimensions?.clientRequestHTTPHost;
    const requests = candidate.sum?.requests;
    const ratio = candidate.ratio?.status5xx;
    if (
      typeof hostname !== "string" ||
      typeof requests !== "number" ||
      !Number.isFinite(requests) ||
      requests < 0 ||
      typeof ratio !== "number" ||
      !Number.isFinite(ratio) ||
      ratio < 0 ||
      ratio > 1
    )
      throw new CloudflareAnalyticsError("response");
    if (hostname !== api.hostname) continue;
    total += requests;
    failed += requests * ratio;
  }
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(failed))
    throw new CloudflareAnalyticsError("response");
  return Math.round((100 - (failed / total) * 100) * 1_000_000) / 1_000_000;
};

export type PagerDelivery = "delivered" | "failed" | "pending";

export const queryPagerDelivery = async (
  env: OperationsControlEnvironment,
  input: {
    readonly completedAt: string;
    readonly messageId: string;
    readonly startedAt: string;
  },
  fetcher: OperationsFetch = fetch,
): Promise<PagerDelivery> => {
  const events = zone(
    await query(
      env,
      {
        query: emailQuery,
        variables: {
          end: input.completedAt,
          start: input.startedAt,
          zoneTag: required(env.CLOUDFLARE_ZONE_ID, "Cloudflare zone"),
        },
      },
      fetcher,
    ),
  ).emailSendingAdaptive;
  if (!Array.isArray(events))
    throw new Error("Pager delivery evidence is unavailable");
  const matching = events.find(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      !Array.isArray(event) &&
      (event as { messageId?: unknown }).messageId === input.messageId &&
      (event as { isLastEvent?: unknown }).isLastEvent === 1,
  ) as { status?: unknown } | undefined;
  if (matching?.status === "delivered") return "delivered";
  if (
    matching?.status === "deliveryFailed" ||
    matching?.status === "failed" ||
    matching?.status === "rejected"
  )
    return "failed";
  return "pending";
};
