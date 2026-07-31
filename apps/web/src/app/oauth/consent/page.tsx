import { parseApiOrigin } from "../../../effect/api-origin";
import {
  isClerkJwtTemplate,
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
  const clerkJwtTemplate = process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE;
  const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (
    typeof request !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(request) ||
    apiOrigin === null ||
    !isClerkJwtTemplate(clerkJwtTemplate) ||
    !isClerkPublishableKey(clerkPublishableKey)
  ) {
    return (
      <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
        <p>Authorization request unavailable.</p>
      </main>
    );
  }

  return (
    <ConsentExperience
      clerkJwtTemplate={clerkJwtTemplate}
      clerkPublishableKey={clerkPublishableKey}
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
