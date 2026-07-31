# Deployment and rollback

## Prerequisites

- Bun 1.3.14
- OpenTofu 1.12.5
- An authenticated Vercel CLI
- A Cloudflare account and zone with Workers enabled for each authority scope
- A Neon organization with a plan that supports a 30-day history window
- An AWS account with permission to manage OpenTofu state, CloudFormation, KMS,
  and named IAM roles in `us-east-1`
- A Vercel team for each authority scope
- A separate Clerk instance or satellite domain for each authority scope, with
  its publishable key and custom-JWT PEM public key available to the deployer
- Approved API and web custom domains
- An encrypted, versioned S3 remote-state bucket and KMS key in `us-east-1`
  for each environment
- Short-lived `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `VERCEL_API_TOKEN`, and
  AWS credentials for exactly the environment being changed
- A Wasender account with approved session capacity and an account-level
  Personal Access Token for each environment

No Clerk tenant or Wasender account is required to build and verify the
source-controlled platform. A real Directory smoke check additionally requires
one vendor-approved Wasender account and one connected non-production WhatsApp
Connection whose session API key is stored through the normal envelope-
encrypted connection-authority path. Exercising the real text-send adapter also
requires a designated test recipient for that connection. Never substitute the
account-level PAT for per-session authority, commit either credential, or add a
production-selectable fake. Provider-control requires its environment's
Wasender Personal Access Token and stable reference secret, while the API
requires its environment-specific AWS KMS stack and short-lived
`ContentRuntimeRole` credentials before either production composition root
becomes healthy.

Production authority must not be available to development or preview jobs.
Use a separate production Cloudflare account and Vercel team, and a separate
production state role and KMS key. Development and preview may use distinct
non-production accounts/teams or separate credentials within a non-production
authority boundary, but their identities must be unable to assume the
production roles or read production CI secrets.

## Bootstrap remote state

Remote state is an operator-owned prerequisite because a stack cannot safely
create the backend that stores its own state. For each environment:

1. Create an S3 bucket in `us-east-1` with all public access blocked, versioning
   enabled, TLS-only access, and default SSE-KMS using that environment's
   dedicated state key. Enable automatic KMS key rotation.
2. Record S3 object-level data events in CloudTrail and alert on denied access,
   public-policy changes, versioning changes, key-policy changes, and deletion.
3. Create one workload role for the environment. Limit `s3:ListBucket` to its
   key prefix; limit `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` to
   its exact state and `.tflock` objects; limit `kms:Encrypt`, `kms:Decrypt`,
   `kms:GenerateDataKey`, and `kms:DescribeKey` to its state key.
4. Explicitly deny development and preview principals access to the production
   state prefix and KMS key. Restrict production role assumption to the
   protected production deployment identity and audited break-glass operators.
5. Copy the matching file under `infra/compute/backends/` outside the
   repository, replace its bucket and KMS key placeholders, and keep the
   resulting backend file out of source control.

The checked-in backend enables S3 conditional-write locking and server-side
encryption. Bucket policy must require the declared KMS key rather than
accepting S3-managed encryption. Review state-role access quarterly and after
every incident or operator departure. Treat state, saved plans, crash logs, and
provider debug logs as sensitive operational artifacts. The compute state has
no application secrets, but the production database state contains generated
database passwords and must receive the same protections.

## Verify

```sh
bun install --frozen-lockfile
bun x playwright install --with-deps chromium
bun run format:check
bun run lint
bun run typecheck
bun run validate:infra
bun run test
bun run build
bun run manifests:validate
bun run infra:validate
```

`bun run build` performs Wrangler dry-run production bundles for both Workers,
builds the Next.js application, and rejects any production server or browser
output containing a test Layer, controlled credential, or fault injector.
`bun run test` includes the production-built Playwright browser-to-API journey,
the Cloudflare fetch, OAuth/MCP, protected-resource, binding, Queue, and
scheduled-handler harnesses, and the production-migration restricted-role
checks described in `docs/testing.md`.
Manifest validation dry-runs development, preview, and production.
Infrastructure validation checks formatting and provider schemas, then runs
mocked OpenTofu plans for all environments. Mock providers exist only in
`topology.tftest.hcl`; no production input can select them.

## Plan and apply

Set the environment for this operator session. The examples below use
`production`; substitute `development` or `preview` consistently.

```sh
export DEPLOYMENT_ENVIRONMENT=production
export TFVARS_PATH=/secure/operator/production.tfvars
export BACKEND_CONFIG_PATH=/secure/operator/production.s3.tfbackend
export CLOUDFLARE_API_TOKEN=...
export VERCEL_API_TOKEN=...
```

Authenticate to AWS with the matching short-lived state role, then initialize
and build the deployable artifacts:

```sh
tofu -chdir=infra/compute init \
  -reconfigure \
  -backend-config="$BACKEND_CONFIG_PATH"
bun run build
```

For a new environment only, create both Worker shells before the full plan so
Cloudflare has targets for their version-scoped secrets. Review and apply this
bootstrap target; it contains no Worker version or secret value:

```sh
tofu -chdir=infra/compute plan \
  -target=cloudflare_worker.provider_control \
  -target=cloudflare_worker.api \
  -var-file="$TFVARS_PATH" \
  -out="$DEPLOYMENT_ENVIRONMENT-worker-shell-bootstrap.tfplan"
tofu -chdir=infra/compute show \
  "$DEPLOYMENT_ENVIRONMENT-worker-shell-bootstrap.tfplan"
