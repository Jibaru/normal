# Drizzle native RLS assessment

## Recommendation

Keep the current PostgreSQL RLS architecture. The repository already uses Drizzle's native `pgPolicy` declarations for its tenant policies, so there is no architectural migration to make. Continue treating versioned production SQL migrations and PostgreSQL as the security authority.

Do not replace the explicit `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, restricted runtime roles, grants, bootstrap functions, transaction scoped `public.personal_account_id`, or migrated Postgres isolation tests with a Drizzle helper. Drizzle's RLS API is a schema and migration representation of PostgreSQL RLS, not another enforcement layer. [D1] [P1]

## What the repository does today

* ADR 0015 defines the model: narrow `SECURITY DEFINER` bootstrap functions resolve a verified identity, each later transaction establishes one Personal Account identifier, and RLS plus composite tenant foreign keys enforce isolation. Normal runtime roles are neither table owners nor `BYPASSRLS` roles. [R1]
* The TypeScript schema already attaches `pgPolicy(...)` declarations to tenant tables. There are 32 declarations across the account, Connection Setup, WhatsApp Connection, MCP Authorization, tool call, directory, webhook, send, and Stored Message schema modules. [R2]
* The production baseline migration explicitly enables and forces RLS on those tenant tables, creates their policies, and grants only selected operations to restricted runtime roles. [R3]
* Repository methods establish `public.personal_account_id` with transaction local `set_config(..., true)`, and the authorization isolation matrix applies production migrations, switches to operational roles, and verifies tenant isolation and the absence of `BYPASSRLS`. [R4] [R5]

## What adopting more Drizzle declarations would and would not do

Drizzle documents `pgTable.withRLS()` for a table that needs RLS without a policy, and states that attaching a `pgPolicy` automatically enables RLS. Its policy fields directly represent PostgreSQL policy choices such as permissive or restrictive behavior, applicable roles and commands, `USING`, and `WITH CHECK`. The existing schema therefore already uses the relevant native policy API; adding `withRLS()` to the same policy bearing tables would be redundant under the documented behavior. [D1]

PostgreSQL remains the enforcement boundary. Once RLS is enabled, ordinary row access must be allowed by an applicable policy, while a table with no applicable policy is default deny. RLS does not replace ordinary privileges, and whole table operations such as `TRUNCATE` and `REFERENCES` are outside row security. [P1]

The explicit `FORCE ROW LEVEL SECURITY` statements should remain. PostgreSQL states that superusers and `BYPASSRLS` roles always bypass RLS and table owners normally bypass it unless the table is forced to apply RLS to its owner. The linked Drizzle page documents enabling RLS and defining policies, but does not document a `FORCE ROW LEVEL SECURITY` table declaration. [P1] [D1]

Role ownership should also remain explicit. Drizzle can declare roles, but Drizzle Kit does not manage them by default; role management must be opted into, and externally managed roles can be marked as existing or excluded. This repository's role attributes, memberships, narrow grants, bootstrap functions, and operational privileges form one security design in the migration. Moving only part of it into `pgRole` declarations would create two sources of truth without improving enforcement. [D1] [R3]

Finally, native declarations do not remove runtime tenant context. The policy expressions still read `current_setting('public.personal_account_id', true)`, so application database work must continue to set that value inside the same transaction before tenant queries. Drizzle's own RLS example likewise wraps work in a transaction and establishes transaction local claims and role before executing the callback. [D1] [R4]

## Practical next step

No RLS redesign is warranted. Keep `pgPolicy` as the schema level description and keep explicit production migrations as the deployable security contract. If schema drift becomes a problem, add a focused validation that compares migrated tables, RLS enabled and forced flags, policies, role attributes, and grants against the intended matrix. Do not infer `FORCE`, roles, grants, or tenant context correctness merely from the presence of `pgPolicy` in TypeScript.

## Sources

* **[D1]** Drizzle ORM, Row Level Security: https://orm.drizzle.team/docs/rls
* **[P1]** PostgreSQL 18 documentation, Row Security Policies: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
* **[R1]** `docs/adr/0015-bootstrap-tenant-context-with-narrow-functions.md`
* **[R2]** `packages/db/src/schema/accounts.ts`, `connection-setups.ts`, `connections.ts`, `directory.ts`, `mcp-authorizations.ts`, `messages.ts`, `sends.ts`, `tool-calls.ts`, and `webhooks.ts`
* **[R3]** `packages/db/drizzle/0000_baseline.sql`
* **[R4]** Tenant repository methods under `packages/db/src`, including `personal-account.ts`, `whatsapp-connection.ts`, `mcp-authorization.ts`, `mcp-tool.ts`, and `send.ts`
* **[R5]** `packages/db/test/authorization-isolation-matrix.test.ts`
