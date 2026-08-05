import {
  ArrowDown,
  ArrowRight,
  CalendarCheck2,
  Check,
  ListTodo,
  MessagesSquare,
  Reply,
  Search,
  SearchCheck,
  Send,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { FaqAccordion } from "@/components/faq-accordion";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const contactUrl = "https://cal.com/cuevaio/whatsapp-mcp";

const useCases = [
  {
    icon: ListTodo,
    prompt: "What do I need to follow up on today?",
    text: "Turn recent conversations into a short brief of open questions, promises, and decisions.",
    title: "Start the day informed",
  },
  {
    icon: SearchCheck,
    prompt: "What hotel did Valeria recommend for Cusco?",
    text: "Find an address, deadline, recommendation, or decision without searching chat by chat.",
    title: "Find details instantly",
  },
  {
    icon: CalendarCheck2,
    prompt: "Summarize everything related to the launch meeting.",
    text: "Bring the right WhatsApp context into a meeting before the conversation starts.",
    title: "Prepare with context",
  },
  {
    icon: Reply,
    prompt: "Draft a follow up to Marco about the proposal.",
    text: "Turn conversation context into a thoughtful reply, then confirm it before anything is sent.",
    title: "Follow up naturally",
  },
  {
    icon: MessagesSquare,
    prompt: "What did the group decide about Saturday?",
    text: "Collect decisions and unresolved questions from busy group conversations.",
    title: "Coordinate groups",
  },
  {
    icon: UserRoundCheck,
    prompt: "Who was I supposed to introduce Camila to?",
    text: "Remember introductions and personal context that would otherwise get lost.",
    title: "Keep relationships moving",
  },
] as const;

function ContactButton({
  children = "Contact now",
  inverse = false,
}: {
  readonly children?: ReactNode;
  readonly inverse?: boolean;
}) {
  return (
    <a
      className={buttonVariants({
        size: "lg",
        variant: inverse ? "secondary" : "default",
      })}
      href={contactUrl}
      rel="noreferrer"
      target="_blank"
    >
      {children}
      <ArrowRight aria-hidden="true" data-icon="inline-end" />
    </a>
  );
}

function Wordmark() {
  return (
    <a aria-label="Normal home" className="wordmark" href="#top">
      Normal<span aria-hidden="true">.</span>
    </a>
  );
}

export function LandingPage({ account }: { readonly account: ReactNode }) {
  return (
    <main className="landing" id="top">
      <nav aria-label="Main navigation" className="landing-nav landing-shell">
        <Wordmark />
        <div className="landing-nav-links">
          <a href="/use-cases">Use cases</a>
          <a href="/guides">Guides</a>
          <a href="#how-it-works">How it works</a>
          <a href="#control">Control</a>
        </div>
        <ContactButton />
      </nav>

      <section className="hero">
        <div className="hero-copy landing-shell">
          <Badge className="eyebrow" variant="outline">
            WhatsApp MCP for your AI
          </Badge>
          <h1>
            Give your AI access to WhatsApp. <em>Keep control.</em>
          </h1>
          <p className="hero-description">
            Normal securely connects your WhatsApp to the MCP Clients you
            choose. Find conversations, understand context, and send messages
            with your confirmation.
          </p>
          <div className="hero-actions">
            <ContactButton />
            <a className="text-link" href="#use-cases">
              See how it works
              <ArrowDown aria-hidden="true" />
            </a>
          </div>
          <p className="hero-note">
            <ShieldCheck aria-hidden="true" />
            You choose the WhatsApp Connection, permissions, and when access
            ends.
          </p>
        </div>
      </section>

      <section className="tension-section landing-shell">
        <p className="section-kicker">The missing context</p>
        <div className="tension-grid">
          <h2>
            Your AI is useful.
            <br />
            Your conversations are <em>somewhere else.</em>
          </h2>
          <div>
            <p className="tension-copy">
              Plans, decisions, introductions, and documents live inside
              WhatsApp. Your AI cannot help with any of it unless you manually
              copy everything across.
            </p>
            <strong className="tension-close">Normal closes that gap.</strong>
          </div>
        </div>
      </section>

      <section className="benefits-section">
        <div className="landing-shell">
          <p className="section-kicker">What becomes possible</p>
          <h2>Your WhatsApp becomes useful context.</h2>
          <div className="benefit-grid">
            <Card size="sm">
              <CardHeader>
                <div className="card-title-row">
                  <Search aria-hidden="true" />
                  <CardTitle>Find what matters</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription>
                  Ask about a conversation, contact, group, date, or decision
                  without scrolling through weeks of messages.
                </CardDescription>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <div className="card-title-row">
                  <Sparkles aria-hidden="true" />
                  <CardTitle>Understand the conversation</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription>
                  Summarize long chats, collect decisions, and bring important
                  context into your work.
                </CardDescription>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <div className="card-title-row">
                  <Send aria-hidden="true" />
                  <CardTitle>Act when you are ready</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription>
                  Draft and send messages from your MCP Client. Every outbound
                  tool invocation requires your confirmation.
                </CardDescription>
              </CardContent>
            </Card>
          </div>
          <blockquote className="principle-quote">
            “AI should help with your conversations, not quietly take them
            over.”
            <cite>Normal product principle</cite>
          </blockquote>
        </div>
      </section>

      <section className="use-cases landing-shell" id="use-cases">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Use cases</p>
            <h2>One connection. A lot less catching up.</h2>
          </div>
          <p className="section-intro">
            Normal meets you inside the AI tool you already use and brings in
            only the WhatsApp context you ask for.
          </p>
        </div>
        <div className="use-case-grid">
          {useCases.map((item) => (
            <Card key={item.title} size="sm">
              <CardHeader>
                <div className="card-title-row">
                  <item.icon aria-hidden="true" />
                  <CardTitle>{item.title}</CardTitle>
                </div>
                <CardDescription>{item.text}</CardDescription>
              </CardHeader>
              <CardFooter>
                <blockquote className="prompt-quote">
                  “{item.prompt}”
                </blockquote>
              </CardFooter>
            </Card>
          ))}
        </div>
      </section>

      <section className="steps-section" id="how-it-works">
        <div className="landing-shell">
          <div className="section-heading">
            <div>
              <p className="section-kicker">How it works</p>
              <h2>From disconnected to useful in minutes.</h2>
            </div>
            <p className="section-intro">
              No provider credentials to manage. Access stays explicit from
              setup to every tool call.
            </p>
          </div>
          <ol className="steps-grid">
            <li>
              <span>1</span>
              <h3>Connect WhatsApp</h3>
              <p className="step-description">
                Start a secure Connection Setup and scan the temporary QR code
                from your phone.
              </p>
            </li>
            <li>
              <span>2</span>
              <h3>Choose what your AI can do</h3>
              <p className="step-description">
                Grant separate access to connection details, the WhatsApp
                Directory, Stored Messages, or sending.
              </p>
            </li>
            <li>
              <span>3</span>
              <h3>Ask from your MCP Client</h3>
              <p className="step-description">
                Retrieve context and send confirmed messages from the AI tool
                you already use.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="control-section landing-shell" id="control">
        <div className="control-card">
          <div className="control-copy">
            <p className="section-kicker">Control is the product</p>
            <h2>Private conversations deserve explicit permissions.</h2>
            <p>
              Normal keeps access understandable. Every MCP Authorization is
              tied to the connections and capabilities you select.
            </p>
            <blockquote className="control-quote">
              “Useful by permission. Reversible by default.”
            </blockquote>
          </div>
          <div className="control-list">
            {[
              [
                "Connection specific access",
                "Each grant applies only to the WhatsApp Connections you select.",
              ],
              [
                "Read and send are separate",
                "Permission to send never grants permission to read messages.",
              ],
              [
                "Confirmation before sending",
                "Every outbound tool invocation requires Client Confirmation.",
              ],
              [
                "Revoke whenever you want",
                "End an MCP Client’s access without deleting your connection.",
              ],
            ].map(([title, description]) => (
              <div key={title}>
                <Check aria-hidden="true" />
                <p>
                  <strong className="control-title">{title}</strong>
                  <span className="control-description">{description}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        aria-labelledby="faq-title"
        className="faq-section landing-shell"
      >
        <div>
          <p className="section-kicker">Questions, answered</p>
          <h2 id="faq-title">The important details.</h2>
        </div>
        <FaqAccordion />
      </section>

      <section className="account-section landing-shell" id="account">
        <div className="account-heading">
          <p className="section-kicker">Private beta</p>
          <h2>Connect your WhatsApp to Normal.</h2>
          <p>
            Join the waitlist, or continue to your Personal Account if you
            already have access.
          </p>
        </div>
        <div className="account-boundary">{account}</div>
      </section>

      <section className="final-cta">
        <div className="landing-shell">
          <p className="section-kicker">Ready when you are</p>
          <h2>Make WhatsApp useful to your AI.</h2>
          <p>
            Tell us about your workflow, your MCP Client, and what you want
            Normal to help with.
          </p>
          <ContactButton inverse>Book a WhatsApp MCP call</ContactButton>
        </div>
      </section>

      <footer className="landing-footer landing-shell">
        <div className="landing-footer-brand">
          <Wordmark />
          <p>WhatsApp MCP, on your terms.</p>
        </div>
        <nav aria-label="Use case links" className="landing-footer-links">
          <strong>Use cases</strong>
          <a href="/use-cases">All use cases</a>
          <a href="/use-cases/search-whatsapp-conversations">
            Search conversations
          </a>
          <a href="/use-cases/summarize-whatsapp-groups">Summarize groups</a>
          <a href="/use-cases/draft-whatsapp-replies">Draft replies</a>
        </nav>
        <nav aria-label="Guide links" className="landing-footer-links">
          <strong>Guides</strong>
          <a href="/guides">All guides</a>
          <a href="/guides/what-is-whatsapp-mcp">What is WhatsApp MCP?</a>
          <a href="/guides/connect-whatsapp-to-claude">Connect to Claude</a>
          <a href="/guides/whatsapp-mcp-privacy">Privacy and control</a>
        </nav>
        <a
          className="landing-footer-contact"
          href={contactUrl}
          rel="noreferrer"
          target="_blank"
        >
          Contact now <ArrowRight aria-hidden="true" />
        </a>
      </footer>
    </main>
  );
}
