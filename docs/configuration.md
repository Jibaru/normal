# Deployment configuration

Configuration is validated in each production Effect composition root before a
request is accepted. Production roots accept only `development`, `preview`, or
`production`; `test` is reserved for statically separate test Layers.

| Value | Sensitivity | Consumer | Source and rotation |
| --- | --- | --- | --- |
| `DEPLOYMENT_ENVIRONMENT` | Non-secret | Web, API, provider-control | Set to the deployed environment. Change only as part of a deployment. |
| `NEXT_PUBLIC_API_ORIGIN` | Non-secret | Web browser bundle and web startup validation | OpenTofu sets the same-environment API Worker's bare HTTPS origin. It is frozen into the browser bundle at build time. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Public identifier | Web browser bundle and web startup validation | Copy the publishable key from the same-environment Clerk instance. OpenTofu freezes it into that environment's browser bundle. |
| `NEXT_PUBLIC_CLERK_JWT_TEMPLATE` | Non-secret | Web browser bundle and web startup validation | Name of the same-environment Clerk custom JWT template. The default and recommended value is `whatsapp-api`. |
| `CLERK_API_AUDIENCE` | Non-secret | API | Exact bare HTTPS API origin. OpenTofu derives it from `api_hostname`; the custom JWT template's `aud` claim must match it exactly. |
| `CLERK_AUTHORIZED_PARTY` | Non-secret | API | Exact bare HTTPS web origin allowed by both the token `azp` claim and request `Origin`. OpenTofu derives it from `web_hostname`. |
| `CLERK_ISSUER` | Non-secret | API | Exact HTTPS issuer for the same-environment Clerk instance. |
| `CLERK_JWT_KEY` | Secret deployment material | API | PEM public key for the custom Clerk JWT template. Store it only as a Cloudflare Worker secret so verification does not depend on a network lookup. Replace it when Clerk rotates the template signing key. |
| `OAUTH_ISSUER` | Non-secret | API OAuth provider | Exact API HTTPS origin and RFC 8414 issuer. It must equal `CLERK_API_AUDIENCE`; OpenTofu derives both from `api_hostname`. |
| `OAUTH_RESOURCE` | Non-secret | API OAuth provider | Exact protected MCP resource, formed as `OAUTH_ISSUER` plus `/mcp`. |
| `OAUTH_CLIENT_REGISTRY` | Non-secret reviewed policy | API OAuth provider | JSON allowlist rendered from `oauth_clients`, containing each stable MCP Client ID, class, display name, and exact permitted redirects. |
| `OAUTH_PROTOCOL_ENCRYPTION_KEY` | Secret | API OAuth provider | Dedicated 32-byte hex AES key for short-lived consent handoff records. Generate with `openssl rand -hex 32`; never reuse another platform key. |
| `MCP_REQUESTS_PER_MINUTE` | Non-secret approved quota | API MCP resource server | Authoritative per-Personal-Account request reservations allowed in an exact rolling minute. Set the reviewed positive integer through `mcp_requests_per_minute`; there is no production default. |
| `MCP_REQUESTS_PER_HOUR` | Non-secret approved quota | API MCP resource server | Authoritative per-Personal-Account request reservations allowed in an exact rolling hour. Set the reviewed integer through `mcp_requests_per_hour`; it must be at least the minute value and has no production default. |
| `MCP_CURSOR_HMAC_SECRET` | Secret | API MCP resource server | Dedicated 32-byte hex HMAC key for short-lived, authorization-bound pagination cursors. Generate independently with `openssl rand -hex 32`; rotation invalidates every outstanding cursor and must not reuse an OAuth, Directory, webhook, deletion, provider-reference, or content key. |
| `PROVIDER_APPROVED_SESSION_CAPACITY` | Non-secret operational limit | API | Vendor-approved session ceiling for the environment. Set the reviewed integer through `provider_approved_session_capacity`; missing, placeholder, fractional, or values below three fail closed. Increase only after written provider approval. |
| `DATABASE_URL` | Secret | Database tooling that consumes `@whatsapp-mcp/db/config` | Issue a restricted Neon role URL, store it in the deployment secret store, and rotate it through Neon plus the deployment platform. API production traffic uses Hyperdrive instead. |
| `MIGRATION_DATABASE_URL` | Secret | `bun run db:migrate` and `bun run db:check` | Obtain the direct, unpooled owner URL from the sensitive OpenTofu output. It must be a TLS Neon URL and must never be configured on a Worker or web deployable. Rotate it by rotating the Neon migration-owner password. |
| `NEON_API_KEY` | Secret | OpenTofu Neon provider | Issue an organization-scoped automation key, keep it only in the infrastructure runner, and rotate it in Neon. |
| `CLOUDFLARE_API_TOKEN` | Secret | OpenTofu Cloudflare provider and Wrangler | Scope it to the declared Workers, R2, KV, Queues, schedules, Hyperdrive, and API custom domain in the current environment's account. Rotate it in Cloudflare. |
| `CLOUDFLARE_ACCOUNT_ID` | Sensitive identifier | Wrangler | Cloudflare account selected for Worker deployment. |
| `CLOUDFLARE_HYPERDRIVE_ID` | Sensitive identifier | API Wrangler config renderer | Set from OpenTofu output `api_hyperdrive_id`; it is rendered into a mode-0600 generated config, not committed. |
| `CLOUDFLARE_OAUTH_KV_ID` | Sensitive identifier | API Wrangler config renderer | Set from the sensitive `infra/compute` output `oauth_kv_namespace_id`; the renderer rejects a missing or malformed identifier. |
| `CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID` | Sensitive identifier | API Wrangler config renderer | Set from OpenTofu output `webhook_hyperdrive_id`; it is rendered into a mode-0600 generated config, not committed. |
| `AWS_KMS_REGION` | Non-secret | API | Must be exactly `us-east-1`, matching ADR 0013 and the KMS stack region. |
| `KMS_CONTENT_ROOT_KEY_ARN` | Non-secret | API | The environment's `ContentRootKeyArn` CloudFormation output. The production root accepts only a `us-east-1` KMS key ARN. |
| `KMS_DELETION_COORDINATOR_KEY_ARN` | Non-secret | API Deletion Capsule writer | The environment's distinct `DeletionCoordinatorKeyArn` output. The Content Runtime role may encrypt capsules with it but cannot decrypt them. |
| `DELETION_MARKER_HMAC_SECRET` | Secret | API deletion-marker writer | Dedicated 32-byte hex HMAC key for restore-external marker object keys. Generate independently with `openssl rand -hex 32`, retain it in the recovery inventory, and never reuse a provider-reference, webhook, cursor, or content key. |
| `WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET` | Secret | API Connection Setup writer | Dedicated 32-byte hex HMAC key for platform-wide WhatsApp Number reservations. Generate independently with `openssl rand -hex 32`; never reuse Directory index, deletion-marker, provider-reference, webhook, cursor, OAuth, or content keys. Rotation requires rebuilding every retained reservation under a stopped-provisioning migration. |
| `AWS_ACCESS_KEY_ID` | Secret | API | Short-lived access key from the environment's `ContentRuntimeRole`; rotate before the role session expires. |
| `AWS_SECRET_ACCESS_KEY` | Secret | API | Short-lived secret paired with `AWS_ACCESS_KEY_ID`; never log or commit it. |
| `AWS_SESSION_TOKEN` | Secret | API | Required role-session token. Its absence prevents the API composition root from serving requests. |
| `WASENDER_API_CREDENTIAL` | Secret | Provider-control | Account-level Wasender Personal Access Token used only for lifecycle endpoints. Store it as a Worker secret and rotate it in Wasender and Cloudflare together. |
| `WASENDER_REFERENCE_SECRET` | Secret | Provider-control | Stable 32-byte hex HMAC key used to turn raw provider session IDs into opaque adapter locators. Generate with `openssl rand -hex 32`; rotate only through the reconciliation procedure below. |

