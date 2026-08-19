declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Environment> {
    protected readonly env: Environment;
  }
}
