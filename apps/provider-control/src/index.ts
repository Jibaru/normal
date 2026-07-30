import {
  createProductionHandler,
  type ProviderControlEnvironment,
} from "./production";

type Env = ProviderControlEnvironment;

export default {
  fetch(request, env) {
    return createProductionHandler(env)(request);
  },
} satisfies ExportedHandler<Env>;