tofu -chdir=infra/compute apply \
  "$DEPLOYMENT_ENVIRONMENT-worker-shell-bootstrap.tfplan"
```

Generate the 32-byte locator key inside the approved recovery inventory, where
it can remain stable for the environment. Load that value and the account-level
Personal Access Token without echoing either one, then create both required
bindings atomically. The pipe does not put either plaintext value in a file,
saved plan, or OpenTofu state:

```sh
read -rsp "WASENDER_REFERENCE_SECRET: " WASENDER_REFERENCE_SECRET
echo
read -rsp "WASENDER_API_CREDENTIAL: " WASENDER_API_CREDENTIAL
echo
export WASENDER_REFERENCE_SECRET WASENDER_API_CREDENTIAL
bun -e 'process.stdout.write(JSON.stringify({
  WASENDER_API_CREDENTIAL: process.env.WASENDER_API_CREDENTIAL,
  WASENDER_REFERENCE_SECRET: process.env.WASENDER_REFERENCE_SECRET,
}))' | wrangler secret bulk \
  --cwd apps/provider-control \
  --env "$DEPLOYMENT_ENVIRONMENT"
wrangler secret list \
  --cwd apps/provider-control \
  --env "$DEPLOYMENT_ENVIRONMENT"
unset WASENDER_REFERENCE_SECRET WASENDER_API_CREDENTIAL
```

The secret list must contain exactly the two names; it never returns their
values. Delete the bootstrap plan after the Worker shell and bindings exist.
For an existing environment where the list already contains both names, skip
the bootstrap target and bulk upload.

In the same environment's Clerk dashboard, create the `whatsapp-api` custom JWT
template with a 60-second lifetime and only an `aud` claim whose value is the
exact `https://<api_hostname>` origin. Record the exact issuer and publishable
key in the protected `.tfvars` file as `clerk_issuer` and
`clerk_publishable_key`; retain the default `clerk_jwt_template` unless the
reviewed browser configuration uses another safe name. Copy the template's PEM
reviewed browser configuration uses another safe name. Record the written
vendor-approved session ceiling as the required
`provider_approved_session_capacity` integer; there is no default, and one
admitted Personal Account reserves three sessions. Copy the template's PEM
public key without changing its line breaks. Load it and a separately generated
32-byte OAuth protocol-encryption key into the API Worker shell:

```sh
wrangler secret put CLERK_JWT_KEY \
  --cwd apps/api \
  --env "$DEPLOYMENT_ENVIRONMENT"
openssl rand -hex 32 | wrangler secret put OAUTH_PROTOCOL_ENCRYPTION_KEY \
  --cwd apps/api \
  --env "$DEPLOYMENT_ENVIRONMENT"
wrangler secret list \
  --cwd apps/api \
  --env "$DEPLOYMENT_ENVIRONMENT"
```

The API list must include `CLERK_JWT_KEY` and
`OAUTH_PROTOCOL_ENCRYPTION_KEY`; values are never printed. Keeping
the public verification key in the secret store prevents unreviewed copying
into source, browser bundles, plans, or state. Apply this external Clerk
dashboard gate independently in development, preview, and production. The
exact JWT audience must match `CLERK_API_AUDIENCE`, and Clerk's standard `azp`
must match `CLERK_AUTHORIZED_PARTY`; a mismatch intentionally makes bootstrap
unavailable.

Now create and inspect the complete saved plan:

```sh
tofu -chdir=infra/compute plan \
  -var-file="$TFVARS_PATH" \
  -out="$DEPLOYMENT_ENVIRONMENT.tfplan"
tofu -chdir=infra/compute show "$DEPLOYMENT_ENVIRONMENT.tfplan"
```

Confirm that the plan contains exactly one Vercel web project/domain, a public
API Worker/custom domain, one private provider-control Worker, disabled
`workers.dev` and preview URLs for both Workers, and an API-to-provider-control
service binding. The API version must inherit `CLERK_JWT_KEY` and the OAuth
protocol-encryption key, and receive exact Clerk audience, authorized-party,
OAuth issuer/resource, reviewed client-registry, and
`PROVIDER_APPROVED_SESSION_CAPACITY` text bindings;
provider-control must receive none of them. The Vercel project must
receive only the public Clerk key and JWT template name. It must also contain
four private R2 buckets with disabled
managed domains, the seven-day Webhook Event lifecycle, the isolated Deletion
Capsule bucket with destroy protection, the indefinite deletion-marker lock,
one OAuth KV namespace, an ingestion Queue and active DLQ, the two Queue
consumers, and the three API schedules. Provider-control must have no R2, KV, or
Queue binding. Apply the reviewed plan:

```sh
tofu -chdir=infra/compute apply "$DEPLOYMENT_ENVIRONMENT.tfplan"
```

Delete the local saved plan after a successful apply. If applying fails, retain
it only in encrypted, access-controlled incident storage until reconciliation
is complete.

If Vercel reports that the web domain needs DNS verification, retrieve the
exact current record instead of guessing a shared CNAME:

```sh
WEB_HOSTNAME="$(tofu -chdir=infra/compute output -raw web_hostname)"
VERCEL_PROJECT_ID="$(tofu -chdir=infra/compute output -raw vercel_project_id)"
vercel domains verify "$WEB_HOSTNAME" --project "$VERCEL_PROJECT_ID"
```

Add the reported record in the environment's Cloudflare zone, wait for DNS
approval, and repeat the verification command. This is an external DNS
ownership gate; it requires no source or state substitution.

## Provision Neon and Hyperdrive

