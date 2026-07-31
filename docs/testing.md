# Public-boundary testing

Public behavior is tested at the highest available boundary. Browser tests use
Playwright against a production `next build`/`next start` server and cross the
browser-to-API boundary over HTTP. Worker tests run inside the pinned
`@cloudflare/vitest-pool-workers` runtime and invoke fetch, Queue, and scheduled
handlers with local KV, R2, Queue, and service bindings.

## Test composition roots

External identity, provider behavior, time, identifiers, and controlled
failures are deterministic Effect services composed only by
`apps/api/test/support/public-boundary-worker.ts`. The browser uses the same
test-only Worker through `apps/api/test/wrangler.browser.jsonc`; production
Worker entrypoints never import that module and accept no header, query,
environment value, or runtime flag that enables it.

The test root supplies its Layers to `createPublicBoundaryWorker` from
`apps/api/src/public-boundary-worker.ts`. Public HTTP routing, binding calls,
Queue acknowledgement, and scheduled work therefore remain application code;
the fixture contains only deterministic external services and fault
selection. The runtime suite also invokes the deployed production Worker
export directly before exercising the Layer-composed boundary root.

The browser journey sends a deterministic external identity credential to the
test API Worker. It does not replace a React component, application handler, or
repository. As signed-in product behavior is added, journeys should keep the
same shape: drive the production-built web app, cross directly to the API
Worker, and fake only external organizations through the test composition
root.

The MCP Authorization management journey lists and revokes through that same
browser-to-Worker seam. Database coverage separately applies the production
migrations and switches to `whatsapp_api_runtime` to prove RLS isolation,
idempotent atomic authorization/family revocation, and immediate access and
refresh denial. The HTTP fixture contains only safe product metadata and never
models or returns token material.

The browser always renders `apps/web/src/app/home-experience.tsx`; there is no
test component alias or selectable web composition root. Playwright supplies
only the external Clerk-shaped identity boundary and test network routing from
the configured HTTPS API origin to the local Wrangler process. The component,
event handling, credential lookup, request construction, and response
rendering are the production UI path.

The Worker runtime suite proves:

- the actual fetch boundary and CORS behavior;
- deterministic identity, provider, clock, and identifier Layers;
- active and exhausted private-beta admission outcomes;
- controlled external failure behavior;
- KV and R2 persistence through real local bindings;
- Queue publication and explicit consumer acknowledgement;
- provider-control service-binding calls;
- scheduled-handler effects through the supported runtime helpers;
- an OAuth authorization redirect over signed-in HTTP;
- MCP tool discovery over HTTP JSON-RPC; and
- an authenticated, non-cacheable protected-resource read.

Controlled values, credentials, and failure selection are reachable only from
the test Worker composition root. The HTTP and event handlers live under
`apps/api/src`; production entrypoints never import the test root, and bundle
inspection proves that the test Layer and its controls are absent. The
test-only readiness and binding-probe routes are not production diagnostics.

## Database boundary

Database tests apply the versioned production migrations to an isolated PGlite
Postgres environment. Fixture setup may use migration authority, but behavior
and adversarial checks switch to `whatsapp_api_runtime` or
`whatsapp_webhook_runtime`, use transaction-local Personal Account or
WhatsApp Connection context, and retain the production RLS policies, bootstrap
functions, and composite tenant foreign keys. Do not replace repositories with
in-memory implementations when data is involved.

## Commands

Install the pinned Chromium build and its host dependencies once:

```sh
bun x playwright install --with-deps chromium
```

Run the coordinated suite:

```sh
bun run test
```

The API public-boundary suite can be run alone with:

```sh
cd apps/api
bun x vitest run --config vitest.public-boundary.config.ts
```

The browser suite can be run alone from `apps/web` with:

```sh
bun x playwright test
```

Playwright starts a test-only Wrangler API Worker and a production Next.js
server automatically. It never requires a Clerk tenant, Provider Account,
Provider API Credential, or production data.

## Production exclusion

`bun run build` inspects both Worker outputs plus Next.js server and browser
chunks. The build fails if any test Layer, controlled identity credential, or
fault-injection marker is present. Production configuration accepts only
`development`, `preview`, or `production`; no production build variable,
runtime flag, component alias, header, or query parameter can select a test
composition root.

The harness adds no production binding or infrastructure authority. It uses
ephemeral local implementations of the bindings already declared for the API
Worker, and the browser-specific Wrangler manifest is under `apps/api/test`.
