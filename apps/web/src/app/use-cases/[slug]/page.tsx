import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getContentPage, getContentPages } from "../../content";
import { ResourcePage } from "../../seo-pages";

export const dynamicParams = false;
export async function generateStaticParams() {
  return (await getContentPages("use-cases")).map(({ slug }) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = await getContentPage("use-cases", slug);
  if (!page) return {};
  return {
    title: `${page.title} | Normal`,
    description: page.description,
    alternates: { canonical: `/use-cases/${slug}` },
    openGraph: {
      title: page.title,
      description: page.description,
      type: "article",
    },
  };
}

export default async function UseCasePage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = await getContentPage("use-cases", slug);
  if (!page) notFound();
  const pages = await getContentPages("use-cases");
  const index = pages.findIndex((item) => item.slug === slug);
  const related = [
    pages[(index + 1) % pages.length],
    pages[(index + 2) % pages.length],
    pages[(index + 3) % pages.length],
  ].filter((item): item is NonNullable<typeof item> => item !== undefined);
  return <ResourcePage page={page} related={related} />;
}
