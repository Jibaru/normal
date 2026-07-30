# AWS encryption infrastructure

`kms.template.json` declares one environment's two non-exportable,
single-Region symmetric KMS keys and five separated IAM authorities. Deploy it
only in `us-east-1`; the template rule rejects other regions.

- `ContentRuntimeRole` can generate and decrypt only Personal Account data keys
  carrying the exact environment/account/purpose/version encryption context.
- The same role can encrypt, but cannot decrypt, Deletion Capsules.
- `DeletionCoordinatorRole` can decrypt only Deletion Capsules and is
  explicitly denied tenant-content decryption.
- `ProviderControlRole` and `OrdinaryOperatorRole` are explicitly denied
  decryption.
- `KmsAdministratorRole` can manage lifecycle and policy but receives no
  cryptographic operation.

The owning AWS account principal has the same non-cryptographic lifecycle
permissions as an emergency recovery path, preventing a retained key from
becoming unmanageable if the named administrator role is lost. It does not
receive Encrypt, Decrypt, GenerateDataKey, or ReEncrypt permission from either
key policy.

Every role trusts a different parameterized bootstrap principal. The caller
must grant each bootstrap principal `sts:AssumeRole` for only its matching role;
this template does not create or broaden those external identities.

Both keys enable automatic rotation, use a 30-day pending-deletion window, and
are retained when the stack is deleted or replaced. See the deployment runbook
for validation, stack deployment, credential delivery, monitoring, and
rollback.
