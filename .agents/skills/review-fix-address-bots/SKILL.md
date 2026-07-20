---
name: review-fix-address-bots
description: Integrate the PR base, run a configurable persistent read-only reviewer cohort, fix and re-review findings, require pnpm precommit, address review bots, and compare model quality.
---

# Review, Fix, and Address Bots

Execute the phases in order. Treat reviewer read-only behavior as an invariant, not a preference. The primary agent alone owns edits, judgment, validation, staging, commits, pushes, PR mutations, and bot replies.

## Reviewer role boundary

Reviewers may read files, diffs, history, test source, existing test output, and repository instructions with read-only tools. Explicitly prohibit each reviewer from:

- creating, editing, moving, or deleting files,
- executing tests, builds, typechecks, linters, formatters, generators, installers, package scripts, or arbitrary repository commands,
- staging, committing, amending, rebasing, resetting, checking out, or pushing,
- creating or updating PRs, reviews, comments, checks, or other external state,
- delegating implementation to another agent.

Tell each reviewer: “Operate in read-only mode. You are advisory only. Never modify the workspace or Git/PR state, and never commit or push. Return findings and critique to the primary agent, who makes the final decision.”

## Run log

Read [references/run-logging.md](references/run-logging.md) completely. Start its structured run log before phase 1, append an event after every reviewer pass and material workflow transition, and finish it even when the run is blocked or fails. Keep requested and actually applied reviewer settings separate, use stable reviewer and deduplicated finding IDs, and record actual token usage only when the runtime exposes it.

Logging is observational. Do not change review judgment, code, Git history, PR state, or loop limits merely to improve telemetry. If logging fails, report the failure and continue the safe review workflow.

## 1. Establish the review target

1. Read repository instructions and the applicable implementation skills.
2. Confirm the current branch, worktree status, target branch, upstream/remote, and existing PR state. Require a named, non-target branch before pushing. Never rename the branch unless the user explicitly requests it, and never push the default branch without explicit authorization.
3. Snapshot the initial dirty state and preserve unrelated user changes. Review committed, staged, unstaged, and relevant untracked changes together. Do not treat unrelated user work as part of the implementation.
4. Use the review prompt supplied by the user. If the user references a custom prompt that is missing or unreadable, stop and request the artifact instead of silently substituting different criteria. Only when no custom prompt was requested, read [references/review-guidelines.md](references/review-guidelines.md) completely and use it.
5. Prefer the Conductor workspace-diff tool when available. Otherwise compute the merge base with the configured target branch (normally `origin/main`), inspect both diffs, inspect `git status --short`, and read relevant untracked files explicitly:

```bash
MERGE_BASE=$(git merge-base origin/main HEAD)
git diff "$MERGE_BASE" HEAD
git diff HEAD
git status --short
```

6. Resolve PR creation authority before the first push. If the review-bot phase requires a PR and none exists, create one only when the user has authorized that action; otherwise stop before mutating the remote.

## 2. Integrate the target branch before review

1. Determine the PR's actual base branch and the configured remote that represents its repository. If no PR exists yet, use the target branch established from repository instructions or configuration. Do not assume `origin/main`, and do not confuse the feature branch's upstream with the PR base.
2. Fetch the base explicitly, then record the exact fetched ref and SHA. Do not use `git pull` for this integration:

```bash
git fetch "$TARGET_REMOTE" "$TARGET_BRANCH"
TARGET_REF="$TARGET_REMOTE/$TARGET_BRANCH"
TARGET_SHA=$(git rev-parse "$TARGET_REF")
```

3. If `TARGET_SHA` is already an ancestor of `HEAD`, continue without creating an integration commit. Otherwise, integrate the recorded target before launching reviewers. Default to an explicit merge:

```bash
git merge --no-edit "$TARGET_SHA"
```

Rebase only when repository conventions require it or the user explicitly requests it. For an already-pushed or shared branch, do not rewrite published history or force-push without explicit authorization.

4. Preserve the initial ownership boundaries while integrating. Never use reset, automatic stashing, broad staging, or an unrelated checkpoint commit to make the merge proceed. Do not allow pre-existing staged changes to become part of a merge commit. If unrelated dirty work makes integration unsafe, stop and report what must be preserved.
5. If the merge or authorized rebase conflicts, resolve the conflicts before formal review. Inspect the base version, feature version, surrounding code, branch intent, and relevant tests; do not mechanically choose one side. Run focused checks for the resolved areas. Stop for user input when correct resolution requires a material product, UX, public API, or architecture decision.
6. Treat the integrated tree, including every conflict resolution, as the review target. Include the target SHA and a summary of resolved files in the reviewer context. Do not spend the configured formal reviews on the pre-integration tree. If integration occurs after a formal review has started, invalidate that review and rerun the entire configured cohort against the new stable target.

## 3. Run independent reviews

