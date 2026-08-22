---
status: implemented
---

# Public API - Frame

Implemented. The public REST API, API Key management, Activity Log, and static Scalar app at `docs.normal.fast` shipped. Treat this frame as the accepted contract, not an open shaping document.

## Source

> i want us to build an api. we have the mcp. but we also need an api. users can create api keys in the dashboard. we should also add docs with scalar.

## Problem

Normal's Cloudflare API Worker already serves the signed-in product and the OAuth-protected MCP server, but it has no public HTTP contract for server-side automations. A User cannot create a durable API Key, select its permissions and WhatsApp Connections, call conventional REST resources, inspect those calls in the product, or read a public OpenAPI reference.

The existing MCP implementation contains the required WhatsApp capabilities, privacy rules, audit-before-release behavior, quotas, and send safety, but its transport envelopes, OAuth authority, cursors, protected-resource URIs, and confirmation metadata are MCP-specific. Exposing the existing signed-in product handlers or translating MCP tool names directly into HTTP paths would create the wrong public contract and risk bypassing current authorization and audit invariants.

## Outcome

A User can create up to ten named API Keys for server-side personal automations, select any subset of the same four permissions used by MCP, select explicit non-deleted WhatsApp Connections, optionally set expiry, copy the secret once, list safe metadata, and permanently revoke a key. The public API exposes all current MCP capabilities through conventional nested REST resources on the existing API Worker.

Every protected request authenticates and authorizes against Neon, remains tenant-scoped under RLS, appears in a unified Activity Log, shares Personal Account safety quotas with MCP, and preserves Recipient Exclusions, retention, deletion, restore, idempotency, and ambiguous-send behavior. A separate static Astro app at `docs.normal.fast` renders the generated OpenAPI 3.1 contract with the official Scalar component and no custom UI components.

## Non-Goals

- Third-party delegated integrations or multi-User applications; those require OAuth rather than User-created API Keys.
- Browser or mobile-app API Key use, API-key CORS, or an interactive browser API client.
- Connection Setup, WhatsApp Connection lifecycle management, retention changes, Recipient Exclusion management, Personal Account lifecycle, or webhook subscriptions through the public API.
- API Key mutation, temporary disable, recovery, rerolling, or plaintext redisplay.
- Generated SDK publication in v1.
- A second public data-plane Worker, a Next.js proxy, Unkey, or another authorization authority.
