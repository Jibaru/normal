import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

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

const sourcePath = resolve(
  import.meta.dir,
  "../apps/recovery-game-day/wrangler.jsonc",
);
const resolvedOutputPath = resolve(process.cwd(), outputPath);
const source = await readFile(sourcePath, "utf8");
const config = Bun.JSONC.parse(
  source.replaceAll("33333333333333333333333333333333", namespaceId),
) as Record<string, unknown>;
const rebasePath = (value: string) =>
  relative(
    dirname(resolvedOutputPath),
    resolve(dirname(sourcePath), value),
  ).replaceAll(sep, "/");
for (const key of ["$schema", "main"]) {
  const value = config[key];
  if (typeof value !== "string")
    throw new Error(
      `Recovery game-day Wrangler source must define string ${key}`,
    );
  config[key] = rebasePath(value);
}
await mkdir(dirname(resolvedOutputPath), { recursive: true });
await writeFile(resolvedOutputPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
await chmod(resolvedOutputPath, 0o600);