Copy `infra/production/production.tfvars.example` outside the repository or to
an ignored filename, replace its placeholders, and initialize the encrypted
remote backend. Backend values are intentionally not committed:

```sh
tofu -chdir=infra/production init \
  -backend-config="bucket=replace-with-state-bucket" \
  -backend-config="key=whatsapp-mcp/production.tfstate" \
  -backend-config="region=us-east-1"
tofu -chdir=infra/production plan \
  -var-file=/secure/path/production.tfvars \
  -out=/secure/path/production.tfplan
tofu -chdir=infra/production apply /secure/path/production.tfplan
```

The plan creates one protected Neon project in `aws-us-east-1`, configures
2,592,000 seconds (30 days) of history, creates separate API and webhook
runtime roles, and creates non-caching TLS Hyperdrive configurations. Neon
control-plane roles initially inherit `neon_superuser`; migration 0001 revokes
that membership and enforces `NOSUPERUSER`, `NOBYPASSRLS`, and the remaining
restricted attributes before the schema can report ready.

Run migrations directly as the database owner, never through Hyperdrive:

```sh
export MIGRATION_DATABASE_URL="$(
  tofu -chdir=infra/production output -raw migration_database_url
)"
bun run db:migrate
bun run db:check
unset MIGRATION_DATABASE_URL
```

Migration execution takes a session-level advisory lock, applies each version
in its own transaction, records a SHA-256 checksum, and refuses a changed or
newer-than-expected schema. An interrupted migration rolls back its version;
rerun `bun run db:migrate` after correcting the cause. Never edit an applied
migration—add a new forward migration. Migration 0007 contains the
RLS-protected refresh-credential hash ledger and its least-privilege API-role
functions. Migration 0009 adds product-safe MCP Authorization management
metadata using the API role's existing RLS-protected `SELECT` and `UPDATE`
authority plus execute access to one narrow fixed-search-path compatibility
bootstrap; it adds no secret, Cloudflare binding, or infrastructure authority.
Apply all pending migrations immediately before the matching API Worker
version. The previous Worker and the new Worker intentionally fail readiness
on the other's exact schema version, so complete this step as one controlled
fail-closed deployment.

## Provision encryption authority

Use a dedicated, versioned, non-public S3 bucket for OpenTofu state. Restrict
bucket and object access to the infrastructure deployment authority, retain
default encryption, and do not use either application KMS key to encrypt this
bootstrap state. Native S3 lock files prevent concurrent state changes.

Initialize and deploy one stack per environment. Use five distinct bootstrap
principals for the KMS administrator, API content runtime, deletion coordinator,
provider-control, and ordinary operator variables. Both OpenTofu and
CloudFormation reject a repeated principal.

```sh
tofu -chdir=infra/aws init \
  -backend-config="bucket=replace-with-infrastructure-state-bucket" \
  -backend-config="key=whatsapp-mcp/production/kms.tfstate" \
  -backend-config="region=us-east-1"

tofu -chdir=infra/aws plan \
  -out=kms.tfplan \
  -var="deployment_environment=production" \
  -var="kms_administrator_assumer_arn=arn:aws:iam::111122223333:role/replace-kms-admin-bootstrap" \
  -var="content_runtime_assumer_arn=arn:aws:iam::111122223333:role/replace-api-workload-bootstrap" \
  -var="deletion_coordinator_assumer_arn=arn:aws:iam::111122223333:role/replace-deletion-bootstrap" \
  -var="provider_control_assumer_arn=arn:aws:iam::111122223333:role/replace-provider-bootstrap" \
  -var="ordinary_operator_assumer_arn=arn:aws:iam::111122223333:role/replace-human-operator-bootstrap"

tofu -chdir=infra/aws apply kms.tfplan
```

Record the `content_root_key_arn`, `content_runtime_role_arn`,
`deletion_coordinator_key_arn`, and `deletion_coordinator_role_arn` OpenTofu
outputs in the environment's deployment inventory. Configure
`KMS_CONTENT_ROOT_KEY_ARN` from `content_root_key_arn` and
`KMS_DELETION_COORDINATOR_KEY_ARN` from `deletion_coordinator_key_arn`; the API
root rejects equal values. The content key and Deletion Capsule key are retained
if a stack is deleted or replaced; never schedule their deletion as part of
ordinary rollback. The owning AWS account principal retains key-policy recovery
authority for lifecycle and policy operations only; that statement grants no
cryptographic operation.

The API credential broker must assume only `ContentRuntimeRole` and continuously
rotate its short-lived access key, secret, and session token in the Cloudflare
secret store before expiration. Configure the three values with `wrangler
secret put`; do not give Cloudflare the administrator, deletion coordinator,
provider-control, or ordinary operator credentials. The trusted bootstrap
principal also needs a narrowly scoped `sts:AssumeRole` identity policy for
that one role because the template deliberately declares only each role's trust
side.

Generate the deletion-marker HMAC once per environment, store it only as the
`DELETION_MARKER_HMAC_SECRET` Worker secret and in the encrypted recovery
inventory, and do not rotate it without a marker-rekey recovery design:

```sh
openssl rand -hex 32 | wrangler secret put DELETION_MARKER_HMAC_SECRET \
  --cwd apps/api --env production
```

This secret is unrelated to KMS, provider-reference, webhook, cursor, and
idempotency keys. Losing it prevents deterministic creation of a later marker
for the same opaque identifier; exposing it weakens marker-key privacy.

Generate the WhatsApp Number reservation HMAC independently and store it only
as the API Worker secret:

