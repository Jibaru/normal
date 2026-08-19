import { required } from "./config";
import type { OperationsControlEnvironment } from "./environment";

export type OperationsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const endpoint = "https://api.cloudflare.com/client/v4/graphql";
const firstPartyQuery = `
  query FirstPartyAvailability(
    $zoneTag: string!
    $start: Time!
    $end: Time!
    $host: string!
  ) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequestsAdaptiveGroups(
          filter: {
            datetime_geq: $start
            datetime_leq: $end
            clientRequestHTTPHost: $host
          }
          limit: 1
        ) {
          count
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
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("application/json")
  )
    throw new Error("Cloudflare analytics query failed");
  const candidate = (await response.json()) as {
    readonly data?: unknown;
    readonly errors?: unknown;
  };
  if (Array.isArray(candidate.errors) && candidate.errors.length > 0)
    throw new Error("Cloudflare analytics query failed");
  return candidate.data;
};

const zone = (value: unknown): Record<string, unknown> => {
  const zones = (value as { viewer?: { zones?: unknown } } | null)?.viewer
    ?.zones;
  if (!Array.isArray(zones) || zones.length !== 1) {
    throw new Error("Cloudflare analytics response is invalid");
  }
  const result = zones[0];
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new Error("Cloudflare analytics response is invalid");
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
          host: api.hostname,
          start: input.startedAt,
          zoneTag: required(env.CLOUDFLARE_ZONE_ID, "Cloudflare zone"),
        },
      },
      fetcher,
    ),
  ).httpRequestsAdaptiveGroups;
  if (!Array.isArray(result) || result.length !== 1)
    throw new Error("First-party availability is unavailable");
  const aggregate = result[0] as {
    readonly count?: unknown;
    readonly ratio?: { readonly status5xx?: unknown };
  };
  const count = aggregate.count;
  const ratio = aggregate.ratio?.status5xx;
  if (
    typeof count !== "number" ||
    !Number.isFinite(count) ||
    count <= 0 ||
    typeof ratio !== "number" ||
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > 1
  )
    throw new Error("First-party availability is unavailable");
  return Math.round((100 - ratio * 100) * 1_000_000) / 1_000_000;
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
