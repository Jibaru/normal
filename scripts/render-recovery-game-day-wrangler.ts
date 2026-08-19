const [outputPath, environment] = process.argv.slice(2);
if (
  !outputPath ||
  !environment ||
  !["development", "preview", "production"].includes(environment)
)
  throw new Error(
    "usage: render-recovery-game-day-wrangler <output> <environment>",
  );

const namespaceId = process.env.CLOUDFLARE_RECOVERY_KV_ID;
if (!namespaceId || !/^[0-9a-f]{32}$/u.test(namespaceId))
  throw new Error(
    "CLOUDFLARE_RECOVERY_KV_ID must be a lowercase Cloudflare identifier",
  );

const source = await Bun.file(
  `${import.meta.dir}/../apps/recovery-game-day/wrangler.jsonc`,
).text();
const rendered = source.replaceAll(
  "33333333333333333333333333333333",
  namespaceId,
);
await Bun.write(outputPath, rendered, { mode: 0o600 });
