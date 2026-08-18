import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { compileMDX } from "next-mdx-remote/rsc";
import { renderToStaticMarkup } from "react-dom/server";

const guidesRoot = path.join(process.cwd(), "src", "content", "guides");

async function readGuideSource(slug: string) {
  return readFile(path.join(guidesRoot, `${slug}.mdx`), "utf8");
}

async function renderGuide(slug: string) {
  const source = await readGuideSource(slug);
  const { content } = await compileMDX({
    source,
    options: { parseFrontmatter: true },
  });
  return renderToStaticMarkup(content);
}

describe("guides content", () => {
  test("indexes the removal guide", async () => {
    const source = await readGuideSource("remove-normal-from-chatgpt-and-claude");
    const frontmatter = matter(source);

    expect(frontmatter.data.title).toBe(
      "How to remove Normal from ChatGPT and Claude",
    );
  });

  test("renders the removal guide with both client paths and dashboard revocation", async () => {
    const html = await renderGuide("remove-normal-from-chatgpt-and-claude");

    expect(html).toContain("Remove Normal from ChatGPT");
    expect(html).toContain("Remove Normal from Claude");
    expect(html).toContain('/guides/connect-whatsapp-to-chatgpt');
    expect(html).toContain('/guides/connect-whatsapp-to-claude');
    expect(html).toContain('/dashboard/authorizations');
  });

  test("links both setup guides to the removal guide", async () => {
    for (const slug of [
      "connect-whatsapp-to-chatgpt",
      "connect-whatsapp-to-claude",
    ] as const) {
      const html = await renderGuide(slug);
      expect(html).toContain('/guides/remove-normal-from-chatgpt-and-claude');
    }
  });
});