```sh
openssl rand -hex 32 | \
  wrangler secret put WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET \
  --cwd apps/api --env production
```

Do not reuse the deletion-marker, provider-reference, OAuth, webhook, cursor,
content, or future Directory-index key. Keep this value stable while any
Connection Setup or WhatsApp Connection reservation exists. Rotation requires
stopping provisioning and transactionally rebuilding all retained reservation
tokens before the old key is removed.

AWS KMS records cryptographic operations in CloudTrail. Encryption context is
non-secret audit data and is limited here to environment, purpose, opaque
Personal Account or deletion-marker identity, and key version. Alert on denied
decrypts, disabled keys, scheduled deletion, policy changes, and rotation being
disabled. Never copy key plaintext, application plaintext, data-key envelopes,
or ciphertext into application logs or incident tickets.

The API Stored Media binding must support R2 multipart uploads in addition to
read, write, and delete. The production root fails closed when this capability,
the R2 binding, or KMS authority is missing. Before promotion, run the API
Stored Media container suite and the deployment checks:

```sh
bun run --cwd apps/api test -- stored-media-container.test.ts
bun run manifests:validate
bun run infra:validate
```

The suite writes through the Workers R2 test binding and proves authenticated
round trips plus rejection of truncation, reordering, bit changes, trailing
bytes, wrong Personal Account, wrong WhatsApp Connection, wrong Stored Media
object, wrong key version, and unsupported container versions. It also verifies
that R2 HTTP and custom metadata remain empty.

Alert on repeated `stored-media.container.completed` events with
`authentication-failed` or `storage-failed`. Those events contain only the
operation, normalized outcome, format version, authenticated chunk count, and
processed plaintext byte count; do not enrich them with object keys, tenant or
connection identifiers, media metadata, key material, plaintext, ciphertext,
or nonces. Treat an authentication failure or missing primary R2 object as
unavailable Stored Media, never return a verified prefix, and transition the
authoritative Stored Media record to `failed` through its owning workflow.

## Deploy

OpenTofu uploads both Worker bundles and orders provider-control before the API
through the service-binding dependency. It also creates the isolated Vercel
project and its custom domain, but application deployment to Vercel remains an
explicit side effect. For production, replace the initial API version with the
database-enabled build after Hyperdrive exists. Obtain identifiers from state
without printing any secret:

```sh
export CLOUDFLARE_HYPERDRIVE_ID="$(
  tofu -chdir=infra/production output -raw api_hyperdrive_id
)"
export CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID="$(
  tofu -chdir=infra/production output -raw webhook_hyperdrive_id
)"
export CLOUDFLARE_OAUTH_KV_ID="$(
  tofu -chdir=infra/compute output -raw oauth_kv_namespace_id
)"
export CLERK_API_AUDIENCE="$(tofu -chdir=infra/compute output -raw api_origin)"
export CLERK_AUTHORIZED_PARTY="$(tofu -chdir=infra/compute output -raw web_origin)"
export CLERK_ISSUER="$(sed -n 's/^[[:space:]]*clerk_issuer[[:space:]]*=[[:space:]]*\"\\([^\"]*\\)\"[[:space:]]*$/\\1/p' "$TFVARS_PATH")"
export OAUTH_CLIENT_REGISTRY="$(
  tofu -chdir=infra/compute output -raw oauth_client_registry
)"
export OAUTH_ISSUER="$CLERK_API_AUDIENCE"
export OAUTH_RESOURCE="$OAUTH_ISSUER/mcp"
export PROVIDER_APPROVED_SESSION_CAPACITY="$(sed -n 's/^[[:space:]]*provider_approved_session_capacity[[:space:]]*=[[:space:]]*\\([0-9][0-9]*\\)[[:space:]]*$/\\1/p' "$TFVARS_PATH")"
bun scripts/render-api-wrangler.ts \
  apps/api/.wrangler/production.jsonc \
  "$DEPLOYMENT_ENVIRONMENT"
CI=true bun run --cwd apps/api wrangler deploy \
  --config .wrangler/production.jsonc \
  --env "$DEPLOYMENT_ENVIRONMENT"
unset CLOUDFLARE_HYPERDRIVE_ID CLOUDFLARE_OAUTH_KV_ID \
  CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID CLERK_API_AUDIENCE \
  CLERK_AUTHORIZED_PARTY CLERK_ISSUER OAUTH_CLIENT_REGISTRY \
  OAUTH_ISSUER OAUTH_RESOURCE PROVIDER_APPROVED_SESSION_CAPACITY
export VERCEL_ORG_ID="$(tofu -chdir=infra/compute output -raw vercel_team_id)"
export VERCEL_PROJECT_ID="$(tofu -chdir=infra/compute output -raw vercel_project_id)"
vercel deploy --prod --yes --cwd apps/web
```

The dedicated Vercel project always uses its Production deployment target; its
validated `DEPLOYMENT_ENVIRONMENT` value records whether the isolated project
represents development, preview, or production. `NEXT_PUBLIC_API_ORIGIN` is set
before the build and points to the same-environment Worker. There is no Vercel
rewrite or server-side API proxy. The rendered API config is mode `0600`,
ignored by Git, and fails generation unless both real 32-character Hyperdrive
identifiers and the current environment's real 32-character OAuth KV identifier
are present. The selected environment receives the same four R2 buckets, Queue
producer and consumers, DLQ, and schedules as the reviewed OpenTofu plan. The
Worker manifests set `AWS_KMS_REGION` explicitly. Set
`KMS_CONTENT_ROOT_KEY_ARN` and `KMS_DELETION_COORDINATOR_KEY_ARN` in the API
deployment configuration and populate the marker HMAC plus three AWS credential
secrets before deployment. `CLERK_JWT_KEY` and
`OAUTH_PROTOCOL_ENCRYPTION_KEY` must already exist on the selected API Worker
and are preserved as inherited secret bindings. Rendering fails unless the
Clerk audience, authorized party, Clerk issuer, OAuth issuer, exact MCP
resource, non-empty reviewed client registry, and provider-approved session
capacity are valid.