Read [references/reviewer-sessions.md](references/reviewer-sessions.md) completely before launching reviewers.

1. Use the reviewer count, models, and reasoning levels explicitly requested by the user. Otherwise use the default high-thinking cohort: one `gpt-5.6-sol`, two `gpt-5.6-terra`, and two `gpt-5.6-luna`, with IDs `sol-1`, `terra-1`, `terra-2`, `luna-1`, and `luna-2`. If the user requests only a count from one through five, use that many reviewers from this default order; ask for a model mix when a count above five is otherwise underspecified. Keep the resolved cohort unchanged for the run.
2. Verify that the runtime actually applied the exact model and thinking level to every reviewer invocation. If either control is unavailable for any cohort member, stop and report the blocker. Do not substitute another model or thinking level unless the user explicitly authorizes it, and never claim settings that were not actually configured.
3. Give every configured reviewer the same raw review prompt, review target, and reviewer role boundary. Tell them to inspect the repository themselves and report every qualifying finding with file, minimal line range, severity, scenario, and concise rationale.
4. Do not show any reviewer another reviewer's findings or the primary agent's conclusions.
5. Before launching, fingerprint `HEAD`, staged and unstaged diffs, status, and relevant untracked-file contents. Keep the target unchanged until every initial report and continuity handshake finishes. Afterward, verify the fingerprint is unchanged. If it changed unexpectedly, inspect ownership and rerun the full cohort once against the new stable target. If instability recurs, stop and report the changing review target instead of looping.
6. Launch as many reviewers concurrently as the runtime permits and queue the remainder without changing their prompt or target. Wait for every configured report. If one invocation fails, retry that reviewer once with the same identity, model, thinking level, isolated prompt, and target. Report a persistent failure rather than substituting a different reviewer.
7. Immediately log each completed or failed initial reviewer invocation with its reviewer ID, launch mechanism, session identifier, model and reasoning requested/applied, round, duration, and token usage when available. After deduplication, append the stable finding IDs or include them in the final summary.

### Reviewer session persistence is required

Treat resumability as a prerequisite because phase 5 must continue the exact same configured sessions.

1. Capture every native session handle or CLI thread ID and its launch controls in a gitignored `.context` operational ledger before making fixes. Also record the non-secret session identifier in the observational run log.
2. Immediately after all initial reports return—and before editing—resume each same session and ask it to reply only `SESSION_CONTINUITY_OK`, with the reviewer role boundary and identical model and thinking controls still in force.
3. Log every successful or failed handshake as `reviewer_continuity_verified`. A logging failure remains observational, but a continuity failure blocks editing.
4. Do not enter phase 4 until every handshake succeeds. If any session is not resumable, discard the entire cohort's reports and restart the entire cohort once while the target remains unchanged. If resumability fails again, stop and report the blocker.

## 4. Verify and resolve findings

1. Combine and deduplicate the configured reports by underlying defect, not wording. Preserve which reviewers and model families reported each finding so model-level comparisons remain possible.
2. Independently inspect every claimed issue against the current diff, surrounding code, tests, and repository conventions.
3. Classify each finding as `valid`, `duplicate`, `already_fixed_or_stale`, `false_positive`, `out_of_scope_user_change`, or `needs_user_decision`.
4. Fix all valid, in-scope findings. Add or update focused regression tests when practical.
5. Do not make speculative product, UX, public API, or architecture decisions. Stop for user input only when such a decision materially changes the requested result.
6. Run narrow checks while iterating, then self-review the complete resulting diff.

## 5. Have reviewers critique the fixes

Use the same configured session handles recorded and continuity-checked in phase 3 so every reviewer retains the context behind its findings. Resume each with its original explicit model and reasoning controls, keep every reviewer read-only, and never use an ephemeral session. If the runtime cannot continue any exact session, stop and report the limitation unless the user authorizes replacement sessions; never silently substitute a new reviewer.

1. After the primary agent implements and locally checks the fixes, fingerprint the stable workspace again. Do not edit while reviewers inspect it.
2. Send every configured reviewer the updated diff plus a cumulative ledger containing every original finding and all prior remediation pushback: classification, primary-agent evidence and decision, change made or reason rejected, relevant tests, and repository context that affected the decision.
3. Ask each reviewer to assess:
   - whether each valid finding is fully fixed at the underlying cause,
   - whether the solution introduces regressions or misses related cases,
   - whether a materially simpler or cleaner implementation exists,
   - whether tests adequately exercise the failure mode,
   - whether any rejected finding should be reconsidered given the evidence.
