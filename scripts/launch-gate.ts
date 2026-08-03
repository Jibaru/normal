import { runDeploymentSmoke } from "./deployment-smoke";
import { type DrillEvidence, evaluateLaunchGate } from "./recovery-drills";

const required = (name: string) => {
  const value = process.env[name];
  if (!value || /example|placeholder|replace/iu.test(value))
    throw new Error(`${name} is unavailable`);
  return value;
};

const approved = (name: string) => required(name) === "approved";

export const runLaunchGate = async (
  options: {
    readonly readEvidence?: (path: string) => Promise<DrillEvidence>;
    readonly smoke?: typeof runDeploymentSmoke;
    readonly now?: Date;
  } = {},
) => {
  const readEvidence =
    options.readEvidence ??
    (async (path: string) => JSON.parse(await Bun.file(path).text()));
  const [monthly, quarterly] = await Promise.all([
    readEvidence(required("MONTHLY_RECOVERY_EVIDENCE")),
    readEvidence(required("QUARTERLY_GAME_DAY_EVIDENCE")),
  ]);
  let smokePassed = false;
  try {
    await (options.smoke ?? runDeploymentSmoke)({
      apiOrigin: required("API_ORIGIN"),
      mcpAccessToken: required("MCP_SMOKE_ACCESS_TOKEN"),
      smokeSecret: required("SMOKE_CHECK_SECRET"),
      webOrigin: required("WEB_ORIGIN"),
    });
    smokePassed = true;
  } catch {
    smokePassed = false;
  }
  const result = evaluateLaunchGate({
    now: options.now ?? new Date(),
    monthly,
    quarterly,
    smokePassed,
    numericQuotasApproved: approved("NUMERIC_QUOTAS_APPROVAL"),
    providerCapacityApproved: approved("PROVIDER_CAPACITY_APPROVAL"),
    wasenderTermsApproved: approved("WASENDER_GOVERNANCE_APPROVAL"),
    productionBundleHasNoFake:
      required("PRODUCTION_BUNDLE_INSPECTION") === "passed",
  });
  if (!result.open)
    throw new Error(
      `external onboarding remains closed: ${result.blockers.join("; ")}`,
    );
  return result;
};

if (import.meta.main) {
  await runLaunchGate();
  console.info(JSON.stringify({ external_onboarding_gate: "open" }));
}