Provider-control authority is populated during the first-deployment bootstrap
above, directly in Cloudflare's secret store. The Wrangler manifest declares
both names under `secrets.required`, so a subsequent Wrangler upload or deploy
fails before publishing code if the selected environment does not already have
both secrets. OpenTofu represents both names as `inherit` bindings, so every
subsequent provider-control version preserves the already stored ciphertext
without putting either plaintext value in input, a saved plan, or state. Run
the bootstrap against `development`, `preview`, and `production` independently;
never rely on one environment's secrets for another.

The credential must be the account-level Personal Access Token, never a
WhatsApp Connection's per-session API key. Provider-control has no public route,
and its Cloudflare deployment identity should be scoped only to that Worker so
the credential cannot enter the web or API deployments. Rotate only the
account-level credential with `wrangler secret put WASENDER_API_CREDENTIAL`
against the exact target environment, deploy provider-control, and verify its
private service-binding health before deploying the API. Never rotate
`WASENDER_REFERENCE_SECRET` directly; use the reconciliation procedure in
`docs/configuration.md` so retained provider sessions remain addressable.

## Smoke check

The public checks contain no dependency details or credentials:

```sh
API_ORIGIN="$(tofu -chdir=infra/compute output -raw api_origin)"
WEB_ORIGIN="$(tofu -chdir=infra/compute output -raw web_origin)"
curl --fail --silent "$API_ORIGIN/health"
curl --fail --silent "$API_ORIGIN/ready"
curl --fail --silent \
  "$API_ORIGIN/.well-known/oauth-authorization-server"
curl --fail --silent \
  "$API_ORIGIN/.well-known/oauth-protected-resource/mcp"
curl --fail --silent "$WEB_ORIGIN/health"
```

Confirm the metadata advertises only `$API_ORIGIN` as issuer and authorization
server, `$API_ORIGIN/mcp` as resource, S256 PKCE, the four documented scopes,
and no registration endpoint. An authorization request from an unregistered
client and one from a registered client with a one-character redirect change
must both return `400` without a `Location` header. Do not complete real consent
or a token exchange during this metadata smoke check.

Sign in through the deployed web application with a designated smoke-test Clerk
User and bootstrap once. Confirm the browser sends `POST
/v1/personal-account/bootstrap` directly to `API_ORIGIN`, the UI reports
`Personal Account ready`, and a retry reports the same state without creating a
second account. Confirm the product states the three-Connection, 5 GB Stored
Media, and default 30-day Message Retention Policy values returned from Neon.
In a non-production environment, set capacity to exactly three, admit one
designated User, and verify a second designated User receives the same
private-beta waitlist state on retries without any provider-control lifecycle
telemetry. Restore the approved value before further onboarding. A wrong
Origin, expired token, or token from another environment
must produce the same not-found response. Do not copy a token into shell
history, query tenant tables with an owner role, or log identifiers to prove
this check. Safe telemetry may show only
`personal_account.bootstrap.completed` with `created` on the first request,
`recovered` on the retry, or `waitlisted` for the exhausted outcome.

Enter an explicitly international smoke-test WhatsApp Number in the signed-in
product and start one Connection Setup. Confirm the browser sends `POST
/v1/connection-setups` directly to the API and reports that the Connection
Setup started. Repeat the submission without changing the input and confirm it
returns the same setup as a replay. In an isolated non-production database,
verify that changing the number while retaining the original idempotency key,
reserving the same number from a second Personal Account, and starting beyond
three retained Connection/setup slots return their safe conflict states.
Provider-control must receive no lifecycle call during these creation checks;
the committed Queue message and reconciled provisioning worker are the only
provisioning path. Confirm the worker reports one `provisioned` outcome after
reconciling absence and creating, or after adopting the one matching
non-production provider session. Replaying the Queue message must reconcile and
ack without another create. Inspect only allowlisted outcome telemetry—never
print the number, idempotency key, reservation token, setup identifier,
ciphertext, provider locator, session authority, or key metadata.

From the same signed-in product flow, wait for the current QR image to appear
and scan it from the designated smoke-test WhatsApp account. Confirm the
browser reads the setup-scoped QR route directly from `API_ORIGIN`, that the
response is `image/svg+xml` with `Cache-Control: no-store`, and that no QR
payload or image bytes appear in Worker logs, analytics, traces, database
diagnostics, R2, Queue messages, or saved test artifacts. Do not copy, save, or
screen-capture the QR image as deployment evidence.

After scanning, confirm the next reconciled observation removes the QR image
and the product lists exactly one WhatsApp Connection with a `con_` handle,
nullable display name, four-digit number suffix, `connected` state, and
state-change time. Repeat the QR observation and connection list reads; they
must return the same Connection and must not create another connection key,
webhook ingress identity, webhook secret, or provider session. Inspect safe
counts through the restricted API role only. A second User requesting the same
setup-scoped QR route must receive the ordinary not-found boundary without a
provider-control call.

