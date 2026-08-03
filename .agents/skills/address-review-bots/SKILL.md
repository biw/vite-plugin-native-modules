---
name: address-review-bots
description: Close GitHub PR review-bot feedback loops for Claude, Devin, and similar AI reviewers after a push.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Address Review Bots

## Use When

Use this after creating or pushing to a PR when the user asks to wait for Claude, Devin, or similar review-bot feedback, address bot comments, or keep iterating until bot reviews are clean.

This complements local validation. It does not replace the target repository's normal pre-push or pre-merge checks.

## Core Loop

1. Confirm the current branch has a PR:

```bash
gh pr view --json number,url,headRefOid,headRefName
```

If no PR exists, stop and tell the user this skill needs an existing PR.

2. Record the review window immediately before or after pushing:

```bash
REVIEW_BOT_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

3. Wait for review-bot checks and snapshot fresh comments:

```bash
mkdir -p .context
node scripts/review-bot-snapshot.mjs \
  --wait \
  --since "$REVIEW_BOT_SINCE" \
  --json > .context/review-bot-snapshot.json
```

Run the bundled `scripts/review-bot-snapshot.mjs` from this skill directory. If the agent cannot execute relative to the skill directory, resolve the directory containing this `SKILL.md` first and pass the script path explicitly.

If you are starting from already-posted comments and did not capture a push timestamp, omit `--since`.

4. Classify each fresh bot comment:

- `valid_actionable`: the bot found a real issue that should be fixed before merge.
- `already_fixed_or_stale`: the finding is no longer present on the current head, or the comment points at an old head.
- `false_positive`: the bot's claim is wrong; gather concrete code evidence.
- `needs_user_decision`: the change is product/UX/architecture policy rather than an obvious correctness fix.
- `valid_low_risk_cleanup`: the bot found a real, bounded improvement that is not merge-blocking but is cheap, objective, and aligned with repo conventions.
- `non_actionable`: summaries, praise, progress updates, or "no issues" comments.

Do not treat "non-blocking", "nit", "none worth an inline change", or similar wording as automatically `non_actionable`. If the comment includes concrete code references, a plausible failure mode, a consistency issue, or a maintainability concern, inspect the referenced code and classify it on its merits.

Fix `valid_actionable` comments automatically. Also fix `valid_low_risk_cleanup` comments automatically when the change is tightly scoped and does not alter product, UX, architecture policy, or public behavior in a way that needs user judgment. Leave product, UX, and architecture tradeoffs for the user unless the decision is obvious from repo conventions.

Before moving on, make a compact classification table in your notes or final answer for every substantive bot observation:

```text
permalink | isOutdated or n/a | claim | classification | evidence | reply/resolution action or why left open
```

5. Apply scoped fixes and nearby tests for valid actionable comments.

6. Self-review the delta, then verify with the repository's final validation command.

If the user has set `REVIEW_BOT_VALIDATION_COMMAND`, use it exactly. Otherwise resolve validation in this order:

1. Use a command required by repository instructions or CI.
2. Inspect the applicable package manifest, starting at the repository root and following workspace configuration for changed packages. Detect its package manager from the root manifest's `packageManager` field, then its lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json` or `npm-shrinkwrap.json`, `bun.lock` or `bun.lockb`). Do not switch package managers merely because another executable is available.
3. If a `precommit` package script exists, run it with the detected package manager, for example `pnpm run precommit`, `yarn run precommit`, `npm run precommit`, or `bun run precommit`.
4. If `precommit` is absent, run each available `lint` and `test` package script with that same package manager. Do not invoke a missing script or treat its absence as a validation failure.
5. If neither script exists, use the repository's documented non-JavaScript or CI-equivalent checks. If none can be found, report that validation coverage is unavailable instead of inventing a command.

Use narrower checks while iterating, but do not commit or push review-bot fixes without running every resolved final validation command after the last code change.

7. Commit and push if fixes were made:

```bash
git add <fixed-files>
git commit -m "fix: address review bot feedback"
git push
```

8. Repeat from step 2 until there are no fresh valid actionable or valid low-risk cleanup bot comments, remaining comments are stale/non-actionable/false positives/user decisions, or further changes would be speculative.

9. On each stable current head, scan unresolved in-scope review threads and apply the review-thread cleanup policy below before declaring the bot loop clean.

Default to at most 8 fix-push loops unless the user explicitly asks to keep going.

## Review Judgment

