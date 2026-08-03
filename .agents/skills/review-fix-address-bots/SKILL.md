---
name: review-fix-address-bots
description: Integrate the PR base, run persistent read-only reviewers, fix and re-review findings, validate with repo-native commands, address review bots, and compare model quality.
---

# Review, Fix, and Address Bots

Execute these phases in order. The primary agent alone owns judgment, edits, commands that mutate the workspace, validation, Git, PR changes, and bot replies.

## Invariants

- Reviewers are advisory and strictly read-only. They may inspect files, diffs, history, tests, and existing output, but must not modify files or Git/PR state; run tests, builds, package scripts, generators, or arbitrary repository commands; or delegate implementation.
- Include this boundary in every reviewer prompt: “Operate in read-only mode. You are advisory only. Never modify the workspace or Git/PR state, and never commit or push. Return findings and critique to the primary agent, who makes the final decision.”
- Preserve unrelated user changes. Never use reset, automatic stashing, broad staging, history rewriting, or checkpoint commits to clear a dirty tree.
- Logging is observational. If it fails, report the failure and continue the safe workflow; never change code, judgment, Git/PR state, or loop limits for telemetry.

## 1. Prepare the integrated target

1. Read repository instructions and applicable implementation skills. Record branch, status, target, remotes, upstream, PR state, and the initial dirty-state ownership boundary. Require a named non-target branch before pushing; never rename it or push the default branch without explicit authorization.
2. Use the user's review prompt. If a requested custom prompt is unavailable, stop for it. Only when none was requested, read [references/review-guidelines.md](references/review-guidelines.md).
3. Resolve this skill's directory and run `node <skill-dir>/scripts/review-run-log.mjs templates` for canonical payloads, then `start` with the resolved cohort and limits before review work. Keep its `logPath` in `.context`; append material transitions and every reviewer invocation. Read [references/run-logging.md](references/run-logging.md) only if the helper rejects a record, logging needs extension, or telemetry behavior must be diagnosed.
4. Inspect committed, staged, unstaged, and relevant untracked changes together. Prefer Conductor's workspace diff; otherwise inspect the merge-base-to-HEAD diff, `git diff HEAD`, `git status --short`, and relevant untracked files. Exclude unrelated user work from the implementation.
5. Resolve the PR's actual base branch and repository remote; without a PR use repository configuration. Fetch that base explicitly, record its ref and SHA, and do not use `git pull`. If the fetched SHA is not an ancestor of `HEAD`, integrate it before formal review with an explicit merge by default. Rebase only when required or requested, and never rewrite published history without authorization.
6. Do not let pre-existing staged changes enter a merge commit. If dirty work makes integration unsafe, stop. Resolve conflicts from both branches' intent, surrounding code, and tests; request input for material product, UX, public API, or architecture choices. The integrated tree, conflict resolutions included, is the review target. If integration happens after review starts, invalidate every report and rerun the cohort.
7. Before the first push, resolve authority to create a PR if none exists and the bot phase requires one. Stop before the remote mutation when authority is absent.

## 2. Run independent initial reviews

Read [references/reviewer-sessions.md](references/reviewer-sessions.md) before launching. It defines cohort defaults, exact model/reasoning verification, isolated native and CLI launch patterns, stable IDs, persistent handles, and the continuity protocol.

1. Resolve the user-requested cohort or that reference's default and keep it fixed. Stop if the runtime cannot verify an exact requested/applied model, reasoning level, or persistent handle; never silently substitute.
2. Give each reviewer the same self-contained raw prompt, integrated target SHA and fingerprint, conflict summary, and role boundary. Do not expose another reviewer's findings or primary-agent conclusions. Require file, minimal line range, severity, scenario, and rationale for every finding.
3. Fingerprint `HEAD`, staged/unstaged diffs, status, and relevant untracked contents. Keep the target unchanged through all initial reports and continuity checks. Launch concurrently where possible, queue the rest unchanged, and retry a failed invocation once with the same identity and controls.
4. Log `reviewer_session_started` and every completed or failed pass using the helper's canonical fields. Use stable reviewer IDs and, after deduplication, stable finding IDs. Record real token usage only when exposed; otherwise use `null`.
5. Store non-secret handles and controls in a gitignored `.context` ledger. Before editing, resume every exact session with its original controls and require only `SESSION_CONTINUITY_OK`; log the result. If any fails, discard all reports and restart the full cohort once against the unchanged target. A second failure blocks editing.
6. Verify the target fingerprint after the handshakes. On unexpected mutation, inspect ownership and rerun the full cohort once against a stable target. Repeated instability is a blocker.

