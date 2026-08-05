import { parseApiOrigin } from "../../../effect/api-origin";
import {
  CLERK_JWT_TEMPLATE,
  isClerkPublishableKey,
} from "../../../effect/clerk-config";
import { ConsentExperience } from "./consent-experience";

export default async function OAuthConsentPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly request?: string | ReadonlyArray<string> | undefined;
  }>;
}) {
  const request = (await searchParams).request;
  const apiOrigin = parseApiOrigin(process.env.NEXT_PUBLIC_API_ORIGIN);
  const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (
    typeof request !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(request) ||
    apiOrigin === null ||
    !isClerkPublishableKey(clerkPublishableKey)
  ) {
    return (
      <main className="min-h-screen bg-background px-6 py-12 text-foreground">
        <p>Authorization request unavailable.</p>
      </main>
    );
  }

  return (
    <ConsentExperience
      clerkJwtTemplate={CLERK_JWT_TEMPLATE}
      decisionEndpoint={new URL(
        "/v1/oauth/consent/decision",
        apiOrigin,
      ).toString()}
      inspectEndpoint={new URL(
        "/v1/oauth/consent/inspect",
        apiOrigin,
      ).toString()}
      request={request}
    />
  );
}