Wasender Directory reads do not add a platform-wide environment secret. The
owning API workflow decrypts the selected WhatsApp Connection's envelope-
encrypted session authority only for the duration of that connection-scoped
operation and constructs `makeWasenderSessionDirectory` with the resulting
redacted value. The constructor rejects empty, oversized, or control-character
authority values before network access. Its provider origin is fixed in the
production adapter, so configuration cannot redirect credentials to another
host or select a fake implementation.

Directory contact provider identities, display names, and phone numbers are
stored only as connection-scoped envelope ciphertext. The approved derived
normalized display-name sort value and HMAC blind indexes for provider
identity, normalized name prefixes, and exact E.164 lookup are the only query
material. Webhook projection is idempotent and evidence ordered;
the five-minute provider snapshot is authoritative for removals only when it
is complete. `list_contacts` rechecks the live authorization, selected
connection, and contact state, decrypts only inside the API Worker, and returns
at most a nullable display name plus the final four phone digits. A projection
older than ten minutes is reported as stale even if the last provider read had
succeeded.

The API Worker receives `PROVIDER_CONTROL`, `HYPERDRIVE`,
`WEBHOOK_HYPERDRIVE`, `OAUTH_KV`, `WEBHOOK_INGRESS`, `STORED_MEDIA`,
`DELETION_CAPSULES`, `DELETION_MARKERS`, the `INGESTION_QUEUE` producer
binding, and the dedicated `CONNECTION_SETUP_PROVISIONING_QUEUE` producer and
consumer binding. These are not string environment values and cannot be
supplied by a public request. The production composition root fails closed
when any required binding is absent or has the wrong runtime capability.
`/health` remains a non-sensitive liveness endpoint; every other API route
passes the database readiness gate, and `/ready` returns unavailable unless
`HYPERDRIVE` can report exactly the compiled schema version.

`PROVIDER_CONTROL` is a Cloudflare RPC service binding with the closed
`listSessions`, `createSession`, `connectSession`, `getQrCode`,
`reconcileSession`, and `deleteSession` method set. API startup rejects a
fetch-only or incomplete binding. Provider-control validates each RPC argument
as a closed object before loading its credential-backed lifecycle Layer.
Malformed calls therefore cannot trigger provider access. The account-level
Provider API Credential is neither an RPC argument nor a result. A successful
create, adopt, connect, or reconciliation result may carry the narrower
per-session authority to the API Worker, which must envelope-encrypt it before
persistence.

The API Worker is also the declared consumer for the ingestion Queue and its
dead-letter Queue. It receives no DLQ producer binding. Provider-control has no
KV, R2, Queue, Hyperdrive, database role, tenant-decryption service, route, or
custom-domain authority and has both `workers_dev` and preview URLs disabled,
so the service binding is its only declared ingress. Bundle inspection also
rejects tenant KMS, database, Stored Media, and Webhook ingress authority from
the provider-control artifact and rejects provider-control secret names from
the API and web artifacts.
The API also disables generated Cloudflare hostnames and is public only on its
declared custom domain.

## MCP OAuth discovery and client policy

The API Worker serves RFC 8414 authorization-server metadata at
`/.well-known/oauth-authorization-server` and RFC 9728 protected-resource
metadata at `/.well-known/oauth-protected-resource` and its MCP-specific
`/mcp` suffix. It advertises the API origin as issuer, the exact `/mcp`
resource, S256-only PKCE, and the four MCP scopes. Implicit flow, dynamic
client registration, and Client ID Metadata Documents are disabled.

Before consent, the API exactly matches `client_id`, `redirect_uri`,
`resource`, response type, and PKCE against `OAUTH_CLIENT_REGISTRY`; failures
return locally and never redirect. A valid request is parsed by Cloudflare's
OAuth provider, AES-256-GCM encrypted, stored in OAuth KV for at most ten
minutes under a SHA-256 lookup key, and handed to the web consent origin using
a random 256-bit opaque value. Client IDs and redirects do not appear in that
handoff URL or KV key. The provider stores protocol secrets only by hash and
encrypts grant props. Per ADR 0003, Neon—not KV—remains authoritative for MCP
Authorization, scopes, selected WhatsApp Connections, account state, and
revocation.