## 3. Verify findings and fix

1. Deduplicate by defect while preserving reporting reviewers/models. Independently check every claim against current code, tests, and conventions.
2. Classify each finding as `valid`, `duplicate`, `already_fixed_or_stale`, `false_positive`, `out_of_scope_user_change`, or `needs_user_decision`; log its stable ID and disposition.
3. Fix every valid in-scope issue, add focused regression coverage when practical, run narrow checks, and self-review the entire resulting diff. Request input rather than inventing material product, UX, public API, or architecture decisions.

## 4. Resume reviewers on the fixes

Resume every continuity-verified session with its original controls and read-only boundary. Never use an ephemeral or replacement session without user authorization.

1. Freeze and fingerprint the workspace. Give every reviewer the updated diff plus a cumulative ledger of all findings, classifications, evidence, changes or rejection reasons, tests, and prior pushback.
2. Ask whether root causes are fixed, regressions or related cases remain, a materially simpler bounded solution exists, tests cover the failure, or rejected findings merit reconsideration. Actionable pushback must identify a concrete failure mode, affected code, or demonstrably better bounded alternative.
3. Judge each response independently. Run at most three remediation rounds, stopping when all reviewers find the fixes adequate or remaining objections have evidence-backed dispositions. Increase scope after valid pushback: focused fix/call sites in round 1, related module boundaries/integration in round 2, and subsystem invariants/design alternatives/coverage gaps in round 3.
4. Log every pass, including no-finding passes and retries. After each pass, verify the fingerprint. If a reviewer mutated state, the primary agent safely restores only that effect, discards the report, and retries once read-only; a second mutation is a blocker.

## 5. Validate, commit, and push

1. Stage only owned files or hunks and inspect the staged diff.
2. Resolve final validation in this order: explicit user command; repository/CI instruction; otherwise the changed workspace's scripts using the package manager named by `packageManager` or its lockfile. Run `precommit` when present, else each available `lint` and `test`. For non-JavaScript projects use documented CI-equivalent checks; report unavailable coverage instead of inventing commands.
3. Commit with the repository workflow, then run final validation against the exact post-commit tree before every push. Incorporate intended tool-generated changes and rerun after any mutation. Diagnose branch-caused failures without modifying unrelated work; do not push a failing tree.
4. Confirm ownership boundaries. Immediately before pushing, record PR number, UTC review-window timestamp, and commit SHA in `.context`; refresh after a failed attempt. Push without renaming the branch and confirm the PR head equals the verified SHA.

## 6. Close the review-bot loop

1. Resolve and read the repository's `address-review-bots` skill; do not hard-code another workspace's path. Confirm the PR still targets the recorded branch and SHA and pass the push timestamp when supported.
2. Wait for every requested bot on that SHA. Missing review or timeout is unknown, not clean; an unexpected head change requires ownership reconciliation.
3. Classify every substantive observation, fix valid actionable and low-risk cleanup findings, self-review, commit, rerun final validation, and push. Repeat per `address-review-bots` until clean, a decision is needed, its loop limit is reached, or checks time out.

## Finish and report

Always attempt `finish`, even for a blocked/failed run, using event-derived reviewers/findings plus actual bot, validation, status, and SHA outcomes. For native Codex reviewers use `--collect-codex-usage`. Generate the usage section with `report`; do not manually calculate or reformat it. Treat model comparisons as one-run observations.

Report the applied cohort/controls, persistent sessions and continuity/retries, log path and derived invocation/round/usage coverage, shared/unique findings and model comparison, base SHA/integration/conflicts, all finding dispositions, remediation rounds and disagreements, validation per push, commits/PR, bot-loop outcomes, and remaining blockers. End with the helper-generated `### Reviewer token usage` section copied verbatim, with `Estimated cost` immediately after `Total`; put nothing after it.

## Resources

- [references/reviewer-sessions.md](references/reviewer-sessions.md): cohort and persistent-session mechanics.
- [references/review-guidelines.md](references/review-guidelines.md): default review criteria.
- [references/run-logging.md](references/run-logging.md): logger troubleshooting, extension, and metric semantics.
- `scripts/review-run-log.mjs`: canonical payloads, append-only log, metrics, and final report.
