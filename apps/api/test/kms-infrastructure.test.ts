import { describe, expect, test } from "vitest";
import template from "../../../infra/aws/kms.template.json";

type Statement = {
  readonly Action: string | ReadonlyArray<string>;
  readonly Condition?: Readonly<Record<string, unknown>>;
  readonly Effect: "Allow" | "Deny";
  readonly Principal?: unknown;
  readonly Resource?: unknown;
  readonly Sid?: string;
};

type TemplateResource = {
  readonly Properties?: {
    readonly AssumeRolePolicyDocument?: {
      readonly Statement?: ReadonlyArray<Statement>;
    };
    readonly EnableKeyRotation?: boolean;
    readonly KeyPolicy?: {
      readonly Statement?: ReadonlyArray<Statement>;
    };
    readonly ManagedPolicyArns?: ReadonlyArray<string>;
    readonly Policies?: ReadonlyArray<{
      readonly PolicyDocument: {
        readonly Statement: ReadonlyArray<Statement>;
      };
    }>;
  };
  readonly Type: string;
};

type DistinctAuthoritiesRule = {
  readonly Assertions: ReadonlyArray<{
    readonly Assert: {
      readonly "Fn::Not": ReadonlyArray<{
        readonly "Fn::Or": ReadonlyArray<{
          readonly "Fn::Equals": readonly [
            { readonly Ref: string },
            { readonly Ref: string },
          ];
        }>;
      }>;
    };
  }>;
};

const resources = template.Resources as Record<string, TemplateResource>;
const rules = template.Rules as Record<string, unknown>;

const statementsFor = (resourceName: string) => {
  const resource = resources[resourceName];
  expect(resource).toBeDefined();
  return resource?.Properties?.KeyPolicy?.Statement ?? [];
};

const actions = (statement: Statement) =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action];

