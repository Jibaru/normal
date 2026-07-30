const repositoryRoot = import.meta.dir.replace(/\/scripts$/, "");
const environments = ["development", "preview", "production"] as const;
const deployables = ["api", "provider-control"] as const;

for (const deployable of deployables) {
  const manifestPath = `${repositoryRoot}/apps/${deployable}/wrangler.jsonc`;
  const manifest = Bun.JSONC.parse(
    await Bun.file(manifestPath).text(),
  ) as Record<string, unknown>;

  if (
    manifest.workers_dev !== false ||
    manifest.preview_urls !== false ||
    "route" in manifest ||
    "routes" in manifest
  ) {
    throw new Error(
      `${deployable} must expose no Wrangler-managed public ingress; OpenTofu owns the API custom domain.`,
    );
  }

  for (const environment of environments) {
    const workerSuffix = environment === "production" ? "" : `-${environment}`;
    const outputDirectory = `${repositoryRoot}/.wrangler/manifest-validation/${deployable}-${environment}`;
    const process = Bun.spawn(
      [
        "bun",
        "run",
        "--cwd",
        `apps/${deployable}`,
        "wrangler",
        "deploy",
        "--dry-run",
        "--env",
        environment,
        "--outdir",
        outputDirectory,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...Bun.env,
          CI: "true",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;

    if (exitCode !== 0) {
      console.error(output);
      throw new Error(
        `Wrangler rejected ${deployable}'s ${environment} manifest.`,
      );
    }

    if (!output.includes(`env.DEPLOYMENT_ENVIRONMENT ("${environment}")`)) {
      throw new Error(
        `${deployable}'s ${environment} manifest has the wrong environment binding.`,
      );
    }

    if (
      deployable === "api" &&
      !output.includes(
        `env.PROVIDER_CONTROL (whatsapp-mcp-provider-control${workerSuffix})`,
      )
    ) {
      throw new Error(
        `API ${environment} does not bind to provider-control in the same environment.`,
      );
    }
  }
}

const vercelManifest = JSON.parse(
  await Bun.file(`${repositoryRoot}/apps/web/vercel.json`).text(),
) as Record<string, unknown>;
if ("rewrites" in vercelManifest || "routes" in vercelManifest) {
  throw new Error("The Vercel web deployment must not proxy API traffic.");
}

console.info(
  "Wrangler manifests validated for development, preview, and production.",
);
