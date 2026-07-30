# ISSUES

Here are the open issues in the repo:

<issues-json>

!`gh issue list --state open --label sandcastle --label ready-for-agent --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`

</issues-json>

The list above has already been filtered to issues ready for work.

# TASK

Select the issues that have no open native GitHub blockers. For each issue, query the native dependency endpoint:

`gh api "repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by?per_page=100"`

Infer `{owner}/{repo}` from `git remote -v`. An issue is **unblocked** only when that endpoint returns no issue whose `state` is `open`.

Native GitHub issue dependencies are the only scheduling gates. Do not infer dependency edges from implementation order, overlapping files, issue prose, or your own architecture analysis. If the dependency endpoint cannot be read, fail the plan instead of scheduling work whose dependency state is unknown.

For each unblocked issue, assign a branch name using the exact format `sandcastle/issue-{id}` (no slug or other suffix). This must be deterministic so that re-planning the same issue always produces the same branch name and accumulated progress is preserved.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42"}]}
</plan>

Include only unblocked issues. If every issue is blocked, return an empty issue list.

Always emit the `<plan>` tags, even when there is nothing to do. If there are no issues to work on at all, output `<plan>{"issues": []}</plan>` so the run can exit cleanly.
