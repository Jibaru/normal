declare namespace Cloudflare {
  interface Env {
    readonly STORED_MEDIA: R2Bucket;
  }

  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}
