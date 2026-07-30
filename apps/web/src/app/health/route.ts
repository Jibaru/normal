import { createProductionHealthRoute } from "../../effect/production";

export const dynamic = "force-dynamic";

export const GET = createProductionHealthRoute({
  DEPLOYMENT_ENVIRONMENT: process.env.DEPLOYMENT_ENVIRONMENT,
  NEXT_PUBLIC_API_ORIGIN: process.env.NEXT_PUBLIC_API_ORIGIN,
});
