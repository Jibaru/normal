import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { compileMDX } from "next-mdx-remote/rsc";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceReference } from "../src/app/changelog/source-link";

const changelogRoot = path.join(import.meta.dir, "../src/content/changelog");
const expectedWeeks = [
  "2026-07-27",
  "2026-08-03",
  "2026-08-10",
  "2026-08-17",
  "2026-08-24",
] as const;

interface ChangelogFrontmatter {
  readonly date: string;
  readonly description: string;
  readonly title: string;
}

describe("public changelog", () => {
  test("includes one Markdown entry for every week since the first commit", async () => {
    const files = (await readdir(changelogRoot))
      .filter((file) => file.endsWith(".md"))
      .sort();

    expect(files).toEqual(expectedWeeks.map((week) => `${week}.md`));
  });

  test("renders every entry with valid weekly frontmatter", async () => {
    for (const week of expectedWeeks) {
      const source = await readFile(
        path.join(changelogRoot, `${week}.md`),
        "utf8",
      );
      const parsed = matter(source);
      const frontmatter = parsed.data as ChangelogFrontmatter;
      expect(frontmatter.date).toBe(week);
      expect(frontmatter.title.length).toBeGreaterThan(0);
      expect(frontmatter.description.length).toBeGreaterThan(0);

      const { content } = await compileMDX<ChangelogFrontmatter>({
        source,
        options: { parseFrontmatter: true },
      });
      expect(renderToStaticMarkup(content)).toContain("<h2>");
    }
  });

  test("labels linked pull requests and commits with explicit references", () => {
    expect(sourceReference("https://github.com/cuevaio/normal/pull/71")).toBe(
      "PR #71",
    );
    expect(
      sourceReference("https://github.com/cuevaio/normal/commit/f1a3d30"),
    ).toBe("commit f1a3d30");
  });
});
