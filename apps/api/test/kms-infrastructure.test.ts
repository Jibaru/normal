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

const resources = template.Resources as Record<string, TemplateResource>;

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
    } as const;

    for (const [roleName, parameterName] of Object.entries(roleToPrincipal)) {
      expect(resources[roleName]).toMatchObject({
        Properties: {
          AssumeRolePolicyDocument: {
            Statement: [
              {
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: {
                  AWS: { Ref: parameterName },
                },
              },
            ],
          },
        },
      });
    }
  });
});
