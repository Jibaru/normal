import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const sourceName = z.enum(["workerTelemetry", "cloudflarePlatform"]);
const panel = z.object({
  title: z.string().min(1),
  source: sourceName,
  metric: z.string().min(1),
  filter: z.record(z.string(), z.union([z.string(), z.number()])),
  groupBy: z.array(z.string()),
});
const configSchema = z.object({
  version: z.literal(1),
  environment: z.literal("production"),
  owner: z.object({ team: z.string().min(1), runbook: z.string().min(1) }),
  delivery: z.object({
    channel: z.literal("PAGER_WEBHOOK_URL"),
    payloadFields: z.array(z.string()),
    canary: z.object({
      enabled: z.boolean(),
      schedule: z.string().min(1),
      alert: z.string().min(1),
    }),
  }),
  sources: z.record(sourceName, z.object({ fields: z.array(z.string()) })),
  slos: z.array(
    z.object({
      id: z.string(),
      objective: z.number().nullable(),
      window: z.literal("30d"),
      source: sourceName,
      indicator: z.string(),
      filter: z.record(z.string(), z.string()),
    }),
  ),
  dashboards: z.array(
    z.object({ id: z.string(), panels: z.array(panel).min(1) }),
  ),
  alerts: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(["page", "ticket"]),
      source: sourceName,
      metric: z.string(),
      condition: z.enum(["gt", "gte", "lt", "canary"]),
      filter: z.record(z.string(), z.string()),
      threshold: z.number().nullable(),
      for: z.string(),
    }),
  ),
});

export type ObservabilityConfig = z.infer<typeof configSchema>;

const forbiddenField =
  /(?:account|authorization|connection|contact|content|credential|email|identifier|ip|keyArn|marker|mediaUrl|message|oauthToken|payload|phone|providerId|recipient|session|token|user)/iu;
const requiredDashboardTerms = [
  "Authentication",
  "OAuth",
  "MCP latency",
  "Send ambiguity",
  "Queue lag",
  "Dead letters",
  "webhook rejection",
  "reconciliation drift",
  "Quota",
  "Stored Media",
  "KMS",
  "Deletion",
  "Restore gate",
];
const requiredAlerts = [
  "active-dead-letters",
  "deletion-cleanup-risk",
  "restore-gate-failure",
  "key-failures",
  "quota-pressure",
  "wasender-dependency-outage",
  "whatsapp-dependency-outage",
  "alert-delivery-canary",
];

export const loadObservabilityConfig = async (): Promise<ObservabilityConfig> =>
  configSchema.parse(
    JSON.parse(
      await readFile(
        fileURLToPath(
          new URL("../observability/production.json", import.meta.url),
        ),
        "utf8",
      ),
    ),
  );

export const validateObservabilityConfig = (input: unknown): void => {
  const config = configSchema.parse(input);
  const alertIds = new Set(config.alerts.map(({ id }) => id));
  const titles = config.dashboards.flatMap(({ panels }) =>
    panels.map(({ title }) => title),
  );

  for (const term of requiredDashboardTerms) {
    if (
      !titles.some((title) =>
        title
          .toLocaleLowerCase("en-US")
          .includes(term.toLocaleLowerCase("en-US")),
      )
    )
      throw new Error(`missing operational view: ${term}`);
  }
  for (const alert of requiredAlerts) {
    if (!alertIds.has(alert))
      throw new Error(`missing required alert: ${alert}`);
  }
  if (!config.delivery.canary.enabled)
    throw new Error("production alert delivery canary must be enabled");
  if (!alertIds.has(config.delivery.canary.alert))
    throw new Error("alert delivery canary must target a declared alert");
  if (
    config.delivery.payloadFields.join(",") !==
    "alert,severity,status,observedAt"
  )
    throw new Error("alert delivery payload must remain identity-free");

  const expectedSlos = [
    "first-party-availability",
    "wasender-availability",
    "whatsapp-availability",
  ];
  if (config.slos.map(({ id }) => id).join(",") !== expectedSlos.join(","))
    throw new Error("availability SLOs must be reported separately");
  if (config.slos[0]?.objective !== 99.5)
    throw new Error("first-party monthly availability objective must be 99.5");
  if (config.slos.slice(1).some(({ objective }) => objective !== null))
    throw new Error("dependencies must not inherit the first-party SLO");

  const runtimeAllowlistSource = readFileSync(
    fileURLToPath(
      new URL("../apps/api/src/safe-telemetry.ts", import.meta.url),
    ),
    "utf8",
  );
  const runtimeFields = new Set(
    [...runtimeAllowlistSource.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/gu)]
      .map((match) => match[1])
      .filter((field): field is string => field !== undefined),
  );
  for (const field of config.sources.workerTelemetry.fields) {
    if (!runtimeFields.has(field))
      throw new Error(`field ${field} is not runtime telemetry-allowlisted`);
  }

  for (const dashboard of config.dashboards) {
    for (const item of dashboard.panels) {
      const allowed = new Set(config.sources[item.source].fields);
      for (const field of [
        item.metric,
        ...item.groupBy,
        ...Object.keys(item.filter),
      ]) {
        if (field !== "count" && !allowed.has(field))
          throw new Error(`field ${field} is not telemetry-allowlisted`);
        if (forbiddenField.test(field))
          throw new Error(`field ${field} may carry User or content identity`);
      }
    }
  }
  for (const alert of config.alerts) {
    if (!config.sources[alert.source].fields.includes(alert.metric))
      throw new Error(`alert metric ${alert.metric} is not allowlisted`);
    for (const field of Object.keys(alert.filter)) {
      if (!config.sources[alert.source].fields.includes(field))
        throw new Error(`alert filter ${field} is not allowlisted`);
    }
  }
};

if (import.meta.main) {
  validateObservabilityConfig(await loadObservabilityConfig());
  console.info("Production observability configuration is valid.");
}
