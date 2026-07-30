# TASK

Implement issue {{TASK_ID}}: {{ISSUE_TITLE}}

Work on branch `{{BRANCH}}`. Only work on this issue.

# REQUIRED WORKFLOW

Load and follow the `implement` skill. Treat issue {{TASK_ID}}, its comments, and any parent PRD as the implementation spec.

Read the issue with `gh issue view {{TASK_ID}} --comments`. If it has a parent PRD, read that issue and its comments too.

Before editing, confirm `{{BRANCH}}` is checked out and record the starting `HEAD` commit. Supply that commit as the fixed point when the `implement` skill invokes the `code-review` skill.

The skill's requirements to use TDD where appropriate, run the full test suite, review the completed diff with the `code-review` skill, and commit the work are mandatory. Resolve blocking review findings before considering the implementation complete.

# PROJECT CONTEXT

Before domain work, read `CONTEXT.md` and the relevant ADRs under `docs/adr/`. Use the domain terms defined there and surface any conflict with an ADR instead of silently overriding it.

Explore the repository before editing. Pay particular attention to existing tests and established patterns around the code being changed.

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# CONSTRAINTS

- Keep the change focused on issue {{TASK_ID}}.
- Do not modify unrelated user work.
- Do not close the issue; the merge phase handles that.
- Commit the completed work with a concise message that explains the task and key decision.

# REQUIRED VERIFICATION

In addition to the verification required by the `implement` skill, run:

1. `bun run lint`
2. `bunx tsc --noEmit`
3. `bun run build`

Run relevant tests throughout development and the full test suite once at the end.

# COMPLETION

If the task cannot be completed, comment on the issue with the work performed and the remaining blocker.

Once the implementation is committed and all blocking `code-review` findings are resolved, output `<promise>COMPLETE</promise>`.
