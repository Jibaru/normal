# TASK

Review the changes on branch `{{BRANCH}}` against `{{TARGET_BRANCH}}`, remediate actionable findings, and preserve the behavior required by the originating issue or PRD.

# REQUIRED WORKFLOW

Load and follow the `code-review` skill with `{{TARGET_BRANCH}}` as the fixed point. Review `git diff {{TARGET_BRANCH}}...HEAD`; do not substitute a different comparison.

Before reviewing, confirm `{{BRANCH}}` is checked out and that `{{TARGET_BRANCH}}` resolves.

Use issue references in the branch commits to locate the originating issue and any parent PRD. Treat them as the Spec source. Include `.sandcastle/CODING_STANDARDS.md`, `CONTEXT.md`, relevant ADRs under `docs/adr/`, and any other repository guidance discovered by the skill as Standards sources.

The `code-review` skill itself is read-only. After it produces its separate Standards and Spec reports:

1. Fix every blocking finding on `{{BRANCH}}`.
2. Apply advisory findings only when they clearly improve clarity, consistency, or maintainability without expanding scope or changing required behavior.
3. Do not act on dismissed findings.
4. Run relevant tests, type checking, and project-required verification.
5. Re-run the `code-review` skill using the first report as the finding ledger and the same fixed point.
6. Repeat until both Standards and Spec pass, then commit the remediation with a concise message.

If the first review has no changes worth making, do not create an empty commit.

# CONTEXT

## Branch Diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Branch Commits

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# CONSTRAINTS

- Keep all changes within the originating issue's scope.
- Preserve required functionality; do not turn optional refactoring preferences into behavior changes.
- Do not modify unrelated user work.
- Keep advisory findings visible, but remember that they do not fail an axis.

# COMPLETION

Once both review axes pass and any remediation is committed, output `<promise>COMPLETE</promise>`.
