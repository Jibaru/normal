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

Consent decision telemetry contains only
`oauth.authorization.decision.completed`, the allowlisted client class,
`approved` or `denied`, and the API service name. Never add the User, Personal
Account, MCP Authorization, Connection, scope set, redirect, token, handoff, or
presentation digest. Refresh telemetry contains only
`oauth.refresh.completed`, the allowlisted client class, and an allowlisted
`rotated`, `invalid`, `reuse`, or `unavailable` outcome. A `reuse` outcome is
an incident signal that the family has already been revoked; it must never
include either credential, its hash, or a tenant identifier.

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
reconciled saga; this creation route never invokes provider-control. An exact
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
