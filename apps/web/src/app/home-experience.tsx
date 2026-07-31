import { isDeploymentEnvironment, parseApiOrigin } from "../effect/api-origin";
import { PublicBoundaryJourney } from "./public-boundary-journey";

const environment = process.env.DEPLOYMENT_ENVIRONMENT;
const apiOrigin = parseApiOrigin(process.env.NEXT_PUBLIC_API_ORIGIN);
const personalAccountEndpoint =
  apiOrigin !== null && isDeploymentEnvironment(environment)
    ? new URL("/v1/personal-account", apiOrigin).toString()
    : null;

export default function HomeExperience() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <section className="max-w-xl space-y-6">
        <p className="font-mono text-sm uppercase tracking-[0.2em] text-emerald-400">
          WhatsApp MCP
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">
          Your WhatsApp Connections, under your control.
        </h1>
        <p className="text-lg leading-8 text-zinc-300">
          The private beta provides one Personal Account with explicit,
          connection-scoped access for approved MCP Clients.
        </p>
        {personalAccountEndpoint === null ? null : (
          <PublicBoundaryJourney endpoint={personalAccountEndpoint} />
        )}
      </section>
    </main>
  );
}
