# Working in this repository

This file is the starting point for coding agents. Keep changes narrow, preserve existing user work, and verify behavior at the highest practical boundary.

## Read before changing code

1. Read `CONTEXT.md` and use its exact domain language.
2. Read the ADRs in `docs/adr` that cover the area you will change.
3. Read the relevant contract, configuration, testing, or runbook document under `docs`.
4. Inspect the package manifest and nearby tests before editing an app or package.
5. For Next.js work, follow the special rule at the end of this file.

If a proposed change conflicts with an ADR or a domain invariant, call out the conflict. Do not silently introduce a second model.

## Repository map

* `apps/web` is the Next.js product UI on Vercel.
* `apps/api` is the public Cloudflare Worker. It owns HTTP, OAuth, MCP, webhooks, reconciliation, and public resource access.
* `apps/provider-control` is a private Cloudflare Worker. Provider provisioning and control go through this boundary.
* `apps/deletion-coordinator` continues irreversible deletion work.
* `apps/restore-coordinator` applies deletion and recovery rules after a restore.
* `packages/domain` contains pure domain rules.
* `packages/contracts` contains explicit schemas and public handles.
* `packages/db` contains migrations and RLS aware database access.
* `packages/wasender` is the thin provider seam.
* `infra` contains OpenTofu configuration.
* `scripts` contains operational and validation tools.

Shared packages use explicit subpath exports. Do not add a catch all barrel export.

## Domain language

The glossary in `CONTEXT.md` is authoritative. In particular:

* Say User, not customer or member.
* Say Personal Account, not organization, workspace, or team.
* Say WhatsApp Connection, not WhatsApp session or provider session.
* Say Connection Setup for the QR based setup flow.
* Say MCP Client, not agent or integration.
* Say WhatsApp Conversation, not thread.
* Keep disconnection distinct from Connection Deletion.
* Keep a Send Operation distinct from a Stored Message.

Use the same language in types, functions, test names, errors, UI copy, and docs.

## Architecture boundaries

Keep these boundaries intact:

* The API Worker is the public data plane. `provider-control` is private and reachable through a service binding.
* Provider credentials and provider specific behavior stay behind `packages/wasender` and `apps/provider-control`.
* Neon is authoritative for identity mappings, tenant data, authorization, refresh state, quota reservations, audit records, and lifecycle state. Edge storage must not become an alternate authority.
* Personal Account and WhatsApp Connection ownership must be enforced in database access with RLS, tenant context, and composite foreign keys where applicable.
* Production and test composition roots remain separate. No header, query parameter, environment value, runtime flag, or component alias may select a test implementation in production.
* Runtime configuration may select only `development`, `preview`, or `production`.
* Public identifiers use the prefixed opaque handles defined by the contracts. Do not expose internal database IDs or provider identifiers.
* Browser data requests go directly to the configured API origin. Do not add a Vercel rewrite or proxy that changes this boundary.

Prefer extending an existing deep module over spreading the same decision across handlers, UI, and infrastructure.

## Security and privacy

This system handles private communications. Treat every boundary as security sensitive.

* Fail closed when authentication, authorization, audit persistence, quota enforcement, encryption, or required configuration is unavailable.
* Keep connection selection and every authorization scope explicit. A newly created WhatsApp Connection must not enter an existing grant automatically.
* Read permission and send permission are independent. Send permission never implies message read permission.
* Every outbound tool call requires Client Confirmation. Do not model that confirmation as a server verified security boundary.
* Never automatically retry a Send Operation after an ambiguous provider outcome.
* Never put message content, media, credentials, tokens, full phone numbers, provider payloads, provider identifiers, raw request bodies, or tenant identifiers into logs or telemetry unless an existing allowlisted contract explicitly requires the field.
* Keep cryptographic keys purpose specific. Do not reuse an HMAC key for a new purpose.
* Do not add secret material to Wrangler vars, Vercel config, source files, fixtures, snapshots, or committed environment files.
* Preserve constant shape not found behavior across unknown and cross tenant opaque handles.
* Treat OAuth client IDs, redirects, scopes, token binding, Clerk claims, and authorization presentation data as policy, not ordinary configuration.

Check `docs/configuration.md`, `docs/mcp-contract.md`, and the relevant security ADR before changing any public or authorization boundary.

## Data lifecycle

Every new persisted value needs an explicit answer for:

* its owning Personal Account or WhatsApp Connection
* its encryption boundary
* who can read or mutate it
* its retention period
* its behavior during Connection Deletion and Personal Account Deletion
* its behavior after a database restore
* whether it is safe in audit records and telemetry

Deletion revokes access and key use immediately, then continues provider cleanup and active data purge. Restore logic must not resurrect data or access that deletion already made terminal. Read the deletion and restore ADRs and runbooks before touching lifecycle code.

## Database work

Database changes live in `packages/db` and must use versioned production migrations.

* Preserve RLS and the separation between migration authority and runtime roles.
* Keep bootstrap functions narrow, with fixed search paths and minimum grants.
* Do not give a runtime role broad cross tenant read, update, or delete authority.
* Use database time for retention and expiry rules when the existing model does.
* Keep migrations compatible with the production migration path. Do not edit a migration that has already shipped unless the task explicitly addresses a baseline that has not shipped.
* Test repositories against migrated Postgres behavior. Do not replace database behavior with an in memory repository.

Useful commands:

```sh
bun run db:check
bun run db:migrate
bun run --cwd packages/db test
```

## Testing

Write the smallest test that proves the behavior at the real boundary.

* Pure domain rules can use package unit tests.
* Worker behavior should use the pinned Cloudflare Vitest runtime and invoke fetch, Queue, scheduled, KV, R2, and service binding boundaries as appropriate.
* Database behavior should apply production migrations, switch to the relevant runtime role, and retain production RLS.
* Browser behavior should drive the production built web app with Playwright and cross the browser to API boundary over HTTP.
* Fake only external systems through the dedicated test composition roots.
* Add or update production bundle exclusion checks when introducing controlled test values or markers.

Run focused checks while working, then run the relevant repository checks:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Infrastructure or deployment changes also need the applicable checks:

```sh
bun run validate:infra
bun run manifests:validate
bun run infra:validate
bun run observability:validate
```

Do not weaken or skip a check to make a change pass.

## Code style and workflow

* Use Bun and the pinned workspace dependencies. Do not change package managers.
* Follow the existing Effect composition and error style in the module you touch.
* Parse untrusted input at the boundary with the existing contract schemas.
* Prefer explicit exports and small public interfaces.
* Keep production wiring in production roots and controlled dependencies in test support roots.
* Keep comments focused on invariants and reasons, not line by line narration.
* Update docs and ADRs when a contract, policy, operational step, or architectural decision changes.
* Never overwrite unrelated uncommitted changes.
* Never commit generated build output, local secrets, Terraform plans, or tool caches.

## Operational changes

Deployment, replay, recovery, deletion, key rotation, break glass access, and teardown are runbook driven operations. Read the matching file in `docs/runbooks` before changing or executing one of these flows.

Infrastructure is separated by environment and authority. Keep development, preview, and production state independent. Validate rendered Worker manifests and production bundles instead of assuming source configuration is the deployed configuration.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes. APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