The web consent page opens only from the opaque handoff. It retrieves the
allowlisted client name, requested scopes, and current existing WhatsApp
Connections directly from the API. No scope, Connection, read-sharing
confirmation, or send-authority confirmation starts selected. Approval requires
at least one explicit Connection and one independently selected requested
scope. Any read scope requires the separate read-sharing confirmation;
`messages:send` requires the separate send-authority confirmation and never
adds a read scope. A presentation digest bound to the handoff and verified
Clerk User rejects a changed request before persistence.

Approval also requires Clerk's standard first-factor verification-age (`fva`)
claim to be less than five minutes old. The browser invokes Clerk's
first-factor reverification flow when needed, clears its cached session token,
and submits a newly minted short-lived token. The API independently verifies
the signed `fva` value together with the token's signed issuance time; missing,
malformed, or stale values fail closed.

Migration 0006 gives each existing WhatsApp Connection an ADR 0023 `con_`
public handle and creates RLS-protected MCP Authorization and explicit
authorization-to-Connection rows. Neon stores exactly the independently
selected scopes and Connections; a Connection created later has no join row
and therefore does not expand the grant. OAuth KV protocol records use an
unlinkable per-authorization subject instead of Clerk identity; encrypted grant
props contain that subject and the authorization lookup ID. The only
application metadata outside those encrypted props is the allowlisted client
class.

Migration 0007 adds the RLS-protected refresh-credential ledger and
authorization-family revocation state. Neon stores only SHA-256 credential
hashes. One current hash is allowed per MCP Authorization; a successful
refresh locks and consumes it before committing one descendant. A concurrent
or later presentation of a consumed hash atomically revokes the family. Each
descendant expires after 30 days without use and is capped by the
authorization's 90-day absolute expiry. The OAuth KV grant is retained only
up to that 90-day ceiling so it cannot expire before Neon's moving inactivity
window, but KV never decides application validity.

Every refresh rechecks the current Clerk identity mapping, active Personal
Account, active MCP Authorization, non-revoked family, absolute expiry, and at
least one still-selected existing WhatsApp Connection through the restricted
API role. Access tokens remain bound to the exact `/mcp` resource and expire
after ten minutes. No additional Cloudflare binding or OpenTofu authority is
required beyond the existing OAuth KV and API Hyperdrive; migration 0007 grants
only `SELECT`, `INSERT`, and `UPDATE` on the ledger plus execute access to its
narrow fixed-search-path bootstrap functions to `whatsapp_api_runtime`.

Migration 0009 adds an ADR 0023 `mca_` management handle and the consent-time
MCP Client display name. Historical rows without a stored display name safely
fall back to their public OAuth client ID. A narrow fixed-search-path bootstrap,
executable only by `whatsapp_api_runtime`, preserves the Neon authority check
for access tokens issued before OAuth props included the client ID; newly
issued tokens retain the stricter client binding. The signed-in product reads
`GET /v1/mcp-authorizations` and idempotently revokes one owned grant with
`DELETE /v1/mcp-authorizations/{authorization_id}`. Responses contain only the
management handle, MCP Client ID and name, selected Connection handles, scopes,
creation and absolute-expiry times, and explicit expiry and revocation states.
They never contain the internal authorization UUID, OAuth subject, access or
refresh token, credential hash, or KV artifact.

Revocation updates the MCP Authorization state and its refresh-family state in
one Neon row transaction. Existing access-token checks, protected resource
reads, and refresh rotation all re-read those authoritative fields, so a
successful response makes cached OAuth KV or edge artifacts insufficient for
access immediately. RLS and the Clerk-to-Personal-Account bootstrap make an
unknown handle and another Personal Account's handle the same not-found result.
The API runtime already has the minimum required `SELECT` and `UPDATE`
privileges on MCP Authorizations; no new secret, Cloudflare binding, OpenTofu
resource, or production-selectable substitute is introduced.

Consent decision telemetry contains only
`oauth.authorization.decision.completed`, the allowlisted client class,
`approved` or `denied`, and the API service name. Never add the User, Personal
Account, MCP Authorization, Connection, scope set, redirect, token, handoff, or
presentation digest. Refresh telemetry contains only
`oauth.refresh.completed`, the allowlisted client class, and an allowlisted
`rotated`, `invalid`, `reuse`, or `unavailable` outcome. A `reuse` outcome is
an incident signal that the family has already been revoked; it must never
include either credential, its hash, or a tenant identifier.

Authorization-management telemetry contains only
`mcp_authorization.management.completed`, `list` or `revoke`, `success` or
`not_found`, and the API service name. Never add the User, Personal Account,
authorization handle or internal ID, MCP Client, Connection, scope set,
timestamp, token, credential hash, or request path.

Migration 0012 adds the RLS-protected, metadata-only Tool Call Log and the
stateless MCP `list_connections` boundary. Each invocation first locks its
Personal Account quota subject, rechecks the current MCP Authorization and
`connections:read` scope, and atomically persists the audit row with one request
reservation. Exact rolling minute and hour counts use only committed
`quota_reserved` rows. Authorization failures and pre-reservation audit failures
do not consume quota. When either window is exhausted, the API returns the
binding window's safe retry and reset values without reading Connection state.
Missing or invalid quota configuration prevents the production root from
serving.

Tool Call Logs expire after 90 days and contain only the tenant, authorization,
tool name, timestamps, normalized outcome and error code, bounded result count,
latency, and whether request quota was reserved. They never contain OAuth
credentials, Connection handles, display names, phone suffixes, provider
identifiers, scope sets, request or response content, or raw payloads. MCP tool
telemetry is limited to `mcp.tool_call.completed`, the fixed
`list_connections` tool name, an allowlisted outcome, the API service name, and
the bounded result count on success. Do not enrich it with tenant,
authorization, client, Connection, quota, credential, request, or response
fields.

