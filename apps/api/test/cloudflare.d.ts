declare namespace Cloudflare {
  interface Env {
    readonly INGESTION_QUEUE: Queue;
    readonly OAUTH_KV: KVNamespace;
    readonly PROVIDER_CONTROL: Fetcher;
    readonly WEBHOOK_INGRESS: R2Bucket;
  }

  interface GlobalProps {
    mainModule:
      | typeof import("../src/index")
      | typeof import("./support/public-boundary-worker");
  }
}
