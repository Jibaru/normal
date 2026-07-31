import { ConfigProvider, Effect, Redacted } from "effect";
import { databaseConfig } from "./config";
import { makePgConnectionHealthRepository } from "./connection-health";

const connectionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const causes = new Set([
  "ingress_failure",
  "processing_failure",
  "restore_loss",
] as const);
type EvidenceCause = "ingress_failure" | "processing_failure" | "restore_loss";

const isEvidenceCause = (value: string | undefined): value is EvidenceCause =>
  value !== undefined && causes.has(value as EvidenceCause);

const apiRuntimeConnectionString = (
  value: Redacted.Redacted<string>,
): string => {
  const connectionString = Redacted.value(value);
  const url = new URL(connectionString);
  if (url.username !== "whatsapp_api_runtime") {
    throw new Error("database role is not the restricted API runtime");
  }
  return connectionString;
};

const [connectionId, cause, action, observedAt] = process.argv.slice(2);
const observedDate = observedAt === undefined ? null : new Date(observedAt);
if (
  connectionId === undefined ||
  !connectionIdPattern.test(connectionId) ||
  !isEvidenceCause(cause) ||
  (action !== "open" && action !== "close") ||
  observedDate === null ||
  !Number.isFinite(observedDate.valueOf()) ||
  observedDate.toISOString() !== observedAt
) {
  console.error(
    JSON.stringify({ event: "ingestion_gap.evidence.invalid_request" }),
  );
  process.exitCode = 1;
} else {
  const program = databaseConfig.pipe(
    Effect.flatMap((config) =>
      Effect.tryPromise({
        try: () =>
          makePgConnectionHealthRepository(
            apiRuntimeConnectionString(config.databaseUrl),
          ).recordEvidence({
            active: action === "open",
            cause,
            connectionId,
            observedAt,
          }),
        catch: (error) => error,
      }),
    ),
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
  );

  try {
    const recorded = await Effect.runPromise(program);
    console.info(
      JSON.stringify({
        action,
        cause,
        event: "ingestion_gap.evidence.recorded",
        outcome: recorded ? "recorded" : "rejected",
      }),
    );
    if (!recorded) process.exitCode = 1;
  } catch {
    console.error(
      JSON.stringify({
        action,
        cause,
        event: "ingestion_gap.evidence.unavailable",
      }),
    );
    process.exitCode = 1;
  }
}
