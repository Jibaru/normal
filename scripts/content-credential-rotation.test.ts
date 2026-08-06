import { describe, expect, test } from "bun:test";

const read = (path: string) =>
  Bun.file(new URL(`../${path}`, import.meta.url)).text();

describe("production content credential rotation", () => {
  test("limits the GitHub OIDC broker to the protected production environment and runtime role", async () => {
    type Statement = {
      readonly Action?: string;
      readonly Condition?: Readonly<Record<string, unknown>>;
    };
    type BrokerTemplate = {
      readonly Resources: {
        readonly ContentCredentialBrokerRole: {
          readonly Properties: {
            readonly AssumeRolePolicyDocument: {
              readonly Statement: ReadonlyArray<Statement>;
            };
            readonly Policies: unknown;
          };
        };
        readonly GitHubOidcProvider: {
          readonly Properties: {
            readonly ClientIdList: ReadonlyArray<string>;
            readonly Url: string;
          };
        };
      };
    };
    const template = JSON.parse(
      await read("infra/aws/content-credential-broker.template.json"),
    ) as BrokerTemplate;
    const resources = template.Resources;
    const provider = resources.GitHubOidcProvider.Properties;
    const broker = resources.ContentCredentialBrokerRole.Properties;
    const webIdentity = broker.AssumeRolePolicyDocument.Statement.find(
      (statement) => statement.Action === "sts:AssumeRoleWithWebIdentity",
    );
    if (webIdentity?.Condition === undefined)
      throw new Error("GitHub OIDC trust condition is required");
    const substitution = (name: string) => `${"$"}{${name}}`;
    const githubSubject = `repo:${substitution("GitHubRepositoryIdentity")}:environment:${substitution("GitHubEnvironment")}`;

    expect(provider.Url).toBe("https://token.actions.githubusercontent.com");
    expect(provider.ClientIdList).toEqual(["sts.amazonaws.com"]);
    expect(webIdentity.Condition.StringEquals).toEqual({
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": {
        "Fn::Sub": githubSubject,
      },
    });
    expect(broker.Policies).toEqual([
      {
        PolicyDocument: {
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Resource: { Ref: "RuntimeRoleArn" },
            },
          ],
          Version: "2012-10-17",
        },
        PolicyName: "AssumeContentRuntimeRole",
      },
    ]);
  });

  test("rotates all three API session secrets before expiry and during deployment", async () => {
    const rotation = await read(
      ".github/workflows/rotate-production-content-credentials.yml",
    );
    const deployment = await read(".github/workflows/deploy-production.yml");

    expect(rotation).toContain('cron: "7,27,47 * * * *"');
    expect(rotation).toContain("environment: production");
    expect(rotation).toContain("id-token: write");
    expect(rotation).toContain("role-chaining: true");
    expect(rotation).toContain("wrangler secret bulk");
    expect(deployment).toContain("Rotate API Content Runtime credentials");
    expect(deployment).toContain("id-token: write");
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]) {
      expect(rotation).toContain(name);
      expect(deployment).toContain(name);
    }
    expect(rotation).not.toMatch(/secrets\.AWS_(?:ACCESS|SECRET|SESSION)/u);
    expect(deployment).not.toMatch(/secrets\.AWS_(?:ACCESS|SECRET|SESSION)/u);
  });
});
