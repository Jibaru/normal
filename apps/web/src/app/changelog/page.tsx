import type { Metadata } from "next";
import { ResourceFooter, ResourceHeader } from "../seo-pages";
import { getChangelogEntries } from "./content";

export const metadata: Metadata = {
  title: "Changelog | Normal",
  description:
    "Follow the weekly progress of Normal, from new WhatsApp tools to reliability, privacy, and product improvements.",
  alternates: { canonical: "/changelog" },
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

function formatWeek(date: string) {
  return `Week of ${dateFormatter.format(new Date(`${date}T00:00:00Z`))}`;
}

export default async function ChangelogPage() {
  const entries = await getChangelogEntries();

  return (
    <main className="resource-site">
      <ResourceHeader />
      <section className="changelog-hero resource-shell">
        <p className="section-kicker">Built in public</p>
        <h1>Changelog</h1>
        <p>
          A weekly record of what changed in Normal, distilled from the work
          shipped in the open source repository.
        </p>
      </section>
      <section
        aria-label="Weekly changelog entries"
        className="changelog-list resource-shell"
      >
        {entries.map((entry) => (
          <article className="changelog-entry" id={entry.slug} key={entry.slug}>
            <div className="changelog-entry-meta">
              <time dateTime={entry.date}>{formatWeek(entry.date)}</time>
              <a aria-label={`Link to ${entry.title}`} href={`#${entry.slug}`}>
                Permalink
              </a>
            </div>
            <div className="changelog-entry-content">
              <header>
                <h2>{entry.title}</h2>
                <p>{entry.description}</p>
              </header>
              <div className="resource-mdx">{entry.body}</div>
            </div>
          </article>
        ))}
      </section>
      <ResourceFooter />
    </main>
  );
}
