import { createProductionHandler } from "./production";

interface Env {
  readonly DEPLOYMENT_ENVIRONMENT: string;
  readonly PROVIDER_CONTROL: Fetcher;
}

export default {
  fetch(request, env) {
    return createProductionHandler(env)(request);
  },
} satisfies ExportedHandler<Env>;
