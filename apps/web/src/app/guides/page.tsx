import type { Metadata } from "next";
import { getContentPages } from "../content";
import { CollectionPage } from "../seo-pages";

export const metadata: Metadata = {
  title: "WhatsApp MCP guides | Normal",
  description:
    "Learn how WhatsApp MCP works, connect your MCP Client, choose permissions, and understand privacy and retention.",
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
