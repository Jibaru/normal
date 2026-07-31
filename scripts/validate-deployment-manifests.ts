const repositoryRoot = import.meta.dir.replace(/\/scripts$/, "");
const environments = ["development", "preview", "production"] as const;
const deployables = ["api", "provider-control"] as const;
const oauthKvValidationId = "22222222222222222222222222222222";

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
    let configPath = manifestPath;

    if (deployable === "api") {
      configPath = `${repositoryRoot}/.wrangler/manifest-validation/api-${environment}.jsonc`;
      const renderer = Bun.spawn(
        ["bun", "scripts/render-api-wrangler.ts", configPath, environment],
        {
          cwd: repositoryRoot,
          env: {
            ...Bun.env,
            CLOUDFLARE_HYPERDRIVE_ID: "00000000000000000000000000000000",
            CLOUDFLARE_OAUTH_KV_ID: oauthKvValidationId,
            CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID:
              "11111111111111111111111111111111",
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [rendererExitCode, rendererStdout, rendererStderr] =
        await Promise.all([
          renderer.exited,
          new Response(renderer.stdout).text(),
          new Response(renderer.stderr).text(),
        ]);
      if (rendererExitCode !== 0) {
        console.error(`${rendererStdout}\n${rendererStderr}`);
        throw new Error(`Could not render API ${environment} bindings.`);
      }
    }

    const process = Bun.spawn(
      [
        "bun",
        "run",
        "--cwd",
        `apps/${deployable}`,
        "wrangler",
        "deploy",
        "--dry-run",
        "--config",
        configPath,
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

    if (deployable === "api") {
      const requiredBindings = [
        `env.OAUTH_KV (${oauthKvValidationId})`,
        `env.INGESTION_QUEUE (whatsapp-mcp-ingestion${workerSuffix})`,
        `env.WEBHOOK_INGRESS (whatsapp-mcp-webhook-ingress${workerSuffix})`,
        `env.STORED_MEDIA (whatsapp-mcp-stored-media${workerSuffix})`,
        `env.DELETION_MARKERS (whatsapp-mcp-deletion-markers${workerSuffix})`,
      ];
      for (const binding of requiredBindings) {
        if (!output.includes(binding)) {
          throw new Error(
            `API ${environment} is missing required binding ${binding}.`,
          );
        }
      }
    } else if (
      ["KV Namespace", "Queue", "R2 Bucket"].some((resource) =>
        output.includes(resource),
      )
    ) {
      throw new Error(
        `Provider-control ${environment} must receive no OAuth, Queue, or R2 authority.`,
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
