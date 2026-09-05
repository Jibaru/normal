import "server-only";

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { compileMDX } from "next-mdx-remote/rsc";
import { type ComponentProps, createElement, type ReactElement } from "react";
import { ChangelogSourceLink } from "./source-link";

interface ChangelogFrontmatter {
  readonly date: string;
  readonly description: string;
  readonly title: string;
}

export interface ChangelogEntry extends ChangelogFrontmatter {
  readonly body: ReactElement;
  readonly slug: string;
}

const changelogRoot = path.join(process.cwd(), "src", "content", "changelog");
const components = {
  a: ChangelogSourceLink,
  h2: (props: ComponentProps<"h2">) => createElement("h3", props),
};

function isFrontmatter(value: unknown): value is ChangelogFrontmatter {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.title === "string" &&
    typeof item.description === "string" &&
    typeof item.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(item.date)
  );
}

export async function getChangelogEntries(): Promise<
  readonly ChangelogEntry[]
> {
  const files = (await readdir(changelogRoot)).filter((file) =>
    file.endsWith(".md"),
  );
  const entries = await Promise.all(
    files.map(async (file) => {
      const source = await readFile(path.join(changelogRoot, file), "utf8");
      const parsed = matter(source);
      if (!isFrontmatter(parsed.data)) {
        throw new Error(`Invalid changelog frontmatter: ${file}`);
      }
      const { content } = await compileMDX<ChangelogFrontmatter>({
        source,
        components,
        options: { parseFrontmatter: true },
      });
      return {
        ...parsed.data,
        body: content,
        slug: file.replace(/\.md$/u, ""),
      };
    }),
  );
  return entries.sort((left, right) => right.date.localeCompare(left.date));
}
