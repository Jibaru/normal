# Deployment configuration

Configuration is validated in each production Effect composition root before a
request is accepted. Production roots accept only `development`, `preview`, or
`production`; `test` is reserved for statically separate test Layers.

| Value | Sensitivity | Consumer | Source and rotation |
| --- | --- | --- | --- |
| `DEPLOYMENT_ENVIRONMENT` | Non-secret | Web, API, provider-control | Set to the deployed environment. Change only as part of a deployment. |
| `DATABASE_URL` | Secret | Database tooling that consumes `@whatsapp-mcp/db/config` | Issue a restricted Neon role URL, store it in the deployment secret store, and rotate it through Neon plus the deployment platform. API production traffic uses Hyperdrive instead. |
| `MIGRATION_DATABASE_URL` | Secret | `bun run db:migrate` and `bun run db:check` | Obtain the direct, unpooled owner URL from the sensitive OpenTofu output. It must be a TLS Neon URL and must never be configured on a Worker or web deployable. Rotate it by rotating the Neon migration-owner password. |
| `NEON_API_KEY` | Secret | OpenTofu Neon provider | Issue an organization-scoped automation key, keep it only in the infrastructure runner, and rotate it in Neon. |
| `CLOUDFLARE_API_TOKEN` | Secret | OpenTofu Cloudflare provider and Wrangler | Scope it to Hyperdrive and the two Workers in the production account. Rotate it in Cloudflare. |
| `CLOUDFLARE_ACCOUNT_ID` | Sensitive identifier | Wrangler | Production Cloudflare account selected for Worker deployment. |
| `CLOUDFLARE_HYPERDRIVE_ID` | Sensitive identifier | API Wrangler config renderer | Set from OpenTofu output `api_hyperdrive_id`; it is rendered into a mode-0600 generated config, not committed. |
| `CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID` | Sensitive identifier | API Wrangler config renderer | Set from OpenTofu output `webhook_hyperdrive_id`; it is rendered into a mode-0600 generated config, not committed. |

The API Worker receives `PROVIDER_CONTROL`, `HYPERDRIVE`, and
`WEBHOOK_HYPERDRIVE` bindings. They are not string environment values and
cannot be supplied by a public request. `/health` remains a non-sensitive
liveness endpoint; every other API route passes the database readiness gate,
and `/ready` returns unavailable unless `HYPERDRIVE` can report exactly the
compiled schema version. Provider-control has both `workers_dev` and preview
URLs disabled, so the service binding is its only declared ingress.

OpenTofu variables `cloudflare_account_id` and `neon_org_id` are supplied
through an uncommitted variable file or `TF_VAR_` environment values. The
checked example contains deliberately invalid placeholders. Production state
contains generated database passwords and must use the encrypted,
access-controlled S3-compatible backend configured during `tofu init`; never
store a local production state file.

Example files contain non-secret placeholders only. Add secrets with the
platform secret command; never commit a populated environment file.
