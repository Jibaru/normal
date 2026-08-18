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
});
