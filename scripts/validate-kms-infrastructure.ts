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

type RuleCondition = {
  readonly "Fn::Equals"?: ReadonlyArray<unknown>;
  readonly "Fn::Or"?: ReadonlyArray<RuleCondition>;
};

const template = (await Bun.file("infra/aws/kms.template.json").json()) as {
  readonly Resources?: Readonly<Record<string, Resource>>;
  readonly Rules?: Readonly<
    Record<
      string,
      {
        readonly Assertions?: ReadonlyArray<{
          readonly Assert?: {
            readonly "Fn::Not"?: ReadonlyArray<RuleCondition>;
          };
        }>;
      }
    >
  >;
};

const resources = template.Resources;
const countEqualityComparisons = (condition: RuleCondition): number =>
  (condition["Fn::Equals"] === undefined ? 0 : 1) +
  (condition["Fn::Or"] ?? []).reduce(
    (count, child) => count + countEqualityComparisons(child),
    0,
  );
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
  countEqualityComparisons(
    template.Rules.AuthoritiesUseDistinctBootstrapPrincipals.Assertions?.[0]
      ?.Assert?.["Fn::Not"]?.[0] ?? {},
  ),
  15,
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

const brokerTemplate = (await Bun.file(
  "infra/aws/content-credential-broker.template.json",
).json()) as {
  readonly Resources?: Readonly<Record<string, Resource>>;
};
const brokerResources = brokerTemplate.Resources;
assert(brokerResources, "Content credential broker must declare resources");
assert.equal(
  brokerResources.GitHubOidcProvider?.Type,
  "AWS::IAM::OIDCProvider",
);
assert.equal(
  brokerResources.ContentCredentialBrokerRole?.Type,
  "AWS::IAM::Role",
);

const broker = brokerResources.ContentCredentialBrokerRole as Resource & {
  readonly Properties?: {
    readonly AssumeRolePolicyDocument?: {
      readonly Statement?: ReadonlyArray<{
        readonly Action?: string;
        readonly Condition?: Readonly<Record<string, unknown>>;
        readonly Principal?: Readonly<Record<string, unknown>>;
      }>;
    };
    readonly Policies?: ReadonlyArray<{
      readonly PolicyDocument?: {
        readonly Statement?: ReadonlyArray<{
          readonly Action?: string;
          readonly Effect?: string;
          readonly Resource?: unknown;
        }>;
      };
    }>;
  };
};
const oidcTrust = broker.Properties?.AssumeRolePolicyDocument?.Statement?.find(
  (statement) => statement.Action === "sts:AssumeRoleWithWebIdentity",
);
const substitution = (name: string) => `${"$"}{${name}}`;
const githubSubject = `repo:${substitution("GitHubRepository")}:environment:${substitution("GitHubEnvironment")}`;
assert.deepEqual(oidcTrust?.Condition, {
  StringEquals: {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": {
      "Fn::Sub": githubSubject,
    },
  },
});
assert.deepEqual(broker.Properties?.Policies?.[0]?.PolicyDocument?.Statement, [
  {
    Action: "sts:AssumeRole",
    Effect: "Allow",
    Resource: { Ref: "RuntimeRoleArn" },
  },
]);

console.info(
  "Content credential broker restricts GitHub OIDC and runtime role authority.",
);
