import { strict as assert } from "node:assert";

type Statement = {
  readonly Action: string | ReadonlyArray<string>;
  readonly Effect: string;
  readonly Principal?: {
    readonly AWS?: unknown;
  };
  readonly Sid?: string;
};

type Resource = {
  readonly Properties?: {
    readonly EnableKeyRotation?: boolean;
    readonly KeyPolicy?: {
      readonly Statement?: ReadonlyArray<Statement>;
    };
  };
  readonly Type: string;
};

const template = (await Bun.file("infra/aws/kms.template.json").json()) as {
  readonly Resources?: Readonly<Record<string, Resource>>;
  readonly Rules?: Readonly<
    Record<
      string,
      {
        readonly Assertions?: ReadonlyArray<{
          readonly Assert?: {
            readonly "Fn::Not"?: ReadonlyArray<{
              readonly "Fn::Or"?: ReadonlyArray<unknown>;
            }>;
          };
        }>;
      }
    >
  >;
};

const resources = template.Resources;
assert(resources, "CloudFormation template must declare resources");
assert(
  template.Rules?.DeployOnlyInUsEast1,
  "CloudFormation template must reject regions other than us-east-1",
);
assert(
  template.Rules?.AuthoritiesUseDistinctBootstrapPrincipals,
  "CloudFormation template must reject shared authority bootstrap principals",
);
assert.equal(
  template.Rules.AuthoritiesUseDistinctBootstrapPrincipals.Assertions?.[0]
    ?.Assert?.["Fn::Not"]?.[0]?.["Fn::Or"]?.length,
  10,
  "CloudFormation template must compare every pair of authority principals",
);

for (const keyName of ["ContentRootKey", "DeletionCoordinatorKey"]) {
  const keyResource: Resource | undefined = resources[keyName];
  assert.equal(
    keyResource?.Type,
    "AWS::KMS::Key",
    `${keyName} must be a KMS key`,
  );
  assert.equal(
    keyResource?.Properties?.EnableKeyRotation,
    true,
    `${keyName} must enable rotation`,
  );
}

const contentStatements =
  resources.ContentRootKey?.Properties?.KeyPolicy?.Statement ?? [];
const contentUse = contentStatements.find(
  (statement) => statement.Sid === "AllowContentRuntimeAccountKeys",
);
assert.deepEqual(contentUse?.Action, ["kms:GenerateDataKey", "kms:Decrypt"]);

const contentDeny = contentStatements.find(
  (statement) => statement.Sid === "DenyNonContentAuthoritiesDecrypt",
);
assert.equal(contentDeny?.Effect, "Deny");
assert.equal(contentDeny?.Action, "kms:Decrypt");

const deletionStatements =
  resources.DeletionCoordinatorKey?.Properties?.KeyPolicy?.Statement ?? [];
assert.deepEqual(
  deletionStatements.find(
    (statement) => statement.Sid === "AllowContentRuntimeCapsuleEncryption",
  )?.Action,
  ["kms:Encrypt"],
);
assert.deepEqual(
  deletionStatements.find(
    (statement) => statement.Sid === "AllowCoordinatorCapsuleDecryption",
  )?.Action,
  ["kms:Decrypt"],
);

console.info(
  "KMS infrastructure declares separated us-east-1 keys, rotation, and constrained authorities.",
);
