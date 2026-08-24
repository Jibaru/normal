import { expect, test } from "bun:test";

const readContentSecurityPolicy = (nodeEnv: "development" | "production") => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import config from "./next.config.ts";
const rules = await config.headers?.();
console.log(rules?.[0]?.headers[0]?.value ?? "");`,
    ],
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: nodeEnv },
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
};

test("content security policy supports React debugging only in development", () => {
  expect(readContentSecurityPolicy("development")).toContain("'unsafe-eval'");
  expect(readContentSecurityPolicy("production")).not.toContain(
    "'unsafe-eval'",
  );
});
