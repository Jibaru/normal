# Deployment configuration

Configuration is validated in each production Effect composition root before a
request is accepted. Production roots accept only `development`, `preview`, or
`production`; `test` is reserved for statically separate test Layers.

| Value | Sensitivity | Consumer | Source and rotation |
| --- | --- | --- | --- |
| `DEPLOYMENT_ENVIRONMENT` | Non-secret | Web, API, provider-control | Set to the deployed environment. Change only as part of a deployment. |
| `NEXT_PUBLIC_API_ORIGIN` | Non-secret | Web browser bundle and web startup validation | OpenTofu sets the same-environment API Worker's bare HTTPS origin. It is frozen into the browser bundle at build time. |
| `DATABASE_URL` | Secret | Database tooling that consumes `@whatsapp-mcp/db/config` | Issue a restricted Neon role URL, store it in the deployment secret store, and rotate it through Neon plus the deployment platform. API production traffic uses Hyperdrive instead. |
| `MIGRATION_DATABASE_URL` | Secret | `bun run db:migrate` and `bun run db:check` | Obtain the direct, unpooled owner URL from the sensitive OpenTofu output. It must be a TLS Neon URL and must never be configured on a Worker or web deployable. Rotate it by rotating the Neon migration-owner password. |
| `NEON_API_KEY` | Secret | OpenTofu Neon provider | Issue an organization-scoped automation key, keep it only in the infrastructure runner, and rotate it in Neon. |
| `CLOUDFLARE_API_TOKEN` | Secret | OpenTofu Cloudflare provider and Wrangler | Scope it to Hyperdrive and the two Workers in the current environment's account. Rotate it in Cloudflare. |
| `CLOUDFLARE_ACCOUNT_ID` | Sensitive identifier | Wrangler | Cloudflare account selected for Worker deployment. |
| `CLOUDFLARE_HYPERDRIVE_ID` | Sensitive identifier | API Wrangler config renderer | Set from OpenTofu output `api_hyperdrive_id`; it is rendered into a mode-0600 generated config, not committed. |
| `CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID` | Sensitive identifier | API Wrangler config renderer | Set from OpenTofu output `webhook_hyperdrive_id`; it is rendered into a mode-0600 generated config, not committed. |
| `AWS_KMS_REGION` | Non-secret | API | Must be exactly `us-east-1`, matching ADR 0013 and the KMS stack region. |
| `KMS_CONTENT_ROOT_KEY_ARN` | Non-secret | API | The environment's `ContentRootKeyArn` CloudFormation output. The production root accepts only a `us-east-1` KMS key ARN. |
| `AWS_ACCESS_KEY_ID` | Secret | API | Short-lived access key from the environment's `ContentRuntimeRole`; rotate before the role session expires. |
| `AWS_SECRET_ACCESS_KEY` | Secret | API | Short-lived secret paired with `AWS_ACCESS_KEY_ID`; never log or commit it. |
| `AWS_SESSION_TOKEN` | Secret | API | Required role-session token. Its absence prevents the API composition root from serving requests. |

The API Worker receives `PROVIDER_CONTROL`, `HYPERDRIVE`, and
`WEBHOOK_HYPERDRIVE` bindings. They are not string environment values and
cannot be supplied by a public request. `/health` remains a non-sensitive
liveness endpoint; every other API route passes the database readiness gate,
and `/ready` returns unavailable unless `HYPERDRIVE` can report exactly the
compiled schema version. Provider-control has no route or custom domain and has
both `workers_dev` and preview URLs disabled, so the service binding is its only
declared ingress. The API also disables generated Cloudflare hostnames and is
public only on its declared custom domain.

The web production root requires `NEXT_PUBLIC_API_ORIGIN` to be a bare HTTPS
origin with no credentials, path, query, or fragment. The Vercel manifest has
no rewrite or proxy to the API. Browser data-plane requests therefore go
directly to the API Worker.

The Wasender media adapter has no hostname, endpoint, redirect, timeout, or
byte-limit environment override. Its production Layer fixes the decrypt
endpoint and approved download hostname to `www.wasenderapi.com`, resolves that
host through bounded DNS-over-HTTPS at `cloudflare-dns.com`, and fails closed
when the per-session authority is empty, non-printable, or otherwise invalid.
The session authority is provider data encrypted under the owning WhatsApp
Connection; it is decrypted only to construct that connection's adapter Layer
and is not a deploy-time environment variable. This fixed configuration keeps
an environment change from broadening the media SSRF boundary.

## Infrastructure inputs

`infra/compute` represents exactly one deployment environment and remote state.
Supply these non-secret values in an operator-owned `.tfvars` file outside the
repository:

| Variable | Purpose |
| --- | --- |
| `deployment_environment` | Exactly `development`, `preview`, or `production`. |
| `cloudflare_account_id` | Account restricted to that environment's authority scope. |
| `cloudflare_zone_id` | Zone that contains the API hostname. |
| `vercel_team_id` | Team restricted to that environment's authority scope. |
| `api_hostname` | Public custom hostname routed to the API Worker. |
| `web_hostname` | Distinct public hostname assigned to the Vercel web project. |

Provider and backend credentials are ambient only:

| Value | Sensitivity | Scope |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | The current environment's account and only Workers Scripts read/write, custom-domain, and Hyperdrive permissions. |
| `VERCEL_API_TOKEN` | Secret | The current environment's Vercel team. |
| AWS workload identity or short-lived credentials | Secret | The current environment's exact state object/lock and state KMS key. |

Never pass provider credentials as OpenTofu variables or write them into a
backend file. Cloudflare Worker bindings and Vercel environment values declared
by the compute topology are non-secret. Future secret bindings must be populated
through the platform secret stores, not through OpenTofu resource arguments
that would serialize them into state.

OpenTofu variables `cloudflare_account_id` and `neon_org_id` for
`infra/production` are supplied through an uncommitted variable file or
`TF_VAR_` environment values. The checked example contains deliberately invalid
placeholders. Production database state contains generated passwords and must
use the encrypted, access-controlled S3-compatible backend configured during
`tofu init`; never store a local production state file.

The API production root also fails closed before serving requests when its KMS
region, key ARN, or any short-lived role credential is absent or invalid.
`KMS_CONTENT_ROOT_KEY_ARN` is safe to place in deployment configuration, while
all three credential values belong in the platform secret store. The SDK
receives redacted Effect configuration values and no credential, plaintext key,
plaintext content, or ciphertext is included in application telemetry.

Example files contain placeholders only. Add secrets with the platform secret
command; never commit a populated environment file or `.dev.vars`.
