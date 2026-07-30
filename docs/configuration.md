# Deployment configuration

Configuration is validated in each production Effect composition root before a
request is accepted. Production roots accept only `development`, `preview`, or
`production`; `test` is reserved for statically separate test Layers.

| Value | Sensitivity | Consumer | Source and rotation |
| --- | --- | --- | --- |
| `DEPLOYMENT_ENVIRONMENT` | Non-secret | Web, API, provider-control | Set to the deployed environment. Change only as part of a deployment. |
| `NEXT_PUBLIC_API_ORIGIN` | Non-secret | Web browser bundle and web startup validation | OpenTofu sets the same-environment API Worker's bare HTTPS origin. It is frozen into the browser bundle at build time. |
| `DATABASE_URL` | Secret | Future API database Layer in `@whatsapp-mcp/db/config` | Issue a restricted Neon role URL, store it in the deployment secret store, and rotate it through Neon plus the deployment platform. It is not consumed by the canary-only deployables yet. |

The API Worker receives a `PROVIDER_CONTROL` Cloudflare service binding. It is
not a string environment value and cannot be supplied by a public request.
The API health boundary fails closed when this required binding is absent.
Provider-control has no route or custom domain and has both `workers_dev` and
preview URLs disabled, so the service binding is its only declared ingress.
The API also disables generated Cloudflare hostnames and is public only on its
declared custom domain.

The web production root requires `NEXT_PUBLIC_API_ORIGIN` to be a bare HTTPS
origin with no credentials, path, query, or fragment. The Vercel manifest has
no rewrite or proxy to the API. Browser data-plane requests therefore go
directly to the API Worker.

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
| `CLOUDFLARE_API_TOKEN` | Secret | The current environment's account and only Workers Scripts read/write plus custom-domain permissions. |
| `VERCEL_API_TOKEN` | Secret | The current environment's Vercel team. |
| AWS workload identity or short-lived credentials | Secret | The current environment's exact state object/lock and state KMS key. |

Never pass provider credentials as OpenTofu variables or write them into a
backend file. Cloudflare Worker bindings and Vercel environment values declared
by this topology are non-secret. Future secret bindings must be populated
through the platform secret stores, not through OpenTofu resource arguments
that would serialize them into state.

Example files contain non-secret placeholders only. Add secrets with the
platform secret command; never commit a populated environment file.
