# Deployment and rollback

## Prerequisites

- Bun 1.3.14
- A Cloudflare account with Workers enabled
- An AWS account with permission to deploy CloudFormation, KMS, and named IAM
  roles in `us-east-1`
- A Vercel project whose root directory is `apps/web`
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the operator's secret
  environment, scoped to deploy these two Workers only

No Neon, Clerk, or Wasender account is required for the current boundary. The
API does require its environment-specific AWS KMS stack and short-lived
`ContentRuntimeRole` credentials before it becomes healthy.

## Verify

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run validate:infra
bun run test
bun run build
```

`bun run build` performs Wrangler dry-run production bundles for both Workers,
builds the Next.js application, and rejects any production output containing
the test Layer marker.

## Provision encryption authority

Validate and deploy one stack per deployment environment. Use five distinct
bootstrap principals for the KMS administrator, API content runtime, deletion
coordinator, provider-control, and ordinary operator parameters; reusing one
principal defeats the declared authority separation.

```sh
aws cloudformation validate-template \
  --region us-east-1 \
  --template-body file://infra/aws/kms.template.json

aws cloudformation deploy \
  --region us-east-1 \
  --stack-name whatsapp-mcp-production-kms \
  --template-file infra/aws/kms.template.json \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    DeploymentEnvironment=production \
    KmsAdministratorAssumerArn=arn:aws:iam::111122223333:role/replace-kms-admin-bootstrap \
    ContentRuntimeAssumerArn=arn:aws:iam::111122223333:role/replace-api-workload-bootstrap \
    DeletionCoordinatorAssumerArn=arn:aws:iam::111122223333:role/replace-deletion-bootstrap \
    ProviderControlAssumerArn=arn:aws:iam::111122223333:role/replace-provider-bootstrap \
    OrdinaryOperatorAssumerArn=arn:aws:iam::111122223333:role/replace-human-operator-bootstrap
```

Record the `ContentRootKeyArn`, `ContentRuntimeRoleArn`,
`DeletionCoordinatorKeyArn`, and `DeletionCoordinatorRoleArn` stack outputs in
the environment's deployment inventory. Configure
`KMS_CONTENT_ROOT_KEY_ARN` from the first output. The content key and Deletion
Capsule key are retained if a stack is deleted or replaced; never schedule
their deletion as part of ordinary rollback. The owning AWS account principal
retains key-policy recovery authority for lifecycle and policy operations only;
that statement grants no cryptographic operation.

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

Deploy the private Worker first so the API service binding always has a target:

```sh
CI=true bun run --cwd apps/provider-control wrangler deploy
CI=true bun run --cwd apps/api wrangler deploy
vercel deploy --prod --cwd apps/web
```

Set `DEPLOYMENT_ENVIRONMENT=production` in the Vercel project before deploying.
The Worker manifests set the same non-secret value and `AWS_KMS_REGION`
explicitly. Set `KMS_CONTENT_ROOT_KEY_ARN` in the API deployment configuration
and populate the three AWS credential secrets before deployment.

## Smoke check

The public checks contain no dependency details or credentials:

```sh
curl --fail --silent https://api.example.com/health
curl --fail --silent https://app.example.com/health
```

Verify provider-control through the API's service binding from an authenticated
operator canary once that endpoint is introduced; do not enable `workers.dev`
or preview URLs for provider-control.

## Rollback

Use each platform's immutable deployment history:

1. Roll back the web and API to their last known-good deployments.
2. Roll back provider-control only after callers are compatible with that
   version.
3. Repeat the health checks.

There is no database migration in this release. Roll application code back
without rolling back, replacing, disabling, or deleting either KMS key.
Versioned ciphertext retains the key metadata needed across application
rollbacks and automatic KMS key-material rotation. Treat an incorrect key
policy or alias as a forward-fix: restore the reviewed template, validate it,
deploy it, and confirm denied/allowed CloudTrail events before reopening
traffic.
