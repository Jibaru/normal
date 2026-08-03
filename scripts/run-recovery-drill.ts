import { type DrillKind, validateDrillEvidence } from "./recovery-drills";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const required = (name: string) => {
  const value = process.env[name];
  if (!value || /example|placeholder|replace/iu.test(value))
    throw new Error(`${name} is unavailable`);
  return value;
};

export const runRecoveryDrill = async (
  drill: DrillKind,
  options: {
    readonly fetch?: Fetch;
    readonly now?: Date;
    readonly random?: () => number;
    readonly sourcePoint?: Date;
  } = {},
) => {
  const now = options.now ?? new Date();
  const random =
    options.random ??
    (() =>
      (crypto.getRandomValues(new Uint32Array(1)).at(0) ?? 0) / 0x1_0000_0000);
  const sourcePoint =
    options.sourcePoint ?? new Date(now.getTime() - random() * 30 * 86_400_000);
  const response = await (options.fetch ?? globalThis.fetch)(
    required("RECOVERY_AUTOMATION_URL"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${required("RECOVERY_AUTOMATION_TOKEN")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        drill,
        requested_source_point_at: sourcePoint.toISOString(),
        serving: false,
      }),
    },
  );
  if (!response.ok) throw new Error(`${drill} automation failed`);
  const evidence = await response.json();
  const failures = validateDrillEvidence(evidence, now);
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Array.isArray(evidence)
  )
    throw new Error(`${drill} evidence rejected: ${failures.join("; ")}`);
  if ((evidence as { drill?: unknown }).drill !== drill)
    failures.push("automation returned evidence for a different drill");
  if (
    (evidence as { source_point_at?: unknown }).source_point_at !==
    sourcePoint.toISOString()
  )
    failures.push("automation restored a different history point");
  if (failures.length > 0)
    throw new Error(`${drill} evidence rejected: ${failures.join("; ")}`);
  return evidence;
};

if (import.meta.main) {
  const drill = process.argv[2] as DrillKind;
  if (!(["monthly_restore", "quarterly_game_day"] as const).includes(drill))
    throw new Error("expected monthly_restore or quarterly_game_day");
  const evidence = await runRecoveryDrill(drill);
  const output = process.env.RECOVERY_EVIDENCE_PATH ?? `${drill}.json`;
  await Bun.write(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.info(JSON.stringify({ drill, evidence: output, status: "complete" }));
}
