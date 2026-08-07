import type { Metadata } from "next";
import { getContentPages } from "../content";
import { CollectionPage } from "../seo-pages";

export const metadata: Metadata = {
  title: "Normal guides",
  description:
    "Learn how Normal works, connect your MCP Client, choose permissions, and understand privacy and retention.",
  alternates: { canonical: "/guides" },
};

export default async function GuidesPage() {
  return (
    <CollectionPage
      collection="guides"
      pages={await getContentPages("guides")}
    />
  );
}
