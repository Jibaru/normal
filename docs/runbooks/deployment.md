# Deployment and rollback

## Prerequisites

- Bun 1.3.14
- A Cloudflare account with Workers enabled
- A Vercel project whose root directory is `apps/web`
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the operator's secret
  environment, scoped to deploy these two Workers only

No Neon, AWS, Clerk, or Wasender account is required for the canary-only
baseline. Later behaviors must add their real adapters and configuration before
they become reachable.

## Verify

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

`bun run build` performs Wrangler dry-run production bundles for both Workers,
builds the Next.js application, and rejects any production output containing
the test Layer marker.

## Deploy

Deploy the private Worker first so the API service binding always has a target:

```sh
bun --cwd apps/provider-control wrangler deploy
bun --cwd apps/api wrangler deploy
vercel deploy --prod --cwd apps/web
```

Set `DEPLOYMENT_ENVIRONMENT=production` in the Vercel project before deploying.
The Worker manifests set the same non-secret value explicitly.

## Smoke check

The public checks contain no dependency details or credentials:

```sh
curl --fail --silent https://api.example.com/health
curl --fail --silent https://app.example.com/health
```

Verify provider-control through the API's service binding from an authenticated
operator canary once that endpoint is introduced; do not enable `workers.dev`
or preview URLs for provider-control.

## Rollback

Use each platform's immutable deployment history:

1. Roll back the web and API to their last known-good deployments.
2. Roll back provider-control only after callers are compatible with that
   version.
3. Repeat the health checks.

This baseline has no migration or durable-state delta. A later release that
introduces one must document its forward-fix and rollback ordering with that
migration.
