import type { ProviderControlService } from "@whatsapp-mcp/contracts/provider-control";
import { createProductionHandler } from "./production";
import { createWorker } from "./worker";

export interface Env {
  readonly AWS_ACCESS_KEY_ID: string;
  readonly AWS_KMS_REGION: string;
  readonly AWS_SECRET_ACCESS_KEY: string;
  readonly AWS_SESSION_TOKEN: string;
  readonly CLERK_API_AUDIENCE: string;
  readonly CLERK_AUTHORIZED_PARTY: string;
  readonly CLERK_ISSUER: string;
  readonly CLERK_JWT_KEY: string;
  readonly DELETION_CAPSULES: R2Bucket;
  readonly DELETION_MARKER_HMAC_SECRET: string;
  readonly DELETION_MARKERS: R2Bucket;
  readonly DEPLOYMENT_ENVIRONMENT: string;
  readonly HYPERDRIVE: Hyperdrive;
  readonly INGESTION_QUEUE: Queue;
  readonly KMS_CONTENT_ROOT_KEY_ARN: string;
  readonly KMS_DELETION_COORDINATOR_KEY_ARN: string;
  readonly OAUTH_KV: KVNamespace;
  readonly PROVIDER_APPROVED_SESSION_CAPACITY: string;
  readonly PROVIDER_CONTROL: Fetcher & ProviderControlService;
  readonly STORED_MEDIA: R2Bucket;
  readonly WEBHOOK_INGRESS: R2Bucket;
}

export default createWorker<Env>({
  fetch: (request, env) => createProductionHandler(env)(request),
});
