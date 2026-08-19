import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type RecoveryWorker = {
  readonly name: string;
  readonly secretNames: readonly string[];
};

export const recoveryWorkers = [
  {
    name: "whatsapp-mcp-recovery-game-day",
    secretNames: [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "KMS_RECOVERY_GAME_DAY_KEY_ARN",
      "PAGER_RECEIPT_TOKEN",
      "PAGER_RECEIPT_URL",
      "PAGER_WEBHOOK_URL",
      "QUARTERLY_RECEIPT_SECRET",
    ],
  },
  {
    name: "whatsapp-mcp-recovery-verifier",
    secretNames: [
      "NEON_PARENT_BRANCH_ID",
      "NEON_PROJECT_ID",
      "NEON_RECOVERY_API_KEY",
      "OBSERVABILITY_QUERY_TOKEN",
      "OBSERVABILITY_QUERY_URL",
      "RECOVERY_EVIDENCE_TOKEN",
    ],
  },
  {
    name: "whatsapp-mcp-recovery-control",
    secretNames: [
      "DELETION_MARKER_HMAC_SECRET",
      "NEON_PARENT_BRANCH_ID",
      "NEON_PROJECT_ID",
      "NEON_RECOVERY_API_KEY",
      "RECIPIENT_TRANSITION_HMAC_SECRET",
      "RECOVERY_CONTROL_TOKEN",
      "RECOVERY_EVIDENCE_TOKEN",
    ],
  },
] as const satisfies readonly RecoveryWorker[];

const repositoryRoot = resolve(import.meta.dir, "..");

const runWrangler = async (
  args: readonly string[],
  options: { readonly stdin?: string } = {},
) => {
  const process = Bun.spawn(["bun", "x", "wrangler", ...args], {
    cwd: repositoryRoot,
    env: Bun.env,
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    if (process.stdin === undefined) {
      throw new Error("Wrangler stdin was not created");
    }
    process.stdin.write(options.stdin);
    process.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const requiredEnvironment = (names: readonly string[]) => {
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = Bun.env[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing required recovery secret: ${name}`);
    }
    values[name] = value;
  }
  return values;
};

const readSecretNames = async (workerName: string) => {
  const result = await runWrangler(["secret", "list", "--name", workerName]);
  if (result.exitCode !== 0) return result;
  const parsed = JSON.parse(result.stdout) as ReadonlyArray<{
    readonly name: string;
  }>;
  return {
    ...result,
    names: parsed.map(({ name }) => name).sort(),
  };
};

const ensureUploadableWorker = async (
  workerName: string,
  bootstrapEntry: string,
) => {
  const existing = await readSecretNames(workerName);
  if (existing.exitCode === 0) return;
  if (
    !existing.stderr.includes("not found") ||
    !existing.stderr.includes("10007")
  ) {
    throw new Error(`Could not inspect recovery Worker ${workerName}`);
  }

  const upload = await runWrangler([
    "versions",
    "upload",
    bootstrapEntry,
    "--name",
    workerName,
    "--no-bundle",
    "--compatibility-date",
    "2026-07-31",
    "--message",
    "Fail-closed secret bootstrap; never deploy",
  ]);
  if (upload.exitCode !== 0) {
    throw new Error(
      `Could not create the undeployed bootstrap version for ${workerName}`,
    );
  }
};

const uploadAndVerify = async (
  worker: RecoveryWorker,
  bootstrapEntry: string,
) => {
  await ensureUploadableWorker(worker.name, bootstrapEntry);
  const values = requiredEnvironment(worker.secretNames);
  const upload = await runWrangler(
    ["versions", "secret", "bulk", "--name", worker.name],
    { stdin: JSON.stringify(values) },
  );
  if (upload.exitCode !== 0) {
    throw new Error(`Could not upload recovery secrets to ${worker.name}`);
  }

  const observed = await readSecretNames(worker.name);
  if (observed.exitCode !== 0 || !("names" in observed)) {
    throw new Error(`Could not verify recovery secrets on ${worker.name}`);
  }
  const expected = [...worker.secretNames].sort();
  if (JSON.stringify(observed.names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected recovery secret inventory on ${worker.name}`);
  }
  console.log(`Verified ${worker.name}: ${expected.join(", ")}`);
};

export const main = async () => {
  requiredEnvironment(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
  requiredEnvironment(
    recoveryWorkers.flatMap(({ secretNames }) => secretNames),
  );
  const directory = await mkdtemp(join(tmpdir(), "normal-recovery-bootstrap-"));
  const bootstrapEntry = join(directory, "worker.mjs");
  try {
    await Bun.write(
      bootstrapEntry,
      "export default { async fetch() { return new Response(null, { status: 503 }); } };\n",
    );
    for (const worker of recoveryWorkers) {
      await uploadAndVerify(worker, bootstrapEntry);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) await main();
