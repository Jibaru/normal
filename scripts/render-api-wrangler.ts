import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const [outputArgument] = process.argv.slice(2);

if (!outputArgument) {
  throw new Error("usage: render-api-wrangler.ts <output-path>");
}

const requireIdentifier = (name: string): string => {
  const value = process.env[name];
  if (!value || !/^[a-f0-9]{32}$/.test(value)) {
    throw new Error(`${name} must be a 32-character Cloudflare identifier`);
  }
  return value;
};

const sourcePath = resolve(import.meta.dir, "../apps/api/wrangler.jsonc");
const outputPath = resolve(process.cwd(), outputArgument);
const config = JSON.parse(await readFile(sourcePath, "utf8")) as Record<
  string,
  unknown
>;
const rebasePath = (value: string): string =>
  relative(dirname(outputPath), resolve(dirname(sourcePath), value)).replaceAll(
    sep,
    "/",
  );

for (const key of ["$schema", "main"]) {
  const value = config[key];
  if (typeof value !== "string") {
    throw new Error(`API Wrangler source config must define string ${key}`);
  }
  config[key] = rebasePath(value);
}

config.hyperdrive = [
  {
    binding: "HYPERDRIVE",
    id: requireIdentifier("CLOUDFLARE_HYPERDRIVE_ID"),
  },
  {
    binding: "WEBHOOK_HYPERDRIVE",
    id: requireIdentifier("CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID"),
  },
];

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
await chmod(outputPath, 0o600);
