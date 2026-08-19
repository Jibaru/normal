import { describe, expect, test } from "bun:test";

describe("production deployment order", () => {
  test("deploys every coordinator before the public API", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    ).text();
    const provider = workflow.indexOf("Deploy provider control");
    const deletion = workflow.indexOf("Deploy deletion coordinator");
    const restore = workflow.indexOf("Deploy restore coordinator");
    const recovery = workflow.indexOf("Deploy recovery control");
    const api = workflow.indexOf("Deploy API");
    expect(provider).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(provider);
    expect(restore).toBeGreaterThan(deletion);
    expect(recovery).toBeGreaterThan(restore);
    expect(api).toBeGreaterThan(recovery);
    expect(
      workflow.match(
        /bun run --cwd apps\/recovery-control wrangler deploy --env production/gu,
      ),
    ).toHaveLength(1);
  });

  test("bootstraps exact recovery secrets without deploying the bootstrap versions", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    ).text();
    const bootstrap = await Bun.file(
      new URL("bootstrap-recovery-worker-secrets.ts", import.meta.url),
    ).text();

    expect(workflow).toContain("bootstrap_recovery_secrets");
    expect(workflow).toContain(
      "bun scripts/bootstrap-recovery-worker-secrets.ts",
    );
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("id-token: write");
    expect(bootstrap).toContain('"versions",\n    "upload"');
    expect(bootstrap).toContain(
      '["versions", "secret", "bulk", "--name", worker.name]',
    );
    expect(bootstrap).toContain("Fail-closed secret bootstrap; never deploy");
    expect(bootstrap).not.toContain('"deploy"');
    for (const name of [
      "whatsapp-mcp-recovery-game-day",
      "whatsapp-mcp-recovery-verifier",
      "whatsapp-mcp-recovery-control",
    ]) {
      expect(bootstrap).toContain(name);
    }
    for (const name of [
      "NEON_RECOVERY_API_KEY",
      "OBSERVABILITY_QUERY_TOKEN",
      "PAGER_RECEIPT_TOKEN",
      "QUARTERLY_RECEIPT_SECRET",
      "RECOVERY_EVIDENCE_TOKEN",
    ]) {
      expect(bootstrap).toContain(name);
      expect(workflow).toContain(name);
    }
  });
});
