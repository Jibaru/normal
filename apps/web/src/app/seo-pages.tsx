import { ArrowRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { ModeToggle } from "@/components/mode-toggle";
import type { ContentCollection, ContentPage, ContentSummary } from "./content";
import { collectionLabels } from "./content";

const contactUrl = "https://cal.com/cuevaio/whatsapp-mcp";
const docsUrl = "https://docs.normal.fast";
const sourceUrl = "https://github.com/cuevaio/normal";

function Header() {
  return (
    <header className="resource-header resource-shell">
      <Link className="wordmark" href="/">
        Normal<span aria-hidden="true">.</span>
      </Link>
      <nav aria-label="Resources">
        <Link href="/use-cases">Use cases</Link>
        <Link href="/guides">Guides</Link>
        <a href={docsUrl} rel="noreferrer" target="_blank">
          Docs
        </a>
        <a href={sourceUrl} rel="noreferrer" target="_blank">
          GitHub
        </a>
      </nav>
      <div className="resource-header-actions">
        <ModeToggle />
        <a href={contactUrl} rel="noreferrer" target="_blank">
          Contact <ArrowRight aria-hidden="true" />
        </a>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="resource-footer resource-shell">
      <Link className="wordmark" href="/">
        Normal<span aria-hidden="true">.</span>
      </Link>
      <p>Normal, on your terms.</p>
      <nav aria-label="Developer resources">
        <a href={docsUrl} rel="noreferrer" target="_blank">
          Docs
        </a>
        <a href={sourceUrl} rel="noreferrer" target="_blank">
          GitHub
        </a>
        <a href={contactUrl} rel="noreferrer" target="_blank">
          Contact
        </a>
      </nav>
    </footer>
  );
}

export function CollectionPage({
  collection,
  pages,
}: {
  readonly collection: ContentCollection;
  readonly pages: readonly ContentSummary[];
}) {
  const isGuide = collection === "guides";
  return (
    <main className="resource-site">
      <Header />
      <section className="resource-collection-hero resource-shell">
        <p className="section-kicker">
          {isGuide ? "Learn" : "What becomes possible"}
        </p>
        <h1>{collectionLabels[collection]}</h1>
        <p>
          {isGuide
            ? "Practical explanations for connecting WhatsApp to an MCP Client, choosing permissions, and understanding how your data is handled."
            : "Practical ways to find, understand, and act on approved WhatsApp context from the AI application you already use."}
        </p>
      </section>
      <section
        className="resource-grid resource-shell"
        aria-label={collectionLabels[collection]}
      >
        {pages.map((page) => (
          <Link href={`/${collection}/${page.slug}`} key={page.slug}>
            <span>{page.eyebrow}</span>
            <h2>{page.title}</h2>
            <p>{page.description}</p>
            <strong>
              Read {isGuide ? "guide" : "use case"}{" "}
              <ArrowRight aria-hidden="true" />
            </strong>
          </Link>
        ))}
      </section>
      <Footer />
    </main>
  );
}

export function ResourcePage({
  page,
  related,
}: {
  readonly page: ContentPage;
  readonly related: readonly ContentSummary[];
}) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: page.title,
    description: page.description,
    author: { "@type": "Organization", name: "Normal" },
  };
  return (
    <main className="resource-site">
      <Header />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON is generated from trusted local MDX frontmatter and escaped before rendering.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(schema).replaceAll("<", "\\u003c"),
        }}
      />
      <article>
        <header className="resource-hero resource-shell">
          <nav aria-label="Breadcrumb" className="resource-breadcrumbs">
            <Link href="/">Home</Link>
            <span aria-hidden="true">/</span>
            <Link href={`/${page.collection}`}>
              {collectionLabels[page.collection]}
            </Link>
          </nav>
          <p className="section-kicker">{page.eyebrow}</p>
          <h1>{page.title}</h1>
          <p className="resource-promise">{page.promise}</p>
        </header>
        <div className="resource-article resource-shell">
          <aside>
            <ShieldCheck aria-hidden="true" />
            <strong>Control stays explicit</strong>
            <span>
              You choose each WhatsApp Connection and permission. Send access
              never implies message read access.
            </span>
          </aside>
          <div className="resource-mdx">{page.body}</div>
        </div>
        <section className="resource-related resource-shell">
          <p className="section-kicker">Keep exploring</p>
          <h2>
            Related {page.collection === "guides" ? "guides" : "use cases"}
          </h2>
          <div>
            {related.map((item) => (
              <Link href={`/${item.collection}/${item.slug}`} key={item.slug}>
                <span>{item.eyebrow}</span>
                <strong>{item.title}</strong>
                <ArrowRight aria-hidden="true" />
              </Link>
            ))}
          </div>
        </section>
        <section className="resource-cta">
          <div className="resource-shell">
            <p className="section-kicker">Private beta</p>
            <h2>Make WhatsApp useful to your AI.</h2>
            <p>
              Tell us about your workflow and the MCP Client you want to use.
            </p>
            <a href={contactUrl} rel="noreferrer" target="_blank">
              Book a Normal call <ArrowRight aria-hidden="true" />
            </a>
          </div>
        </section>
      </article>
      <Footer />
    </main>
  );
}
