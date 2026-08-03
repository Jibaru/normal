import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
        clerkPublishableKey,
        mcpAuthorizationsEndpoint: new URL(
          "/v1/mcp-authorizations",
          apiOrigin,
        ).toString(),
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
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="flex w-full max-w-3xl flex-col gap-8">
        <p className="font-mono text-sm uppercase tracking-[0.2em] text-primary">
          WhatsApp MCP
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">
          Your WhatsApp Connections, under your control.
        </h1>
        <p className="text-lg leading-8 text-muted-foreground">
          The private beta provides one Personal Account with explicit,
          connection-scoped access for approved MCP Clients.
        </p>
        <ul
          aria-label="Personal Account defaults"
          className="grid gap-3 sm:grid-cols-3"
        >
          <li>
            <Card className="h-full" size="sm">
              <CardHeader>
                <CardTitle>Connection limit</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="font-medium">Up to 3 WhatsApp Connections</p>
              </CardContent>
            </Card>
          </li>
          <li>
            <Card className="h-full" size="sm">
              <CardHeader>
                <CardTitle>Media limit</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="font-medium">5 GB Stored Media</p>
              </CardContent>
            </Card>
          </li>
          <li>
            <Card className="h-full" size="sm">
              <CardHeader>
                <CardTitle>Retention</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="font-medium">
                  30-day default Message Retention Policy
                </p>
              </CardContent>
            </Card>
          </li>
        </ul>
        {personalAccountConfiguration === null ? null : (
          <PublicBoundaryJourney {...personalAccountConfiguration} />
        )}
      </section>
    </main>
  );
}
