import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