4. Require actionable pushback to identify a concrete failure mode, affected code, or demonstrably better bounded alternative. Treat preference-only rewrites as non-actionable.
5. Independently judge every response. Apply valid improvements, reject weak or context-missing advice with evidence, and retain final authority; reviewer approval is advisory and is not a merge gate.
6. Run at most three remediation-review rounds. Stop early when every configured reviewer finds the fixes adequate or all remaining objections have evidence-backed final dispositions.
7. Increase review depth after each round of valid pushback. Explicitly include the new scope and supporting evidence in the follow-up prompt so reviewers do not merely repeat the prior pass:
   - Round 1: inspect the focused fix, regression test, and immediate call sites.
   - Round 2: inspect related module behavior, boundary conditions, and integration assumptions.
   - Round 3: inspect subsystem invariants, alternative designs, failure modes, and test coverage gaps.
8. After round 3, make and document the primary agent's final decision for every remaining disagreement. Do not continue looping unless the user explicitly requests another round.
9. After each reviewer pass, verify the workspace fingerprint. Treat any reviewer-caused mutation as a protocol violation. The primary agent—not the reviewer—must inspect and safely restore only the reviewer-caused effect, discard that review result, and rerun once with a read-only reviewer. The reviewer must take no corrective write action. If the replacement also mutates state, stop and report the repeated protocol violation.
10. Log every remediation invocation, including passes with no findings, retries, and the stable finding IDs each reviewer repeated or uniquely discovered. Preserve the reviewer model on every record.

## 6. Validate, commit, and push

1. Stage only agent-owned files or hunks; do not use broad staging that could capture pre-existing work. Inspect `git diff --cached` before committing.
2. Commit with the repository's commit workflow, then run `pnpm precommit` against the exact post-commit tree. It must pass before every push, including later review-bot fix pushes. If a hook, formatter, generator, or other tool changes files after it passes, incorporate the intended changes and rerun it. Never rely on a result from before the latest tree mutation.
3. If `pnpm precommit` fails, diagnose and resolve failures caused by the branch. Do not push while it is failing. Do not modify unrelated user work merely to make the command pass; report a genuinely unrelated blocker with evidence.
4. Confirm the committed diff and remaining worktree state contain only the intended ownership boundaries.
5. Immediately before pushing, record the PR number, UTC review-window timestamp, and pushed commit SHA in `.context`. Recapture the timestamp after a failed or retried push.
6. Push the verified SHA to the intended remote and branch without renaming it. Confirm the PR head now equals that SHA.

## 7. Close the review-bot loop

1. Read and follow the repository's `address-review-bots` skill completely. Resolve it from the current repository's skill catalog; do not hard-code a path from another workspace.
2. Confirm the expected GitHub PR still targets the pushed branch and SHA.
3. Pass the recorded push timestamp into the review-bot workflow when supported.
4. Wait for each specifically requested review bot to review the recorded pushed SHA. Treat a missing bot review or timeout as unknown, not clean. If the PR head changes unexpectedly, stop and reconcile ownership before processing feedback.
5. Classify every substantive observation, fix valid actionable and valid low-risk cleanup findings, and self-review the delta.
6. After any bot-driven code change, commit the owned fix and run a fresh `pnpm precommit` against the resulting tree before pushing.
7. Repeat the bot loop according to `address-review-bots` until clean, a user decision is required, the skill's loop limit is reached, or checks time out.

## Finalize the run log

Before the final response, finish the run log with the actual reviewer sessions, every invocation and round, launch mechanisms, continuity outcomes, requested/applied model and reasoning controls, the deduplicated finding ledger and reporting reviewers, GitHub review bots observed, bot-loop count, classifications and outcomes, validation results, pushed SHAs, status, and token usage when available. For native Codex reviewers, pass `--collect-codex-usage` to the finish command so the helper discovers and validates persisted session counters deterministically. Use the helper's derived reviewer- and model-level comparisons rather than judging quality or redundancy from wording alone. Treat one run as an observation, not a conclusive model ranking.

## Final report

Report:

- whether every configured initial reviewer completed and whether each requested model/reasoning combination was actually applied,
- the launch mechanism for each reviewer, whether every configured persistent handle was recorded, whether the phase-3 continuity handshakes succeeded, and whether any cohort was discarded and retried,
- the run-log path, actual reviewer session/invocation counts, rounds per reviewer, and token-usage coverage,
- the exact generated reviewer-usage Markdown section defined in `references/run-logging.md`, with `Estimated cost` immediately after `Total`, as the final section of the response even when some values are `n/a`; copy the helper output verbatim and put nothing after it,
- which findings were shared across reviewers and which were unique, using the deduplicated finding IDs and derived overlap,
- the observed per-model comparison, including classified and valid initial findings, model-unique valid findings, cross-model overlap, and token usage when available,
- the fetched target branch and SHA, integration method, and any conflict resolutions,
- each distinct initial finding and its classification or fix,
- remediation-review round count, reviewer pushback, improvements made, and evidence-backed final disagreements,
- the `pnpm precommit` result for every push,
- commit SHA(s) and PR URL,
- review-bot loop count and the classification/action for every substantive bot observation,
- any remaining user decision, timeout, or external blocker.
