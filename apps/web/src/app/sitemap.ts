import type { MetadataRoute } from "next";
import { getContentPages } from "./content";

function siteOrigin() {
  const configured = process.env.NEXT_PUBLIC_WEB_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  return "http://localhost:3000";
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  const pages = [
    ...(await getContentPages("guides")),
    ...(await getContentPages("use-cases")),
  ];
  return [
    { url: origin, priority: 1, changeFrequency: "weekly" },
    { url: `${origin}/guides`, priority: 0.8, changeFrequency: "weekly" },
    { url: `${origin}/use-cases`, priority: 0.8, changeFrequency: "weekly" },
    { url: `${origin}/changelog`, priority: 0.7, changeFrequency: "weekly" },
    ...pages.map((page) => ({
      url: `${origin}/${page.collection}/${page.slug}`,
      priority: 0.7,
      changeFrequency: "monthly" as const,
    })),
  ];
}
