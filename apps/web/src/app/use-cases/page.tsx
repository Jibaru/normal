import type { Metadata } from "next";
import { getContentPages } from "../content";
import { CollectionPage } from "../seo-pages";

export const metadata: Metadata = {
  title: "WhatsApp AI use cases | Normal",
  description:
    "Explore practical ways to search, summarize, and act on approved WhatsApp context with an MCP Client.",
  alternates: { canonical: "/use-cases" },
};

export default async function UseCasesPage() {
  return (
    <CollectionPage
      collection="use-cases"
      pages={await getContentPages("use-cases")}
    />
  );
}
