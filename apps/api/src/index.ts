import { createProductionHandler } from "./production";

interface Env {
  readonly AWS_ACCESS_KEY_ID: string;
  readonly AWS_KMS_REGION: string;
  readonly AWS_SECRET_ACCESS_KEY: string;
  readonly AWS_SESSION_TOKEN: string;
  readonly DEPLOYMENT_ENVIRONMENT: string;
  readonly HYPERDRIVE: Hyperdrive;
  readonly KMS_CONTENT_ROOT_KEY_ARN: string;
  readonly PROVIDER_CONTROL: Fetcher;
}

export default {
  fetch(request, env) {
    return createProductionHandler(env)(request);
  },
} satisfies ExportedHandler<Env>;
