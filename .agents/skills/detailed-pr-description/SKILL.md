---
name: detailed-pr-description
description: Write or update GitHub PR descriptions with self-contained change context, gotchas, follow-up work, code snippets, and test coverage assessment.
---

# Detailed PR Description

## Workflow

Use this skill when the user asks for a detailed PR description, a PR body rewrite, or an assessment of whether the branch's tests are strong enough to catch regressions.

1. Identify the PR and its comparison base.
   - Prefer `gh pr view --json number,title,body,baseRefName,headRefName,url` when a PR exists.
   - If there is no PR, compare against the repository's default base branch or the user-provided base and prepare a PR description draft instead of stopping.
   - Fetch the base branch if needed before relying on diffs.

2. Build the context from tracked project artifacts.
   - Inspect `git status --short`, `git diff --stat <base>...HEAD`, `git diff --name-only <base>...HEAD`, relevant commits, changed files, tests, docs, migrations, config, and generated artifacts that are part of the branch.
   - Read `.context/` only as local scratch context. Anything important from `.context/` must be restated in the PR description because `.context/` is not tracked.
   - Do not rely on memory or prior chat alone for claims about behavior.

3. Review the code like a reviewer.
   - Determine what the PR does, what behavior or maintainability it improves, and what is deliberately out of scope.
   - Identify risky code paths, compatibility concerns, edge cases, operational gotchas, migrations, flags, cleanup steps, and reviewer focus areas.
   - Pull in short, high-signal code snippets when they explain a design decision, a tricky behavior, or a key contract. Prefer file paths and line references around each snippet.

4. Assess the tests directly.
   - Inventory existing tests affected by the diff and any new tests added by the branch.
   - Run the narrowest reliable validation first, then the repository's documented broader validation when feasible.
   - Answer the regression question explicitly: are the tests sufficient, partially sufficient, or insufficient? Explain which regressions they would catch and which important regressions could still slip through.
   - Recommend concrete follow-up tests when coverage is partial or weak. Do not claim confidence from tests that were not run or do not cover the behavior.

5. Update the PR body.
   - Write the body to a temporary file, preferably under `.context/pr-description.md`.
   - Use `gh pr edit <number> --body-file .context/pr-description.md` when GitHub CLI access is available.
   - If updating GitHub is not possible, leave the full body in `.context/pr-description.md` and tell the user exactly why it was not posted.

## PR Body Shape

Err on the side of too much useful context. The body should stand alone for a reviewer who has not read the chat, local notes, or `.context/` files.

Use this structure unless the repository has a stronger PR template:

````markdown
## Summary

Briefly state the problem, the approach, and the user-visible or developer-visible outcome.

## What This PR Does

- ...

## What This Improves

- ...

## What This Does Not Do

- ...

## Important Context

- ...

## Code To Review Closely

### `path/to/file.ext`

Why this file matters and what reviewers should verify.

```language
small focused snippet
```

## Gotchas, Risks, And Edge Cases

- ...

## Tests And Regression Coverage

### Validation Run

- `command`: result

### Coverage Assessment

State whether the current tests are sufficient, partially sufficient, or insufficient.

### Regressions These Tests Should Catch

- ...

### Gaps And Recommended Follow-Up Tests

- ...

## Follow-Up Work

- ...
````

Add sections for screenshots, rollout, migrations, flags, performance, accessibility, security, or release notes when relevant. Remove empty sections only when they truly do not apply; prefer `Not applicable` over silently omitting important review dimensions.

## Quality Bar

- Make the PR description factual and traceable to code, tests, docs, commits, or command output.
- Preserve the existing PR title and useful existing body content unless replacing it improves clarity.
- Avoid vague phrases such as "various fixes" or "improves behavior" without naming the behavior.
- Keep snippets short enough to review in the PR body. Link or cite files for larger context.
- Separate verified facts from judgment calls and assumptions.
- Include failed, skipped, or unavailable validations, with the reason.
- Do not make unrelated code changes while updating the PR description unless the user explicitly asks.

## Final Response

Report the PR URL, whether the body was updated, the validation commands run, and the bottom-line test coverage assessment. If the PR could not be updated, report the path to the draft body.