Safe telemetry may show only `connection_setup.qr.completed` with a normalized
outcome and `whatsapp_connection.list.completed` with a bounded count. A QR
byte, full number, setup or connection handle, provider locator, session
authority, webhook value, ciphertext, or key reference in telemetry is a
credential-handling incident. No infrastructure apply should add a new public
provider-control route or binding for this flow: the existing API-only closed
service binding is the complete lifecycle authority delta.

Trigger one reviewed non-production Wasender event for the activated
WhatsApp Connection and confirm the provider receives `200`. Inspect only
aggregate R2 object and Queue publication counts: one accepted delivery must
add one object under the private Webhook Event prefix and publish one ingestion
message after the object exists. The Queue body must have only version, opaque
object identity, internal connection context, ciphertext SHA-256, payload byte
count, and receipt time. Do not download the object, print R2 metadata, copy
the ingress URL or `X-Webhook-Signature`, or inspect the provider payload as
deployment evidence.

In an isolated test environment, verify that an unknown ingress, changed
signature, changed payload session identity, and body above 1 MiB receive
non-success and change neither the Webhook Event object count nor the Queue
publication count. Then deny R2 writes and confirm Queue publication does not
occur; deny Queue publication and confirm the request returns `503` while one
encrypted unclaimed object remains. Restore both bindings before continuing.
Do not delete that object manually: the orphan recovery workflow owns safe
republication. Repeated `webhook_ingress.completed` outcomes other than
`accepted` require checking restricted database readiness, KMS, R2, Queue, and
provider configuration in that order. Telemetry containing any ingress,
connection, object, network, header, session, payload, ciphertext, hash, or key
value is a credential-handling incident.

Confirm the accepted Queue message is explicitly acknowledged only after one
restricted `webhook_events` row is present and every logical item has a
terminal processing outcome. Deliver a reviewed non-production
`session.status` event with a later provider occurrence time and verify the
signed-in WhatsApp Connection inventory shows the normalized state and
state-change time. Redeliver the same item in a new authenticated delivery,
then deliver an older conflicting state; the inventory must remain unchanged.
In an isolated test environment, include one permanently malformed or
unsupported sibling and confirm it creates only a safe quarantine reference
while valid siblings still commit.

`webhook_event.processing.completed` may contain only `completed`, `retry`, or
`invalid_message` plus aggregate applied, duplicate, superseded, and
quarantined counts. A growing `retry` rate requires checking R2 object
availability and metadata integrity, KMS, `WEBHOOK_HYPERDRIVE`, schema version,
and restricted-role grants in that order. Do not inspect or edit the encrypted
source, manually synthesize a deduplication identity, update connection state,
or acknowledge the Queue message. Permanent item quarantine is handled and
acknowledged; transport or dependency failures remain eligible for the
configured seven Queue retries and active DLQ path.

### Connection health and Ingestion Gap checks

Wait for the next `*/5 * * * *` trigger and confirm one
`connection_health.reconciliation.completed` event per due non-production
WhatsApp Connection. A healthy fixture must report `connected`, `healthy`, and
`applied`. Change only the reviewed provider fixture to disable or redirect its
webhook and confirm the next check reports `degraded` with
`webhook_configuration`; restore the exact webhook configuration and confirm a
later check reports healthy. Separately disconnect the provider session and
confirm `disconnected` with `connection_unavailable`.

Using migration-owner inspection in the isolated environment, verify each
confirmed failure opened one active `app.ingestion_gaps` row at the previous
`health_last_confirmed_at`, and confirmed recovery set `ends_at` without
deleting the row. Deliver provider state evidence whose occurrence time
predates the completed health snapshot and confirm it is superseded. Do not
send or suppress messages as a test signal: message inactivity must leave the
gap count unchanged, and an empty active-gap set is not evidence of
provider-certified completeness.

For a measured ingress or Queue outage, record the affected internal
Connection IDs, measurement start, recovery time, and safe aggregate evidence
in the incident record. Supply the restricted API-runtime `DATABASE_URL` only
to the incident shell, then invoke the production repository path with the
internal Connection UUID, cause, `open` or `close`, and exact UTC evidence time:

```sh
bun run db:record-gap -- \
  00000000-0000-4000-8000-000000000000 \
  ingress_failure \
  open \
  2026-07-31T12:20:00.000Z
```

Use `processing_failure` after bounded ingestion loss and `restore_loss` after
a restore comparison proves loss; record each affected Connection before
enabling reads. Close only causes whose recovery was confirmed. The command
returns only the cause, action, and recorded-or-rejected outcome and never the
Connection ID. Never use it for suspected silence, and never insert, update,
or delete gap rows directly. A rejected or unavailable command must stop the
recovery gate for that Connection.

Alert when reconciliation has no successful run for ten minutes, when
`unknown` or `superseded` outcomes grow, when any active gap remains after the
underlying dependency is reported recovered, or when a reconnect-required or
degraded Connection persists across two checks. Investigate provider-control,
Wasender safe-read availability, exact webhook configuration, Hyperdrive, and
schema version in that order. Telemetry containing any tenant or provider
identifier is an incident.

From the retained non-production WhatsApp Connection, choose **Disconnect**.
Confirm the product reports `disconnected`, retained history remains described
as available under Message Retention Policy, and the same `con_` handle and
number suffix remain listed. Repeat the request and confirm it completes
without a second provider write. Through the restricted API role, verify that
the WhatsApp Connection, Connection Setup, key envelopes, and WhatsApp Number
reservation still exist; do not inspect content or ciphertext.

