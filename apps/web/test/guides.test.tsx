import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { compileMDX } from "next-mdx-remote/rsc";
import { renderToStaticMarkup } from "react-dom/server";

const guidesRoot = path.join(import.meta.dir, "../src/content/guides");

interface GuideFrontmatter {
  readonly description: string;
  readonly eyebrow: string;
  readonly order: number;
  readonly promise: string;
  readonly title: string;
}

const loadGuideSummaries = async () => {
  const files = (await readdir(guidesRoot)).filter((file) =>
    file.endsWith(".mdx"),
  );
  const pages = await Promise.all(
    files.map(async (file) => {
      const source = await readFile(path.join(guidesRoot, file), "utf8");
      const parsed = matter(source);
      return {
        ...(parsed.data as GuideFrontmatter),
        collection: "guides" as const,
        slug: file.replace(/\.mdx$/u, ""),
      };
    }),
  );
  return pages.sort((left, right) => left.order - right.order);
};

const loadGuideBody = async (slug: string) => {
  const source = await readFile(path.join(guidesRoot, `${slug}.mdx`), "utf8");
  const { content } = await compileMDX<GuideFrontmatter>({
    source,
    options: { parseFrontmatter: true },
  });
  return content;
};

describe("public guides", () => {
  test("publishes the ChatGPT reconnect guide in the guide collection", async () => {
    const pages = await loadGuideSummaries();

    expect(pages).toContainEqual(
      expect.objectContaining({
        slug: "reconnect-normal-mcp-in-chatgpt",
        title: "How to reconnect Normal MCP in ChatGPT",
      }),
    );
  });

  test("links to the reconnect guide from the ChatGPT setup guide", async () => {
    const html = renderToStaticMarkup(
      await loadGuideBody("connect-whatsapp-to-chatgpt"),
    );

    expect(html).toContain("/guides/reconnect-normal-mcp-in-chatgpt");
  });

  test("renders reconnect troubleshooting links and the safe verification prompt", async () => {
    const html = renderToStaticMarkup(
      await loadGuideBody("reconnect-normal-mcp-in-chatgpt"),
    );

    expect(html).toContain("/dashboard/connections");
    expect(html).toContain("/dashboard/authorizations");
    expect(html).toContain(
      "List only the Normal WhatsApp Connections you can access.",
    );
    expect(html).toContain("Personal WhatsApp (3456)");
  });
});
