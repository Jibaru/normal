# Deployment and rollback

## Prerequisites

- Bun 1.3.14
- OpenTofu 1.11.7
- A Cloudflare account with Workers enabled
- A Neon organization with a plan that supports a 30-day history window
- A Vercel project whose root directory is `apps/web`
- An encrypted, access-controlled S3-compatible OpenTofu state backend
- `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID` in the
  operator's secret environment, scoped to the production resources only

AWS, Clerk, and Wasender accounts are not required for this database
foundation. Later behaviors must add their real adapters and configuration
before they become reachable.

## Verify

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run infra:validate
bun run build
```

`bun run build` performs Wrangler dry-run production bundles for both Workers,
builds the Next.js application, and rejects any production output containing
the test Layer marker.

## Provision Neon and Hyperdrive

Copy `infra/production/production.tfvars.example` outside the repository or to
an ignored filename, replace its placeholders, and initialize the encrypted
remote backend. Backend values are intentionally not committed:

```sh
tofu -chdir=infra/production init \
  -backend-config="bucket=replace-with-state-bucket" \
  -backend-config="key=whatsapp-mcp/production.tfstate" \
  -backend-config="region=us-east-1"
tofu -chdir=infra/production plan \
  -var-file=/secure/path/production.tfvars \
  -out=/secure/path/production.tfplan
tofu -chdir=infra/production apply /secure/path/production.tfplan
```

The plan creates one protected Neon project in `aws-us-east-1`, configures
2,592,000 seconds (30 days) of history, creates separate API and webhook
runtime roles, and creates non-caching TLS Hyperdrive configurations. Neon
control-plane roles initially inherit `neon_superuser`; migration 0001 revokes
that membership and enforces `NOSUPERUSER`, `NOBYPASSRLS`, and the remaining
restricted attributes before the schema can report ready.

Run migrations directly as the database owner, never through Hyperdrive:

```sh
export MIGRATION_DATABASE_URL="$(
  tofu -chdir=infra/production output -raw migration_database_url
)"
bun run db:migrate
bun run db:check
unset MIGRATION_DATABASE_URL
```

Migration execution takes a session-level advisory lock, applies each version
in its own transaction, records a SHA-256 checksum, and refuses a changed or
newer-than-expected schema. An interrupted migration rolls back its version;
rerun `bun run db:migrate` after correcting the cause. Never edit an applied
migration—add a new forward migration.

## Deploy

Deploy the private Worker first so the API service binding always has a target:

```sh
CI=true bun run --cwd apps/provider-control wrangler deploy
export CLOUDFLARE_HYPERDRIVE_ID="$(
  tofu -chdir=infra/production output -raw api_hyperdrive_id
)"
export CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID="$(
  tofu -chdir=infra/production output -raw webhook_hyperdrive_id
)"
bun scripts/render-api-wrangler.ts apps/api/.wrangler/production.jsonc
CI=true bun run --cwd apps/api wrangler deploy \
  --config .wrangler/production.jsonc
unset CLOUDFLARE_HYPERDRIVE_ID CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID
vercel deploy --prod --cwd apps/web
```

Set `DEPLOYMENT_ENVIRONMENT=production` in the Vercel project before deploying.
The Worker manifests set the same non-secret value explicitly. The rendered
API config is mode `0600`, ignored by Git, and fails generation unless both
real 32-character Hyperdrive identifiers are present.

## Smoke check

The public checks contain no dependency details or credentials:

```sh
curl --fail --silent https://api.example.com/health
curl --fail --silent https://api.example.com/ready
curl --fail --silent https://app.example.com/health
```

The readiness response proves a restricted Hyperdrive connection can read the
exact expected schema version. It emits only an allowlisted request outcome;
database URLs, SQL, tenant identifiers, and migration errors are never logged.
Verify provider-control through the API's service binding from an authenticated
operator canary once that endpoint is introduced; do not enable `workers.dev`
or preview URLs for provider-control.

## Rollback

Use each platform's immutable deployment history:

1. Roll back the web and API to their last known-good deployments.
2. Roll back provider-control only after callers are compatible with that
   version.
3. Repeat the health checks.

Database migrations are forward-only. If application rollback would target a
binary whose compiled schema version differs from production, it will fail
closed; deploy a forward-compatible application or forward-fix migration
instead of deleting migration records or reverting tenant-isolation DDL. For a
failed, unrecorded migration, correct the cause and rerun the serialized
migration command before deploying application traffic.
