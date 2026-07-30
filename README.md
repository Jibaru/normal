# WhatsApp MCP Platform

A Bun-workspace monorepo for the three independently deployed applications
defined by ADR 0002:

- `apps/web`: the Next.js product UI on Vercel
- `apps/api`: the public Cloudflare API Worker
- `apps/provider-control`: the private Cloudflare Worker reachable only through
  an API service binding

Shared modules have explicit subpath exports and no catch-all barrel:

- `packages/domain`: pure domain rules
- `packages/contracts`: product and MCP schemas
- `packages/db`: database configuration, migrations, and tenant repositories
- `packages/wasender`: separate session, control, and webhook-normalization
  boundaries

## Local verification

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Run a deployable locally with Turbo filtering, for example:

```sh
bun run dev --filter=@whatsapp-mcp/web
```

Production and test Effect roots are separate modules. Runtime configuration
cannot select a test Layer, and the production build inspection fails if a test
Layer marker enters a deployable artifact.

See [deployment configuration](docs/configuration.md) and the
[deployment runbook](docs/runbooks/deployment.md).

## Sandcastle

Sandcastle runs issue agents in isolated Docker worktrees. After authenticating
Docker, GitHub CLI, and Codex:

```sh
bun run sandcastle:build-image
bun run sandcastle
```