Declare the reviewed per-environment allowlist through `oauth_clients`:

```hcl
oauth_clients = [{
  client_class  = "approved"
  client_id     = "reviewed-client-id"
  client_name   = "Reviewed MCP Client"
  redirect_uris = ["https://client.example.com/oauth/callback"]
}]
```

HTTPS redirects and explicitly configured HTTP loopback redirects are accepted
at configuration time; authorization still requires exact string equality.
Treat every client, redirect, or client-class change as an authorization-policy
change and review the environment-isolated plan. KV never acts as the client
registry: removing an entry from the deployed configuration makes that client
unavailable to new authorization and token requests immediately.

Provider-control startup also validates both Wasender secrets before serving
even its private health route or an RPC method. The Wrangler manifest declares
both names as required secrets, so deployment fails before serving when either
secret has not been configured. Its adapter always calls the fixed
`https://www.wasenderapi.com` origin with the account-level credential, forces
provider message logging and automatic incoming-message reads off during
creation, and emits only operation class, normalized outcome, attempt, duration,
bounded response size, RPC method, and normalized result code. No telemetry
field contains a Connection Setup marker, WhatsApp Number, provider locator,
per-session authority, Provider API Credential, or raw result. No runtime value
can select a fake provider or an alternate origin.

`WASENDER_REFERENCE_SECRET` must remain stable because persisted adapter
locators are keyed by it. To rotate it, stop provisioning, retain the old value,
reconcile every retained Connection Setup and WhatsApp Connection against the
provider under an audited maintenance workflow, persist locators derived with
the new value, verify that no old locator remains, deploy the new secret, and
resume provisioning. A direct replacement without reconciliation makes existing
provider sessions unresolvable and therefore fails closed.

The web production root requires `NEXT_PUBLIC_API_ORIGIN` to be a bare HTTPS
origin with no credentials, path, query, or fragment. The Vercel manifest has
no rewrite or proxy to the API. Browser data-plane requests therefore go
directly to the API Worker.

## Clerk human identity and Personal Account bootstrap

Each deployment environment uses its own Clerk instance or satellite domain.
Create the `whatsapp-api` custom JWT template with a 60-second lifetime and an
`aud` claim equal to that environment's exact API origin. Do not add tenant,
role, email, name, or other profile claims: the API consumes only Clerk's
standard `sub`, `iss`, `aud`, `azp`, `iat`, `nbf`, `exp`, `sts`, and `fva`
claims.
Configure the Clerk application to allow only the exact web origin represented
by `CLERK_AUTHORIZED_PARTY`.

The API verifies the token locally with `CLERK_JWT_KEY` and independently
requires the exact issuer, audience, authorized party, short expiry, and request
Origin. It then maps the verified Clerk User through narrow fixed-search-path
database functions, starts a transaction with `SET LOCAL
app.personal_account_id`, and relies on RLS for the remaining tenant access.
Neon serializes private-beta admission before the first successful request can
create one active Personal Account and one KMS-wrapped Personal Account data
key. Each admitted Personal Account reserves its full three-session entitlement
against `PROVIDER_APPROVED_SESSION_CAPACITY`; active and deleting accounts keep
that reservation. This conservative reservation ensures the product can state
the three-Connection limit without allowing later setup provisioning to exceed
the vendor ceiling. Neon also stores the 5 GB Stored Media limit and the
default 30-day Message Retention Policy and is the value source for the
bootstrap response.

When the next three-session entitlement would exceed approved capacity, Neon
creates or returns one private Clerk-keyed waitlist entry and creates no
Personal Account. Waitlist rows are inaccessible to ordinary API table queries
and to the webhook role; the narrow admission functions return only the
current User's state. If approved capacity increases, the oldest waiting User
is promoted transactionally on their next bootstrap request. Newer Users
cannot skip an existing waitlist entry. Admission never invokes
provider-control, so exhausted capacity cannot create a provider session.
Retries and concurrent tabs recover the same active account or waitlist state.
A deleting or deleted mapping, invalid identity, wrong tenant, wrong Origin, or
unavailable key returns the same public not-found boundary and never discloses
an identifier.

Bootstrap telemetry is limited to `personal_account.bootstrap.completed`, the
API service name, and an allowlisted `created`, `recovered`, or `waitlisted`
outcome. Never add
Clerk User IDs, Personal Account IDs, token claims, Origin values, network
addresses, key identifiers, ciphertext, or profile data to this event.

## Connection Setup creation

The signed-in browser creates a fresh 21-character NanoID idempotency key for
each WhatsApp Number intent and retains it for exact transport retries. It sends
the key and explicitly international number directly to `POST
/v1/connection-setups`; the response does not echo either value. The API
accepts only the configured browser Origin and a valid audience-bound Clerk
token, removes permitted visual formatting from the number, and validates the
result as E.164 before persistence.

`WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET` derives a domain-separated,
platform-wide 32-byte token from the normalized number. This key and token are
separate from the future connection-scoped Directory phone indexes. Neon
serializes each Personal Account's setup transaction, binds one browser key to
one token, enforces the three retained Connection/setup slots, and rejects a
token already reserved anywhere on the platform. The normalized number is
encrypted with a setup-scoped data key wrapped by the Personal Account key;
Neon stores no plaintext number.

The committed row begins in `provisioning_pending` and expires exactly 15
minutes after creation. It is the durable provisioning intent consumed by the
reconciled saga and owns a database-generated random webhook ingress identity;
this creation route never invokes provider-control. An exact
retry returns the original Connection Setup, while a changed number with the
bound browser key returns `idempotency_conflict`. Telemetry contains only
`connection_setup.start.completed`, service name, and the allowlisted outcome.
It never contains the number, token, idempotency key, Connection Setup
identifier, Personal Account identifier, ciphertext, or key metadata.

