import { createProductionHandler } from "./production";
import { createWorker } from "./worker";

export interface Env {
  readonly AWS_ACCESS_KEY_ID: string;
  readonly AWS_KMS_REGION: string;
  readonly AWS_SECRET_ACCESS_KEY: string;
  readonly AWS_SESSION_TOKEN: string;
  readonly DELETION_MARKERS: R2Bucket;
  readonly DEPLOYMENT_ENVIRONMENT: string;
  readonly HYPERDRIVE: Hyperdrive;
  readonly INGESTION_QUEUE: Queue;
  readonly KMS_CONTENT_ROOT_KEY_ARN: string;
  readonly OAUTH_KV: KVNamespace;
  readonly PROVIDER_CONTROL: Fetcher;
  readonly STORED_MEDIA: R2Bucket;
  readonly WEBHOOK_INGRESS: R2Bucket;
}

export default createWorker<Env>({
  fetch: (request, env) => createProductionHandler(env)(request),
});
