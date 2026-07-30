// Verifies that the GitHub CLI inside a Sandcastle Docker sandbox can
// authenticate and mutate issues (close + comment).
//
// Usage:
//   bun run .sandcastle/verify-gh.ts
//
// The script creates a test issue, comments on it, closes it, and then deletes
// the issue so the repo isn't left with test noise.

import { execFileSync } from "node:child_process";
import { createSandbox } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const githubToken =
  process.env.GITHUB_TOKEN ??
  process.env.GH_TOKEN ??
  (() => {
    try {
      return execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return undefined;
    }
  })();

if (!githubToken) {
  console.error(
    "GitHub authentication is unavailable. Run `gh auth login` or set GITHUB_TOKEN.",
  );
  process.exit(1);
}

const branch = `sandcastle/verify-gh-${Date.now()}`;

const sandbox = await createSandbox({
  branch,
  sandbox: docker({
    env: { GITHUB_TOKEN: githubToken },
  }),
});

const exec = async (command: string) => {
  console.log(`\n$ ${command}`);
  const result = await sandbox.exec(command, {
    onLine: (line) => console.log(line),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed with exit code ${result.exitCode}: ${command}\n${result.stderr}`,
    );
  }
  return result.stdout;
};

try {
  await exec("gh auth status");

  const createOutput = await exec(
    'gh issue create --title "Sandcastle GH auth verification" --body "This issue was created by the Sandcastle verify-gh script. It will be closed and deleted automatically." --label "Sandcastle"',
  );

  const issueNumberMatch = createOutput.match(/issues\/(\d+)/);
  if (!issueNumberMatch) {
    throw new Error(`Could not extract issue number from: ${createOutput}`);
  }
  const issueNumber = issueNumberMatch[1];
  console.log(`Created test issue #${issueNumber}`);

  await exec(`gh issue comment ${issueNumber} --body "Comment from sandbox"`);
  await exec(
    `gh issue close ${issueNumber} --comment "Closed by Sandcastle verify-gh script"`,
  );
  await exec(`gh issue delete ${issueNumber} --yes`);

  console.log(
    "\n✅ GitHub CLI inside Docker sandbox can create, comment, close, and delete issues.",
  );
} catch (error) {
  console.error("\n❌ Verification failed:", error);
  process.exitCode = 1;
} finally {
  await sandbox.close();
  // Clean up the throwaway verification branch.
  await Bun.$`git branch -D ${branch}`.catch(() => {});
}