Choose **Reconnect** on that same Connection. If linking is required, scan the
ephemeral QR without saving it and confirm the product progresses through
`connecting` to `connected` on the same handle. Exercise the reviewed
ambiguous-disconnect fixture: it must make one write, reconcile, and converge
to `disconnected` when the provider confirms that state, or `degraded` when
the target remains unresolved. Two concurrent requests must expose one active
claim, and a stale claim completion must not change the newer state. During
`connecting`, `disconnected`, `reconnect_required`, or `degraded`, verify a new
side-effect availability decision is blocked. Telemetry may contain only
`whatsapp_connection.lifecycle.completed`, the normalized operation and
outcome, and the API service name. Any handle, setup marker, provider value,
number, QR data, or credential in that event is an incident.

Exercise the reviewed provider-control test fixture for an ambiguous create
timeout and confirm the next Queue delivery reconciles before any create
decision. Exercise its duplicate fixture and confirm Neon exposes only the
safe setup state `provisioning_quarantined` and duplicate count while no session
becomes usable. A production quarantine is an incident: pause new onboarding,
retain every reservation and encrypted provider reference, and do not manually
repeat create or release the number. Use audited restricted diagnostics for
state/counts only, preserve provider evidence, and follow the provider cleanup
procedure below. A growing recovery candidate
count, repeated normalized failure code, or setup approaching its 15-minute
expiry requires paging the on-call operator.

Cancel one incomplete non-production Connection Setup in the product and
confirm `DELETE /v1/connection-setups/{setup_id}` returns `cancelled` with
`cleanup_state: pending`; repeat it and confirm an idempotent replay. Start a
second setup and make no browser request after its deadline. Confirm the minute
cron changes it to `expired` at 15 minutes and enqueues cleanup. For both
paths, verify provider-control reconciles before delete, deletes no more than
one matching session per attempt, reconciles again, and releases the WhatsApp
Number only after confirmed absence. The same number must remain unavailable
while absence is unknown and become available after cleanup completes.

Page the on-call operator when cleanup recovery candidates grow, a normalized
cleanup failure repeats, or a reservation remains held after the expected
provider recovery window. Do not manually delete the reservation, clear a
lease, or change `cancelled`/`expired` back to a provisioning state. First
restore provider-control or Queue health, then let the reconcile-first worker
confirm absence. Inspect only terminal state, cleanup state, attempt count,
lease age, and allowlisted failure code through restricted diagnostics; never
log the setup identifier, number token, encrypted number, provider locator,
session authority, or raw provider response.

In the same non-production environment, start authorization from one reviewed
allowlisted MCP Client. Confirm the consent page names that client and starts
with every WhatsApp Connection, requested scope, read-sharing confirmation,
and send-authority confirmation unselected. Approve one existing Connection
with a reviewed subset of scopes after Clerk first-factor reverification, then
exchange the returned code with S256 PKCE. Inspect only protocol metadata: the
response must report `expires_in: 600`, the exact `$API_ORIGIN/mcp` resource,
the selected scope string, and one refresh credential. Never print either
credential.

Repeat with denial and confirm that the client receives `access_denied` with
its original state and no MCP Authorization row is created. Restart the flow
before each negative case; verify a five-minute-old factor age is rejected, an
altered presentation is rejected as a changed request, and an unregistered
client still fails before consent without a redirect. Query only safe counts
and scope/Connection cardinalities through an audited restricted-role
diagnostic. A later test WhatsApp Connection must not change the original
authorization's selected-Connection count. Safe consent telemetry may contain
only the allowlisted client class and `approved` or `denied`.

Using that disposable non-production authorization, let the client store the
returned refresh credential without printing it. Refresh once and confirm the
response contains a different refresh credential, the same reviewed scope and
resource, and `expires_in: 600`. In the automated acceptance check, submit two
concurrent refreshes with the same current credential: exactly one response
may contain a descendant and the other must be `invalid_grant`. Re-present the
consumed credential and confirm `invalid_grant`, then confirm the descendant
also cannot refresh because reuse revoked the family. Inspect only
`oauth.refresh.completed` outcome counts and the allowlisted client class.
Treat any `reuse` outcome outside this controlled check as a credential-replay
incident: revoke or confirm revocation of the affected MCP Authorization,
notify the User through the incident process, and investigate the MCP Client's
credential storage. Never query, export, or log a credential hash.

In the signed-in product, inspect the disposable authorization and confirm its
MCP Client name, selected WhatsApp Connections, scopes, creation time, absolute
expiry state, and revocation state. Confirm the browser calls
`GET /v1/mcp-authorizations` directly and that the response contains no
internal UUID, OAuth subject, token, refresh credential, credential hash, or KV
artifact. Revoke it once through the product, repeat the same action through an
isolated non-production API check, and confirm both return the original
revocation time. Immediately retry one existing access token and the latest
refresh credential; both must fail even if the OAuth KV records are retained.

Attempt the same management handle as a different disposable Personal Account
and compare it with a random well-formed `mca_` handle. Both must return the
same not-found status and body. Inspect only allowlisted
`mcp_authorization.management.completed` operation/outcome counts. If an
access-token call or refresh succeeds after a successful revoke response,
disable the affected API deployment, preserve metadata-only evidence, and
investigate the Neon authority check before restoring traffic. Never delete KV
as the primary containment action: authoritative Neon revocation must remain
sufficient on its own.