## Connection Setup provisioning

After the setup transaction commits, the API publishes only the opaque setup
identifier and a fixed message version to
`CONNECTION_SETUP_PROVISIONING_QUEUE`. A failed publication makes the HTTP
request unavailable but does not roll back durable intent; an exact browser
retry republishes the same setup, and the minute recovery scan republishes up
to 100 unleased, unexpired intents. Duplicate Queue deliveries are expected.

One restricted worker claims a two-minute Neon lease, asks provider-control to
reconcile the setup identifier as the deterministic provider marker, and only
permits create after confirmed absence. It renews the lease immediately before
that write. One match is adopted without create. Two or more matches are
stored as encrypted duplicate records and move the setup to
`provisioning_quarantined`; no matching session is selected as usable.
Successful create or adoption encrypts both the opaque provider locator and
per-session authority under the setup key in one Neon transition to
`provisioned`. Plaintext WhatsApp Number, provider locator, and session
authority exist only in worker memory for the bounded attempt.

For a confirmed-absent setup, the create request also supplies the exact API
origin plus the setup's persisted ingress identity to provider-control as a
protected webhook endpoint. The Wasender adapter enables only the reviewed
message, receipt, Directory, and connection-state events, keeps provider
message logging and incoming-message reads disabled, and requires the create
response to contain a unique webhook secret before the session can become
`provisioned`. Reconciliation after an ambiguous create adopts the same
deterministic provider marker; it never invents a second endpoint or secret.

Lifecycle write failure, timeout, or a crash never authorizes a repeated
create. The lease is released with only an allowlisted failure code when
possible, and every later attempt begins with reconciliation. A definitive
`do_not_retry` lifecycle rejection enters visible `provisioning_failed` state
and is not selected by recovery; it cannot become a repeated create loop.
Queue delivery
uses batches of one, a three-minute visibility timeout, ten 30-second delivery
retries, and seven-day retention. The durable setup and minute recovery scan
remain authoritative if Cloudflare exhausts a delivery. Telemetry contains
only `connection_setup.provision.completed`, service, allowlisted outcome and
optional normalized failure code, plus recovery candidate counts; it never
contains setup/account identifiers, number material, provider values, or
ciphertext.

## Connection Setup cancellation, expiry, and cleanup

The owning User cancels an incomplete setup with `DELETE
/v1/connection-setups/{setup_id}`. The transition to `cancelled` is
idempotent and immediately prevents provisioning from advancing. The existing
minute cron transitions every incomplete setup whose fixed 15-minute deadline
has passed to `expired`; expiry does not depend on a browser request.

Both terminal transitions persist `cleanup_state: pending` and publish a
`connection_setup.cleanup` message to the existing Connection Setup Queue.
The durable minute recovery scan republishes eligible cleanup work if request
publication or Queue delivery fails. Cleanup waits for any provisioning lease
that was active at the terminal transition to expire, then obtains its own
two-minute lease. This closes the race in which an already-authorized provider
create could otherwise occur after cleanup observed absence.

Every cleanup attempt asks provider-control to reconcile the deterministic
setup marker. Confirmed absence atomically sets `cleanup_state: complete`,
releases the WhatsApp Number reservation, and destroys the setup key envelope
and encrypted provisional provider-session rows. Presence deletes at most one
reconciled provider session; the next attempt must reconcile again before
another delete or reservation release. Duplicate sessions are therefore
removed one reconcile-first attempt at a time. Read, delete, timeout, and
lease failures retain the reservation, record only an allowlisted normalized
failure code, and remain eligible for recovery. A cancelled or expired state
is never changed by cleanup.

No new production secret, binding, public route to provider-control, or test
provider selection is introduced. Cleanup reuses the API's restricted Neon
role, existing same-environment provider-control service binding, and existing
durable Queue. Safe telemetry is limited to cancellation outcome, expired and
candidate counts, cleanup outcome, and optional normalized failure code.

## WhatsApp Connection activation and QR delivery

The owning signed-in browser reads
`GET /v1/connection-setups/{connection_setup_id}/qr` directly from the API
Worker. The API resolves the verified Clerk User through the narrow activation
bootstrap function before it invokes provider-control. It first reconciles the
deterministic setup marker, starts QR linking only after that reconciliation
shows a single non-connected provider session, and then asks provider-control
for the current generated SVG. An available SVG is streamed directly as
`image/svg+xml` with `Cache-Control: no-store`, a restrictive content security
policy, and `X-Content-Type-Options: nosniff`. The bytes exist only in the
bounded provider-control RPC result, API response, and browser object URL; no
database, R2, Queue, analytics, trace, snapshot, or telemetry field receives
them.

Every later observation reconciles again. Only a single provider session in
trusted `connected` state can activate the Setup. One Neon transaction locks
the Setup and creates or returns exactly one WhatsApp Connection, changes the
Setup to `activated`, and persists:

- a fresh `con_` public handle and internal identifier;
- a new KMS-rooted per-connection key envelope;
- the Setup's random non-enumerable webhook ingress identity;
- a fresh 32-byte webhook normalization identity key encrypted under the
  connection;
- the provider-neutral locator and per-session authority re-encrypted under
  the connection; and
- only the last four digits of the normalized WhatsApp Number as queryable
  display metadata.

The stable product state vocabulary is `connected`, `connecting`,
`disconnected`, `reconnect_required`, `degraded`, and `deleting`. Only
`connected` permits a later new Send Operation. The product reads
`GET /v1/whatsapp-connections` without pagination and receives only the opaque
handle, nullable display name, number suffix, normalized state, and state-change
time. Provider identifiers, credentials, webhook material, setup identifiers,
full numbers, key metadata, and ciphertext never enter that response.

