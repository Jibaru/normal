# Deployment configuration

Configuration is validated in each production Effect composition root before a
request is accepted. Production roots accept only `development`, `preview`, or
`production`; `test` is reserved for statically separate test Layers.

| Value | Sensitivity | Consumer | Source and rotation |
| --- | --- | --- | --- |
| `DEPLOYMENT_ENVIRONMENT` | Non-secret | Web, API, provider-control | Set to the deployed environment. Change only as part of a deployment. |
| `DATABASE_URL` | Secret | Future API database Layer in `@whatsapp-mcp/db/config` | Issue a restricted Neon role URL, store it in the deployment secret store, and rotate it through Neon plus the deployment platform. It is not consumed by the canary-only deployables yet. |

The API Worker receives a `PROVIDER_CONTROL` Cloudflare service binding. It is
not a string environment value and cannot be supplied by a public request.
The API health boundary fails closed when this required binding is absent.
Provider-control has both `workers_dev` and preview URLs disabled, so the
service binding is its only declared ingress.

Example files contain non-secret placeholders only. Add secrets with the
platform secret command; never commit a populated environment file.
