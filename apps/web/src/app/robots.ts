import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const origin = (
    process.env.NEXT_PUBLIC_WEB_ORIGIN ?? "http://localhost:3000"
  ).replace(/\/$/, "");
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/oauth/"] },
    sitemap: `${origin}/sitemap.xml`,
  };
}