This behavior adds no environment value or infrastructure authority.
Provider-control already owns the closed `connectSession`, `getQrCode`, and
`reconcileSession` lifecycle methods, and the API already has the sole
same-environment service binding. The Vercel app still calls the API directly
and receives no Provider API Credential, database binding, KMS authority, or
provider-control binding. Production cannot select the protocol-observable
provider used by the acceptance tests.

Safe QR telemetry is limited to `connection_setup.qr.completed`, service, and
one normalized outcome. Safe listing telemetry adds only the connection count
to `whatsapp_connection.list.completed`. Neither event contains a User,
Personal Account, Connection Setup, WhatsApp Connection, number, QR byte,
provider value, credential, ingress identity, secret, ciphertext, or key
reference.

## WhatsApp Connection disconnect and reconnect

The signed-in product sends `POST
/v1/whatsapp-connections/{connection_id}/disconnect` or `/reconnect` directly
to the API. These lifecycle commands are separate from Connection Deletion:
disconnect retains the WhatsApp Connection row, encrypted keys, Message
Retention Policy data, MCP selection, provider session, and platform-wide
WhatsApp Number reservation. Reconnect operates on that same `con_` identity.

Migration 0012 adds a narrow durable lifecycle claim to each WhatsApp
Connection. The restricted API function serializes the command, records the
desired connected or disconnected availability, and gives one caller a
two-minute opaque lease. A disconnect claim changes local state to `degraded`
before provider access, and a reconnect claim changes it to `connecting`, so
new side effects fail closed throughout reconciliation. A later claim can
replace an expired lease; its opaque claim UUID prevents a slow earlier result
from regressing the newer state.

The claim holder reconciles the deterministic retained setup marker before any
lifecycle write. An already-satisfied provider state completes without a
write. Otherwise provider-control performs exactly one connect or disconnect
attempt. An ambiguous result is never repeated: the API reconciles provider
state again and persists the normalized observation. Confirmed absence during
disconnect converges to `disconnected`; absence during reconnect converges to
`reconnect_required`; duplicate sessions or unresolved evidence converge to
`degraded`. A reconnect that needs user linking streams the current SVG QR
with the same no-store, no-persistence controls as initial activation and
continues reconciliation after scanning.

This behavior adds no environment value, public provider-control route, Queue,
storage binding, or infrastructure permission. It reuses the restricted Neon
API role and the existing same-environment API-to-provider-control service
binding. Safe telemetry is limited to
`whatsapp_connection.lifecycle.completed`, `disconnect` or `reconnect`, and
the normalized outcome `complete`, `in_progress`, `qr_available`, or
`recovery_required`; identifiers and provider values are prohibited.

## Wasender media authority

The Wasender media adapter has no hostname, endpoint, redirect, timeout, or
byte-limit environment override. Its production Layer fixes the decrypt
endpoint and approved download hostname to `www.wasenderapi.com`, resolves that
host through bounded DNS-over-HTTPS at `cloudflare-dns.com`, and fails closed
when the per-session authority is empty, non-printable, or otherwise invalid.
The session authority is provider data encrypted under the owning WhatsApp
Connection; it is decrypted only to construct that connection's adapter Layer
and is not a deploy-time environment variable. This fixed configuration keeps
an environment change from broadening the media SSRF boundary.

## Encrypted Stored Media container

The API production root constructs the versioned Stored Media container from
the `STORED_MEDIA` R2 binding and the same real AWS KMS-rooted envelope
encryption authority described above. Startup requires the R2 binding to
support `get`, `put`, `delete`, and `createMultipartUpload`; the last capability
allows an unknown-length encrypted stream to be written without pre-buffering
the plaintext to calculate a total object length.

The production plaintext encryption chunk ceiling is fixed at 1 MiB and R2
multipart transport parts are bounded at 5 MiB. Neither value has an
environment override. R2 receives no filename, MIME type, identity, plaintext
hash, or other Stored Media metadata. The complete format and authenticated
context are documented in [the encrypted Stored Media container
specification](stored-media-container.md).

## Wasender text-send authority

Text sending does not add an account-level Provider API Credential, endpoint
override, public route, service binding, or infrastructure secret. The
production adapter always calls
`https://www.wasenderapi.com/api/send-message` over the Worker's existing
outbound HTTPS capability, rejects redirects, and cannot select a test
transport at runtime. This zero-binding infrastructure delta keeps ordinary
connection operations outside provider-control and preserves ADR 0004's
least-privilege split.

The adapter is composed per WhatsApp Connection with two values already
protected by the connection's encryption boundary: its session-specific
authority and a 32-byte connection-scoped identity-protection key. It fails
closed when the authority contains control characters or is empty, when the
key is not exactly 32 bytes, or when the domain resolver cannot supply the
encrypted provider identity for the selected Directory recipient. These are
runtime connection records, not deployment environment variables, so they do
not belong in `.dev.vars`, Wrangler bindings, OpenTofu state, or operator
configuration.

Text-send telemetry is mandatory at composition and is limited to operation
class, normalized outcome, attempt count, duration, and bounded response-byte
count. It must not include text, phone numbers, recipient or message tokens,
session authority, raw response data, URLs, or provider status values.

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
| `clerk_issuer` | Exact HTTPS issuer for the same-environment Clerk instance. |
| `clerk_jwt_template` | Safe custom JWT template name; defaults to `whatsapp-api`. |
| `clerk_publishable_key` | Public browser key for the same-environment Clerk instance. |
| `oauth_clients` | Reviewed environment-specific MCP Client classes, IDs, names, and exact redirects. |
| `provider_approved_session_capacity` | Required reviewed integer ceiling; each admitted Personal Account reserves three sessions. |
| `mcp_requests_per_minute` | Required approved positive integer for authoritative per-Personal-Account requests in an exact rolling minute. |
| `mcp_requests_per_hour` | Required approved integer for authoritative per-Personal-Account requests in an exact rolling hour; at least the minute value. |

Provider and backend credentials are ambient only:

