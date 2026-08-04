export {};

const profile = process.argv[2];
const target = process.argv[3] ?? "apps/api/.dev.vars";

if (profile === undefined || profile.length === 0) {
  throw new Error(
    "usage: bun scripts/refresh-development-aws-credentials.ts <aws-profile> [dev-vars-file]",
  );
}

const exported = Bun.spawn(
  [
    "aws",
    "configure",
    "export-credentials",
    "--profile",
    profile,
    "--format",
    "process",
  ],
  { stderr: "pipe", stdout: "pipe" },
);
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(exported.stdout).text(),
  new Response(exported.stderr).text(),
  exported.exited,
]);
if (exitCode !== 0) {
  throw new Error(stderr.trim() || "AWS credential export failed");
}

const credentials = JSON.parse(stdout) as Record<string, unknown>;
const replacements = {
  AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
  AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
  AWS_SESSION_TOKEN: credentials.SessionToken,
};

let contents = await Bun.file(target).text();
for (const [name, value] of Object.entries(replacements)) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`AWS profile did not provide ${name}`);
  }
  const pattern = new RegExp(`^${name}=.*$`, "mu");
  if (!pattern.test(contents)) {
    throw new Error(`${target} does not contain ${name}`);
  }
  contents = contents.replace(pattern, `${name}=${JSON.stringify(value)}`);
}

await Bun.write(target, contents);
console.info(`Refreshed temporary AWS credentials in ${target}.`);