The readiness response proves a restricted Hyperdrive connection can read the
exact expected schema version. It emits only an allowlisted request outcome;
database URLs, SQL, tenant identifiers, and migration errors are never logged.
The repository's provider-control acceptance suite invokes real lifecycle
reconciliation through the Cloudflare RPC entrypoint, rejects malformed RPC
arguments before provider access, and proves that the same lifecycle operation
is unavailable over HTTP. Deployment validation proves that only the
same-environment API Worker receives the service binding. Until the
authenticated operator canary is added to the API, verify the deployed binding
and Worker version in the reviewed Cloudflare deployment output; do not add a
temporary API endpoint or enable `workers.dev` or preview URLs for
provider-control.

Provider-control RPC logs may contain only the RPC method and normalized
success or failure code. Treat a Connection Setup marker, WhatsApp Number,
opaque locator, per-session authority, account credential, request body, or
provider response in logs as a credential-handling incident.

### Wasender media retrieval

No additional Cloudflare binding or public ingress is required for media
retrieval. If an organization-level egress policy is applied outside this
repository, allow outbound HTTPS only as needed to `www.wasenderapi.com` for
decrypt metadata and guarded downloads and to `cloudflare-dns.com` for the
adapter's bounded A and AAAA checks. Do not add an alternate media hostname or
disable DNS validation to work around an outage.

After a real Wasender account and connected session exist, send one test image
to the test WhatsApp Connection and verify through the authenticated ingestion
path that metadata becomes available and the guarded stream's actual byte
count matches the object written by the caller. Repeat with a caller limit one
byte below the object size and verify the stream fails with
`response_too_large` and the partial object is discarded. Operator telemetry
may show only operation class, normalized outcome, attempt count, duration, and
bounded byte count; a URL, credential, provider response, filename, MIME type,
message identity, or media bytes in logs is an incident.

### Wasender text sending

When the outbound-send public boundary is deployed, run its smoke check only
with a dedicated operator-owned WhatsApp Connection and designated recipient.
Confirm one provider attempt and a normalized operation receipt. The currently
documented Wasender response with `status: "in_progress"` must converge only to
`accepted`; do not treat numeric `msgId` as stable message identity. Confirm
logs contain only the normalized outcome, attempt count, duration, and bounded
response-byte count. The provider request and response references are the
[send-text endpoint](https://www.wasenderapi.com/api-docs/messages/send-text-message)
and [error response](https://www.wasenderapi.com/api-docs/responses-errors/error-responses)
documentation; pause rollout on incompatible schema drift rather than adding a
permissive parser or endpoint override.

Alert on elevated ambiguous outcomes, timeouts, server errors, and malformed or
oversized responses. Never replay an ambiguous Send Operation during an
incident. Reconcile it only from authenticated webhook evidence carrying the
same connection and HMAC-protected stable message identity.

### Wasender Directory

When the authenticated Directory workflow is available, perform its provider
smoke check with a non-production WhatsApp Connection containing a reviewed
empty or disposable contact/group set. Confirm one contacts read and one groups
read succeed, telemetry contains only operation class, normalized outcome,
attempt count, duration, and bounded byte counts, and no session credential,
JID, full phone number, name, response body, or URL appears in Worker logs.
Remove the disposable connection through the normal Connection Deletion flow;
do not print or pass its session API key on a command line.

## Rollback

Vercel uses immutable deployment history. Worker rollback is a reviewed
OpenTofu apply of the last known-good commit:

1. Redeploy the last known-good Vercel deployment.
2. Check out the last known-good source, rebuild the Worker bundles, plan
   against the same remote state, and apply the reviewed rollback plan.
3. Roll back provider-control only after confirming that its API callers remain
   compatible.
4. Repeat the health checks.

If rollback overlaps a text-send timeout or interrupted response, retain the
Send Operation as `unknown` and do not issue a replacement provider call. A
rollback does not relax the single-attempt rule or turn a provider `msgId` into
correlation evidence.

Database migrations are forward-only. If application rollback would target a
binary whose compiled schema version differs from production, it will fail
closed; deploy a forward-compatible application or forward-fix migration
instead of deleting migration records or reverting tenant-isolation DDL. For a
failed, unrecorded migration, correct the cause and rerun the serialized
migration command before deploying application traffic.

Do not destroy, unlock, rename, or remove the deletion-marker bucket during a
rollback or environment teardown. Its OpenTofu resource deliberately has
`prevent_destroy`, and its indefinite lock is the restore-external deletion
authority. The Deletion Capsule bucket also has `prevent_destroy`; retain it
through rollback, and remove that safeguard only in a separately reviewed
environment teardown after the coordinator has confirmed that no capsule
remains. Retire other environment resources only after Queue drain and
retention cleanup; retain the marker bucket and its isolated encrypted state
under the production recovery authority.

## External rollout gates

Applying real infrastructure remains gated on environment-specific Cloudflare
accounts/zones, Vercel teams, state buckets/KMS keys, provider tokens, domain
ownership, and DNS approval. These values are intentionally absent from source.
No code substitution, fake provider, public provider-control route, or
production fallback is needed when the external values become available.

External onboarding and any live Directory rollout remain gated on the written
Wasender terms required by ADR 0004, including approved capacity, data
processing and subprocessors, deletion and backup erasure, security controls,
webhook authentication, and retry behavior. The real adapter remains in the
production bundle while that business gate is closed; do not route production
traffic to a test Layer or alternate origin.

Roll application code back without rolling back, replacing, disabling, or
deleting either KMS key.
Versioned ciphertext retains the key metadata needed across application
rollbacks and automatic KMS key-material rotation. Treat an incorrect key
policy or alias as a forward-fix: restore the reviewed template, validate it,
deploy it, and confirm denied/allowed CloudTrail events before reopening
traffic.