| Value | Sensitivity | Scope |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | The current environment's account and only the Worker, R2 bucket configuration, KV, Queue, schedule, custom-domain, and Hyperdrive permissions required by the declared plan. |
| `VERCEL_API_TOKEN` | Secret | The current environment's Vercel team. |
| AWS workload identity or short-lived credentials | Secret | The current environment's exact state object/lock and state KMS key. |

Never pass provider credentials as OpenTofu variables or write them into a
backend file. Cloudflare Worker bindings and Vercel environment values declared
by the compute topology are non-secret. Secret bindings must be populated
through the platform secret stores, not through OpenTofu resource arguments
that would serialize them into state.

Each environment declares four separate R2 buckets. Encrypted Webhook Events
expire after seven days and incomplete multipart uploads abort after one day.
Stored Media has no blanket object-expiry rule because Message Retention Policy
can be shorter or explicitly retain content until deletion; application
retention jobs own object deletion, while incomplete multipart uploads still
abort after one day. Encrypted Deletion Capsules have no age-based deletion
rule: only confirmed provider absence permits the deletion coordinator to
destroy one, and an overdue capsule must alert rather than silently lose the
cleanup identifier. The capsule bucket is protected from OpenTofu destroy.
Deletion markers cover every object path with an indefinite bucket lock and the
marker bucket is also protected from OpenTofu destroy. All four buckets
explicitly disable the public `r2.dev` managed domain and declare no custom
domain or CORS exposure.

The provisioning and ingestion Queues retain unconsumed messages for seven
days. Provisioning uses the bounded reconcile-first retry policy above.
Ingestion allows exactly seven retries and uses a three-hour default delay,
giving the roughly 21-hour bound required by ADR 0005; ingestion code may
select a jittered per-message delay inside that cap. Exhausted ingestion items
move to the actively consumed DLQ, whose unconsumed retention is four days.
API cron triggers run durable provisioning recovery and other maintenance each
minute, connection and webhook health reconciliation every five minutes, and
retention/deletion cleanup hourly. Resource names use the
deployment-environment suffix outside production so development, preview, and
production never share state by name.

The five-minute reconciliation claims only due, non-deleting WhatsApp
Connections through a fixed-`search_path` database function executable by the
restricted API role. Each claim has a four-minute lease so an interrupted cron
can recover without allowing an older completion to overwrite newer evidence.
The API calls provider-control's bounded safe `reconcileSession` read with the
Connection Setup marker and exact persisted webhook ingress URL. No message,
conversation, or Directory activity timestamp participates in the decision.

A confirmed connected session with the exact disabled-message-logging,
disabled-auto-read, enabled-webhook URL and event set advances the last
confirmed healthy point and closes active reconciliation gaps. Confirmed
absence, disconnection, reconnect requirement, unresolved connecting state,
degraded state, or duplicate sessions opens `connection_unavailable`; confirmed
webhook drift opens `webhook_configuration`. Other safe-read failures make the
Connection `degraded` but preserve existing gaps and do not create one. Gap
starts use the prior confirmed healthy point, closed rows remain associated
with the Connection's Message History Window, and no healthy result deletes a
row or certifies complete provider delivery.

Measured ingress/Queue incidents, bounded processing loss, and restore loss use
the restricted `record_ingestion_gap_evidence` function with
`ingress_failure`, `processing_failure`, or `restore_loss`. Only a concrete
incident measurement or restore report may invoke it; inactivity is not an
input. Operators invoke the same production repository through
`bun run db:record-gap -- <internal-connection-uuid> <cause> <open|close>
<utc-timestamp>` with a restricted API-runtime `DATABASE_URL`; the command
requires the exact `whatsapp_api_runtime` role on a TLS Neon URL, rejects
authority query overrides, and never prints the Connection identifier.
`connection_health.reconciliation.completed` telemetry contains only the
normalized state, gap evidence class, applied-or-superseded outcome, and service
name. It must never contain a User, Personal Account, Connection, Connection
Setup, webhook URL, provider identifier, authority, or payload.

OpenTofu variables `cloudflare_account_id` and `neon_org_id` for
`infra/production` are supplied through an uncommitted variable file or
`TF_VAR_` environment values. The checked example contains deliberately invalid
placeholders. Production database state contains generated passwords and must
use the encrypted, access-controlled S3-compatible backend configured during
`tofu init`; never store a local production state file.

The API production root also fails closed before serving requests when its KMS
region, either key ARN, the dedicated marker HMAC secret, or any short-lived
role credential is absent or invalid. The two configured KMS key ARNs must be
different. Both ARNs are safe to place in deployment configuration, while the
marker HMAC and all three credential values belong in the platform secret
store. The SDK receives redacted Effect configuration values and no credential,
plaintext key, plaintext content, provider cleanup identifier, or ciphertext is
included in application telemetry.

Example files contain placeholders only. Add secrets with the platform secret
command; never commit a populated environment file or `.dev.vars`.

## Per-connection webhook identity material

Webhook normalization uses a cryptographically random key of at least 32 bytes
for each WhatsApp Connection. This is connection data, not deployment
configuration: generate it while provisioning the connection, envelope-encrypt
it under the connection boundary, and import it with
`importWebhookIdentityKey` before constructing the production Wasender
normalization Layer. Do not introduce a shared `WASENDER_WEBHOOK_IDENTITY_KEY`
environment value, place plaintext key material in Neon or OpenTofu state, or
reuse the key across WhatsApp Connections. Key import fails closed when the
decoded value is shorter than 256 bits.

## Authenticated Webhook Event ingress

Wasender delivers to
`POST /webhooks/wasender/{webhook_ingress_id}` on the exact API origin. The
ingress ID is the random UUID retained with one WhatsApp Connection; it is
neither a public Connection handle nor authority by itself. The API accepts
only `application/json`, reads at most 1 MiB even when `Content-Length` is
absent or false, and resolves the ingress through `WEBHOOK_HYPERDRIVE` under
the restricted `whatsapp_webhook_runtime` role. That role receives only the
fixed-search-path bootstrap needed to obtain encrypted material for an active
Personal Account and non-deleting WhatsApp Connection. It cannot query the
connection key or provider-authority tables directly.

