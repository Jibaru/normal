import { type ApiEnvironment, createProductionHandler } from "./production";

interface Env extends ApiEnvironment {
  readonly PROVIDER_CONTROL: Fetcher;
}

export default {
  fetch(request, env) {
    return createProductionHandler(env)(request);
  },
} satisfies ExportedHandler<Env>;
