import "server-only";

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { compileMDX } from "next-mdx-remote/rsc";
import type { ReactElement } from "react";

export type ContentCollection = "guides" | "use-cases";

export interface ContentFrontmatter {
  readonly title: string;
  readonly description: string;
  readonly eyebrow: string;
  readonly promise: string;
  readonly order: number;
}

export interface ContentSummary extends ContentFrontmatter {
  readonly collection: ContentCollection;
  readonly slug: string;
}

export interface ContentPage extends ContentSummary {
  readonly body: ReactElement;
}

const contentRoot = path.join(process.cwd(), "src", "content");

function isFrontmatter(value: unknown): value is ContentFrontmatter {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.title === "string" &&
    typeof item.description === "string" &&
    typeof item.eyebrow === "string" &&
    typeof item.promise === "string" &&
    typeof item.order === "number"
  );
}

export async function getContentPages(
  collection: ContentCollection,
): Promise<readonly ContentSummary[]> {
  const directory = path.join(contentRoot, collection);
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith(".mdx"),
  );
  const pages = await Promise.all(
    files.map(async (file) => {
      const source = await readFile(path.join(directory, file), "utf8");
      const parsed = matter(source);
      if (!isFrontmatter(parsed.data)) {
        throw new Error(`Invalid SEO frontmatter: ${collection}/${file}`);
      }
      return {
        ...parsed.data,
        collection,
        slug: file.replace(/\.mdx$/, ""),
      };
    }),
  );
  return pages.sort((left, right) => left.order - right.order);
}

export async function getContentPage(
  collection: ContentCollection,
  slug: string,
): Promise<ContentPage | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  let source: string;
  try {
    source = await readFile(
      path.join(contentRoot, collection, `${slug}.mdx`),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const { content, frontmatter } = await compileMDX<ContentFrontmatter>({
    source,
    options: { parseFrontmatter: true },
  });
  if (!isFrontmatter(frontmatter)) {
    throw new Error(`Invalid SEO frontmatter: ${collection}/${slug}.mdx`);
  }
  return { ...frontmatter, body: content, collection, slug };
}

export const collectionLabels: Record<ContentCollection, string> = {
  guides: "Normal guides",
  "use-cases": "WhatsApp AI use cases",
};