The Wasender adapter compares `X-Webhook-Signature` with the unique secret in
the connection's envelope-encrypted provider authority. If a documented
`sessionId`, `session_id`, `data.sessionId`, or `data.session_id` is present,
every supplied value must also match the encrypted per-session credential.
Missing authority, unavailable keys, an invalid secret, or a mismatched
session fails closed. There is no deployment-wide webhook authentication
secret and neither authentication value may enter a log, trace, metric, Queue
message, R2 metadata, or database plaintext.

After authentication, the exact original request bytes are AES-256-GCM
encrypted with context bound to the Personal Account, WhatsApp Connection,
random Webhook Event object ID, and `original-request` purpose. The private
`WEBHOOK_INGRESS` bucket receives only the versioned ciphertext envelope and
safe receipt metadata: version, internal Personal Account and WhatsApp
Connection context, SHA-256 ciphertext hash, payload byte count, and receipt
time. `INGESTION_QUEUE` receives exactly the opaque object ID and the same
connection context and receipt metadata. A `200` response is emitted only
after the R2 write and Queue publication both finish. R2 failure publishes
nothing; Queue failure returns `503` and intentionally leaves the encrypted
object with enough safe metadata for the orphan recovery workflow to
reconstruct the same Queue reference. Unknown or unauthenticated ingress
returns the same `404` boundary, malformed authenticated JSON returns `400`,
and an oversized delivery returns `413`.

Safe telemetry is limited to `webhook_ingress.completed`, service name, and
one of `accepted`, `authentication_failed`, `invalid_payload`, `not_found`,
`too_large`, or `unavailable`. Never add an ingress ID, object ID, Personal
Account, WhatsApp Connection, network address, header, session identity,
payload, ciphertext, hash, key metadata, or object path.

## Webhook Event normalization and connection-state projection

The API Worker consumes the environment-specific `whatsapp-mcp-ingestion`
Queue with the existing `WEBHOOK_INGRESS` R2 binding and
`WEBHOOK_HYPERDRIVE`. It validates the complete opaque Queue envelope against
the R2 object's safe metadata and ciphertext hash before loading any key
material. The restricted `whatsapp_webhook_runtime` bootstrap returns only the
matching Personal Account key envelope, WhatsApp Connection key envelope, and
encrypted per-connection webhook identity key. Missing bindings, objects,
metadata, compatible keys, or database access fail closed and leave the Queue
message unacknowledged for the configured bounded retry policy.

One authenticated delivery becomes one `webhook_events` row pointing to its
encrypted R2 source. The decrypted delivery is normalized into logical items;
each connection-state item claims its opaque connection-scoped identity in the
same Neon transaction that locks and updates the WhatsApp Connection. Provider
occurrence/version evidence is compared before verified receive order. An
older item, an item without evidence after stronger evidence, and an exact
duplicate cannot regress the current projection. The signed-in WhatsApp
Connection inventory reads that same authoritative row.

Malformed items, adapter-unsupported items, and normalized kinds whose
projector is not yet deployed are recorded as safe quarantine references with
no provider payload or identifier. Valid siblings continue independently.
Only after every item is applied, deduplicated, superseded, or quarantined does
the consumer mark the Webhook Event complete and explicitly acknowledge the
Queue message. Safe telemetry is limited to
`webhook_event.processing.completed`, normalized outcome, and aggregate item
counts; it must never include tenant, connection, event, item, provider,
payload, ciphertext, hash, or key values. The existing seven-day R2 lifecycle
remains the encrypted-source retention authority, so no new deployment secret
or public binding is introduced.

## Webhook recovery and bounded retry

The minute maintenance trigger scans at most 100 encrypted objects under the
private Webhook Event prefix. It ignores objects newer than one minute,
reconstructs the closed Queue envelope only from the object key and the six
safe custom-metadata fields, and asks `WEBHOOK_HYPERDRIVE` under
`whatsapp_webhook_runtime` which exact events already exist. Only unclaimed
objects are republished. The next opaque R2 listing cursor is checkpointed
under a maintenance-only key in the existing API KV binding after publication,
so a bounded page cannot permanently starve later object keys; a missing,
stale, or eventually consistent checkpoint safely restarts from the first
page. A race with provider redelivery or Queue consumption is safe because
both deliveries retain the original Webhook Item identities and the projector
claims those identities transactionally.

Transient R2, Neon, KMS, and Worker failures leave the ingestion message
unacknowledged. The consumer selects a per-attempt delay from 9,900 through
11,700 seconds; Cloudflare's validated `max_retries: 7` policy is the durable
limit, producing seven jittered retries over roughly 21 hours. The Queue's
10,800-second configured delay is the fail-closed default if application code
does not provide an override. Permanent malformed, unsupported, and
not-yet-projected items are quarantined and do not enter that retry schedule.

The API Worker actively consumes the environment's ingestion DLQ. For a valid
exhausted receipt it transactionally creates or verifies the `webhook_events`
source reference, marks it dead-lettered, and inserts one connection-scoped
`processing_failure` Ingestion Gap beginning at the verified receipt time. A
duplicate already completed by another delivery creates no false gap. Only
after the transaction and the safe `webhook_event.dead_letter.completed`
alert event succeed is the DLQ message acknowledged. The DLQ consumer uses
Cloudflare's maximum 100 retries at five-minute intervals, keeping failed gap
recording eligible beyond the four-hour recovery objective rather than reusing
the ingestion consumer's seven-retry exhaustion policy. The source ciphertext
remains in R2 for the existing seven-day diagnostic and immutable-replay window.
Recovery telemetry contains only bounded counts and normalized outcomes; it
never contains object, tenant, connection, provider, payload, ciphertext, or
key identifiers.