describe("AWS KMS infrastructure", () => {
  test("declares distinct rotating content and deletion-coordinator keys", () => {
    expect(resources.ContentRootKey).toMatchObject({
      Properties: {
        EnableKeyRotation: true,
        KeySpec: "SYMMETRIC_DEFAULT",
        KeyUsage: "ENCRYPT_DECRYPT",
        MultiRegion: false,
        PendingWindowInDays: 30,
      },
      Type: "AWS::KMS::Key",
    });
    expect(resources.DeletionCoordinatorKey).toMatchObject({
      Properties: {
        EnableKeyRotation: true,
        KeySpec: "SYMMETRIC_DEFAULT",
        KeyUsage: "ENCRYPT_DECRYPT",
        MultiRegion: false,
        PendingWindowInDays: 30,
      },
      Type: "AWS::KMS::Key",
    });
  });

  test("lets the API content role use only account-key encryption context", () => {
    const contentUse = statementsFor("ContentRootKey").find(
      (statement) => statement.Sid === "AllowContentRuntimeAccountKeys",
    );

    expect(contentUse).toMatchObject({
      Condition: {
        "ForAllValues:StringEquals": {
          "kms:EncryptionContextKeys": [
            "environment",
            "purpose",
            "personalAccountId",
            "keyVersion",
          ],
        },
        Null: {
          "kms:EncryptionContext:environment": "false",
          "kms:EncryptionContext:keyVersion": "false",
          "kms:EncryptionContext:personalAccountId": "false",
          "kms:EncryptionContext:purpose": "false",
        },
        StringEquals: {
          "kms:EncryptionContext:environment": {
            Ref: "DeploymentEnvironment",
          },
          "kms:EncryptionContext:purpose": "personal-account-key",
        },
      },
      Effect: "Allow",
    });
    expect(contentUse && actions(contentUse)).toEqual([
      "kms:GenerateDataKey",
      "kms:Decrypt",
    ]);
  });

  test("prevents provider-control, ordinary operators, and deletion coordination from decrypting tenant content", () => {
    const contentStatements = statementsFor("ContentRootKey");
    const denied = contentStatements.find(
      (statement) => statement.Sid === "DenyNonContentAuthoritiesDecrypt",
    );

    expect(denied).toMatchObject({
      Action: "kms:Decrypt",
      Effect: "Deny",
    });
    expect(denied?.Principal).toEqual({
      AWS: [
        { "Fn::GetAtt": ["DeletionCoordinatorRole", "Arn"] },
        { "Fn::GetAtt": ["ProviderControlRole", "Arn"] },
        { "Fn::GetAtt": ["OrdinaryOperatorRole", "Arn"] },
      ],
    });
  });

  test("keeps key administration non-cryptographic", () => {
    for (const keyName of ["ContentRootKey", "DeletionCoordinatorKey"]) {
      const administration = statementsFor(keyName).find(
        (statement) => statement.Sid === "AllowKeyLifecycleAdministration",
      );

      expect(administration?.Effect).toBe("Allow");
      expect(administration?.Principal).toMatchObject({
        AWS: [
          { "Fn::GetAtt": ["KmsAdministratorRole", "Arn"] },
          {
            "Fn::Sub": expect.stringMatching(
              /^arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:root$/,
            ),
          },
        ],
      });
      expect(
        administration &&
          actions(administration).filter((action) =>
            [
              "kms:Decrypt",
              "kms:Encrypt",
              "kms:GenerateDataKey",
              "kms:ReEncryptFrom",
              "kms:ReEncryptTo",
            ].includes(action),
          ),
      ).toEqual([]);
    }
  });

  test("allows only capsule encryption and coordinator decryption on the deletion key", () => {
    const deletionStatements = statementsFor("DeletionCoordinatorKey");
    const writer = deletionStatements.find(
      (statement) => statement.Sid === "AllowContentRuntimeCapsuleEncryption",
    );
    const reader = deletionStatements.find(
      (statement) => statement.Sid === "AllowCoordinatorCapsuleDecryption",
    );

    expect(writer && actions(writer)).toEqual(["kms:Encrypt"]);
    expect(reader && actions(reader)).toEqual(["kms:Decrypt"]);
    for (const statement of [writer, reader]) {
      expect(statement?.Condition).toMatchObject({
        StringEquals: {
          "kms:EncryptionContext:environment": {
            Ref: "DeploymentEnvironment",
          },
          "kms:EncryptionContext:purpose": "deletion-capsule",
        },
      });
    }
  });

  test("does not attach AWS managed broad-access policies to runtime roles", () => {
    for (const name of [
      "ContentRuntimeRole",
      "DeletionCoordinatorRole",
      "ProviderControlRole",
      "OrdinaryOperatorRole",
      "BreakGlassRole",
    ]) {
      expect(resources[name]?.Properties?.ManagedPolicyArns ?? []).toEqual([]);
    }
  });

  test("trusts a distinct bootstrap principal for every authority", () => {
    const roleToPrincipal = {
      ContentRuntimeRole: "ContentRuntimeAssumerArn",
      DeletionCoordinatorRole: "DeletionCoordinatorAssumerArn",
      KmsAdministratorRole: "KmsAdministratorAssumerArn",
      OrdinaryOperatorRole: "OrdinaryOperatorAssumerArn",
      ProviderControlRole: "ProviderControlAssumerArn",
      BreakGlassRole: "BreakGlassAssumerArn",
    } as const;

    for (const [roleName, parameterName] of Object.entries(roleToPrincipal)) {
      expect(resources[roleName]).toMatchObject({
        Properties: {
          AssumeRolePolicyDocument: {
            Statement: [
              {
                Effect: "Allow",
                Principal: {
                  AWS: { Ref: parameterName },
                },
              },
            ],
          },
        },
      });
      const statement = resources[roleName]?.Properties
        ?.AssumeRolePolicyDocument?.Statement?.[0] as Statement | undefined;
      expect(statement && actions(statement)).toContain("sts:AssumeRole");
    }

    const principalParameters = Object.values(roleToPrincipal).sort();
    const expectedPairs = principalParameters
      .flatMap((left, leftIndex) =>
        principalParameters
          .slice(leftIndex + 1)
          .map((right) => `${left}|${right}`),
      )
      .sort();
    const distinctRule =
      rules.AuthoritiesUseDistinctBootstrapPrincipals as DistinctAuthoritiesRule;
    const comparisons =
      distinctRule.Assertions[0]?.Assert["Fn::Not"][0]?.["Fn::Or"] ?? [];
    const actualPairs = comparisons
      .map(({ "Fn::Equals": [left, right] }) =>
        [left.Ref, right.Ref].sort().join("|"),
      )
      .sort();

    expect(actualPairs).toEqual(expectedPairs);
  });

  test("limits break-glass decryption to MFA sessions tagged for one Personal Account", () => {
    expect(resources.BreakGlassRole).toMatchObject({
      Properties: {
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: ["sts:AssumeRole", "sts:TagSession"],
              Condition: {
                Bool: { "aws:MultiFactorAuthPresent": "true" },
                Null: {
                  "aws:RequestTag/personalAccountId": "false",
                  "aws:RequestTag/breakGlassRequestId": "false",
                },
              },
            },
          ],
        },
      },
    });
    const scoped = statementsFor("ContentRootKey").find(
      (statement) => statement.Sid === "AllowScopedBreakGlassDecrypt",
    );
    expect(scoped).toMatchObject({
      Action: "kms:Decrypt",
      Condition: {
        StringEquals: {
          "kms:EncryptionContext:personalAccountId":
            "$" + "{aws:PrincipalTag/personalAccountId}",
        },
        Null: { "aws:PrincipalTag/breakGlassRequestId": "false" },
      },
      Effect: "Allow",
    });
  });
});
