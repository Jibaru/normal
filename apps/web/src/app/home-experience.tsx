import { isDeploymentEnvironment, parseApiOrigin } from "../effect/api-origin";
import {
  CLERK_JWT_TEMPLATE,
  isClerkPublishableKey,
} from "../effect/clerk-config";
import { PublicBoundaryJourney } from "./public-boundary-journey";

const environment = process.env.DEPLOYMENT_ENVIRONMENT;
const apiOrigin = parseApiOrigin(process.env.NEXT_PUBLIC_API_ORIGIN);
const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const personalAccountConfiguration =
  apiOrigin !== null &&
  isDeploymentEnvironment(environment) &&
  isClerkPublishableKey(clerkPublishableKey)
    ? {
        clerkJwtTemplate: CLERK_JWT_TEMPLATE,
        mcpAuthorizationsEndpoint: new URL(
          "/v1/mcp-authorizations",
          apiOrigin,
        ).toString(),
        mcpServerUrl: new URL("/mcp", apiOrigin).toString(),
        toolCallLogsEndpoint: new URL(
          "/v1/tool-call-logs",
          apiOrigin,
        ).toString(),
        connectionsEndpoint: new URL(
          "/v1/whatsapp-connections",
          apiOrigin,
        ).toString(),
        connectionSetupEndpoint: new URL(
          "/v1/connection-setups",
          apiOrigin,
        ).toString(),
        personalAccountEndpoint: new URL(
          "/v1/personal-account/bootstrap",
          apiOrigin,
        ).toString(),
        personalAccountDeletionEndpoint: new URL(
          "/v1/personal-account",
          apiOrigin,
        ).toString(),
      }
    : null;

export default function HomeExperience() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="page-shell flex flex-col gap-8">
        <header className="flex max-w-2xl flex-col gap-4">
          <p className="text-sm font-semibold tracking-tight text-primary">
            WhatsApp MCP
          </p>
          <h1 className="text-balance text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">
            Your WhatsApp, connected on your terms.
          </h1>
          <p className="text-pretty text-lg leading-8 text-muted-foreground">
            Connect WhatsApp to the AI tools you choose. You decide which
            account they can use, what they can access, and when access ends.
          </p>
        </header>
        {personalAccountConfiguration === null ? null : (
          <PublicBoundaryJourney {...personalAccountConfiguration} />
        )}
      </section>
    </main>
  );
}
