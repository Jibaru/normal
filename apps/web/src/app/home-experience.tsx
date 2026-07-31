import { isDeploymentEnvironment, parseApiOrigin } from "../effect/api-origin";
import {
  isClerkJwtTemplate,
  isClerkPublishableKey,
} from "../effect/clerk-config";
import { PublicBoundaryJourney } from "./public-boundary-journey";

const environment = process.env.DEPLOYMENT_ENVIRONMENT;
const apiOrigin = parseApiOrigin(process.env.NEXT_PUBLIC_API_ORIGIN);
const clerkJwtTemplate = process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE;
const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const personalAccountConfiguration =
  apiOrigin !== null &&
  isDeploymentEnvironment(environment) &&
  isClerkJwtTemplate(clerkJwtTemplate) &&
  isClerkPublishableKey(clerkPublishableKey)
    ? {
        clerkJwtTemplate,
        clerkPublishableKey,
        endpoint: new URL(
          "/v1/personal-account/bootstrap",
          apiOrigin,
        ).toString(),
      }
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
        {personalAccountConfiguration === null ? null : (
          <PublicBoundaryJourney {...personalAccountConfiguration} />
        )}
      </section>
    </main>
  );
}
