import { isDeploymentEnvironment, parseApiOrigin } from "../effect/api-origin";
import {
  CLERK_JWT_TEMPLATE,
  isClerkPublishableKey,
} from "../effect/clerk-config";
import { LandingPage } from "./landing-page";
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
    <LandingPage
      account={
        personalAccountConfiguration === null ? null : (
          <PublicBoundaryJourney {...personalAccountConfiguration} />
        )
      }
    />
  );
}
