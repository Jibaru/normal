# Deployment configuration

Configuration is validated in each production Effect composition root before a
request is accepted. Production roots accept only `development`, `preview`, or
`production`; `test` is reserved for statically separate test Layers.

| Value | Sensitivity | Consumer | Source and rotation |
| --- | --- | --- | --- |
| `DEPLOYMENT_ENVIRONMENT` | Non-secret | Web, API, provider-control | Set to the deployed environment. Change only as part of a deployment. |
| `DATABASE_URL` | Secret | Future API database Layer in `@whatsapp-mcp/db/config` | Issue a restricted Neon role URL, store it in the deployment secret store, and rotate it through Neon plus the deployment platform. It is not consumed by the canary-only deployables yet. |
| `AWS_KMS_REGION` | Non-secret | API | Must be exactly `us-east-1`, matching ADR 0013 and the KMS stack region. |
| `KMS_CONTENT_ROOT_KEY_ARN` | Non-secret | API | The environment's `ContentRootKeyArn` CloudFormation output. The production root accepts only a `us-east-1` KMS key ARN. |
| `AWS_ACCESS_KEY_ID` | Secret | API | Short-lived access key from the environment's `ContentRuntimeRole`; rotate before the role session expires. |
| `AWS_SECRET_ACCESS_KEY` | Secret | API | Short-lived secret paired with `AWS_ACCESS_KEY_ID`; never log or commit it. |
| `AWS_SESSION_TOKEN` | Secret | API | Required role-session token. Its absence prevents the API composition root from serving requests. |

The API Worker receives a `PROVIDER_CONTROL` Cloudflare service binding. It is
not a string environment value and cannot be supplied by a public request.
The API health boundary fails closed when this required binding is absent.
Provider-control has both `workers_dev` and preview URLs disabled, so the
service binding is its only declared ingress.

The API production root also fails closed before serving requests when its KMS
region, key ARN, or any short-lived role credential is absent or invalid.
`KMS_CONTENT_ROOT_KEY_ARN` is safe to place in deployment configuration, while
all three credential values belong in the platform secret store. The SDK
receives redacted Effect configuration values and no credential, plaintext key,
plaintext content, or ciphertext is included in application telemetry.

Example files contain placeholders only. Add secrets with the platform secret
command; never commit a populated environment file or `.dev.vars`.