Treat review bots as input, not authority. A valid comment needs concrete evidence in code, tests, generated artifacts, or repo conventions. Before fixing or rejecting a substantive observation, inspect the referenced file and surrounding code.

Review bots may update an existing top-level summary comment instead of creating a fresh review comment. If a fresh bot status comment says a review summary was posted or updated, inspect that summary even when the snapshot lists it under stale comments because its original `createdAt` predates the current review window. In that case, use `updatedAt` and the status comment content to decide whether the summary needs classification.

For stale inline comments, compare the snapshot head SHA, comment commit ID, and current code.

For comments outside a resolvable review thread, leave a short PR reply when it helps future reviewers understand a rejection. Follow the stricter reply-before-resolve rules below for review threads.

## Review-Thread Cleanup

Query unresolved review threads with GitHub tooling that exposes the thread's `isResolved` and `isOutdated` fields. The snapshot helper's fresh/stale classification is based on comment SHA and time and is not a substitute for GitHub's `isOutdated` value. Confirm the PR head is still the expected current SHA before mutating any thread.

Inspect the current code and classify every unresolved in-scope thread before resolving it:

- For `isOutdated: true`, verify that the issue is fixed or no longer relevant on the current head. Resolve the thread only after that verification. No PR reply is required unless extra context would help. If the issue is still relevant, ambiguous, or needs a user decision, leave the thread unresolved.
- For `isOutdated: false`, never resolve silently. If the issue is fixed or stale, first reply in that same review thread with a concise explanation and concrete evidence from the current head, such as the function or behavior that addresses the concern and the relevant test. Resolve the thread only after GitHub confirms the reply was posted. If the reply fails, leave the thread unresolved and report the failure.
- Leave the thread unresolved when the finding is still valid, the correct fix is ambiguous, the evidence is weak, or resolution requires product, UX, public API, or architecture judgment. Report its permalink and why it remains open.

Do not treat a `false_positive` classification by itself as permission to resolve a non-outdated thread. Resolve only when concrete current-head evidence establishes that the concern is stale or no longer applies, and post that evidence in-thread first.

Example reply:

> Resolved in the current head: `addOrReplaceNewerTarget` now delegates to `mergeReopenTargetFields`, which preserves `bundleId` when a focused-window target replaces an event-derived target. Covered by `tools.test.ts`.

## Self-Review Before Push

After applying a review-bot fix and before committing or pushing, step back and review the changes as if another engineer made them. Do not assume the patch is correct because you wrote it.

Review the full `git diff`, every edited file, nearby call sites or tests, whether the fix addresses the underlying issue rather than only the bot's example, and whether it introduces new edge cases or test gaps.

The goal is not to consume all 8 loops. The goal is to push fixes that review bots and CI do not need to correct again.

If a fresh valid actionable bot finding appears after a push, deepen the next self-review: focused diff review first, then related files/tests, then module-level assumptions and failure modes if misses continue. Repeated misses mean the local review is missing context; slow down and inspect the broader subsystem before pushing again.

## Waiting Rules

Be selective about waiting for GitHub. This skill is for PR review automation after a push; for normal implementation work, the repository's local validation command is usually the faster gate. The helper waits for review-like checks matching Claude, Devin, or review patterns and should not block indefinitely on unrelated CI.

The helper's default wait limit is 35 minutes so it exceeds the Claude review workflow's
30-minute job limit. Keep those values coordinated when either limit changes.

## Helper Script

Use `scripts/review-bot-snapshot.mjs` rather than rewriting GitHub API commands. Default bots are Claude and Devin; override with `--bot-logins` or `REVIEW_BOT_LOGINS` if needed.

Common options:

```bash
node scripts/review-bot-snapshot.mjs --help
node scripts/review-bot-snapshot.mjs --wait
node scripts/review-bot-snapshot.mjs --wait --json
node scripts/review-bot-snapshot.mjs --pr 123 --bot-logins "claude[bot],devin-ai-integration[bot]"
```

## Final Response

Report:

- how many review-bot loops ran,
- which bot comments were fixed,
- which comments were rejected or left for user decision, with permalinks,
- the classification and rationale for every substantive bot observation,
- the commit SHA(s) pushed,
- the final validation command and result,
- the number of review threads resolved,
- the number resolved silently because GitHub marked them `isOutdated: true`,
- the number resolved after posting an explanatory in-thread reply,
- every unresolved thread left open, with its permalink and rationale.

If no valid comments remain, say that directly only after classifying each substantive observation. If review checks timed out, say what was checked and what is still unknown.
