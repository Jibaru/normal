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
- Approved API and web custom domains
- An encrypted, versioned S3 remote-state bucket and KMS key in `us-east-1`
  for each environment
- Short-lived `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `VERCEL_API_TOKEN`, and
  AWS credentials for exactly the environment being changed

No Clerk tenant or Wasender account is required to build and verify the
source-controlled platform. A real Directory smoke check additionally requires
one vendor-approved Wasender account and one connected non-production WhatsApp
Connection whose session API key is stored through the normal envelope-
encrypted connection-authority path. Exercising the real text-send adapter also
requires a designated test recipient for that connection. Never substitute a
PAT, committed key, or production-selectable fake. The API requires its
environment-specific AWS KMS stack and short-lived `ContentRuntimeRole`
credentials before it becomes healthy.

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
builds the Next.js application, and rejects any production output containing
the test Layer marker. Manifest validation dry-runs development, preview, and
production. Infrastructure validation checks formatting and provider schemas,
then runs mocked OpenTofu plans for all environments. Mock providers exist only
in `topology.tftest.hcl`; no production input can select them.

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
and inspect a saved plan:

```sh
tofu -chdir=infra/compute init \
  -reconfigure \
  -backend-config="$BACKEND_CONFIG_PATH"
bun run build
tofu -chdir=infra/compute plan \
  -var-file="$TFVARS_PATH" \
  -out="$DEPLOYMENT_ENVIRONMENT.tfplan"
tofu -chdir=infra/compute show "$DEPLOYMENT_ENVIRONMENT.tfplan"
```

Confirm that the plan contains exactly one Vercel web project/domain, a public
API Worker/custom domain, one private provider-control Worker, disabled
`workers.dev` and preview URLs for both Workers, and an API-to-provider-control
service binding. Apply the reviewed plan:

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
migration—add a new forward migration.

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
`KMS_CONTENT_ROOT_KEY_ARN` from `content_root_key_arn`. The content key and
Deletion Capsule key are retained if a stack is deleted or replaced; never
schedule their deletion as part of ordinary rollback. The owning AWS account
principal retains key-policy recovery authority for lifecycle and policy
operations only; that statement grants no cryptographic operation.

The API credential broker must assume only `ContentRuntimeRole` and continuously
rotate its short-lived access key, secret, and session token in the Cloudflare
secret store before expiration. Configure the three values with `wrangler
secret put`; do not give Cloudflare the administrator, deletion coordinator,
provider-control, or ordinary operator credentials. The trusted bootstrap
principal also needs a narrowly scoped `sts:AssumeRole` identity policy for
that one role because the template deliberately declares only each role's trust
side.

AWS KMS records cryptographic operations in CloudTrail. Encryption context is
non-secret audit data and is limited here to environment, purpose, opaque
Personal Account or deletion-marker identity, and key version. Alert on denied
decrypts, disabled keys, scheduled deletion, policy changes, and rotation being
disabled. Never copy key plaintext, application plaintext, data-key envelopes,
or ciphertext into application logs or incident tickets.

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
bun scripts/render-api-wrangler.ts apps/api/.wrangler/production.jsonc
CI=true bun run --cwd apps/api wrangler deploy \
  --config .wrangler/production.jsonc
unset CLOUDFLARE_HYPERDRIVE_ID CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID
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
identifiers are present.
The Worker manifests set `AWS_KMS_REGION` explicitly. Set
`KMS_CONTENT_ROOT_KEY_ARN` in the API deployment configuration and populate the
three AWS credential secrets before deployment.

## Smoke check

The public checks contain no dependency details or credentials:

```sh
API_ORIGIN="$(tofu -chdir=infra/compute output -raw api_origin)"
WEB_ORIGIN="$(tofu -chdir=infra/compute output -raw web_origin)"
curl --fail --silent "$API_ORIGIN/health"
curl --fail --silent "$API_ORIGIN/ready"
curl --fail --silent "$WEB_ORIGIN/health"
```

The readiness response proves a restricted Hyperdrive connection can read the
exact expected schema version. It emits only an allowlisted request outcome;
database URLs, SQL, tenant identifiers, and migration errors are never logged.
Verify provider-control through the API's service binding from an authenticated
operator canary once that endpoint is introduced; do not enable `workers.dev`
or preview URLs for provider-control.

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
