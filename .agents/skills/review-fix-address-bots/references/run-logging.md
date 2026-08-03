# Review Run Logging

For ordinary runs, resolve this skill's directory and use `node <skill-dir>/scripts/review-run-log.mjs templates` instead of loading this reference. Use the details below to diagnose rejected records, extend telemetry, or interpret derived metrics.

Write one append-only JSONL file per skill run under:

```text
${CODEX_HOME:-~/.codex}/log/review-fix-address-bots/YYYY/MM/DD/
```

This mirrors Codex's session date layout while keeping repository identity inside each run. The default `~/.codex/log/` directory is runtime state and should remain ignored by any repository containing `CODEX_HOME`.

## Start and Events

Resolve the directory containing the skill's `SKILL.md`, then start the log before review work:

```bash
node scripts/review-run-log.mjs start \
  --repo-root "$PWD" \
  --data-json '{"requestedReviewerCount":3,"reviewerCohortRequested":[{"model":"gpt-5.6-sol","count":1},{"model":"gpt-5.6-terra","count":1},{"model":"gpt-5.6-luna","count":1}],"reasoningRequested":"high","remediationRoundLimit":3,"reviewBotLoopLimit":8}'
```

Keep the returned `logPath` in `.context`. Append an event immediately after each reviewer pass so partial runs remain useful if later work stops:

```bash
node scripts/review-run-log.mjs append \
  --log "$REVIEW_RUN_LOG" \
  --event reviewer_pass_completed \
  --data-file .context/reviewer-pass.json
```

Useful events include `target_integrated`, `reviewer_session_started`, `reviewer_pass_completed`, `reviewer_continuity_verified`, `finding_classified`, `validation_completed`, `push_completed`, `review_bot_loop_completed`, and `run_blocked`. Events may evolve; keep names lower snake case.

Record experimental inputs when they become known: custom-versus-bundled review prompt source and SHA-256 fingerprint, target/base/head SHAs, diff size, the requested reviewer cohort, round limits, requested reasoning, launch mechanisms, retries, and relevant skill options. The helper fingerprints the skill instructions and logger automatically. Hash custom prompts instead of storing their contents. The `start` example shows the default cohort; replace its configuration with the resolved user override when applicable.

For every reviewer pass, record:

- stable `reviewerId`, phase (`initial` or `remediation`), and one-based round,
- invocation start/completion order, launch mechanism, and session identifier when available,
- requested and actually applied model and reasoning level separately,
- continuity-handshake result for every persistent session,
- stable deduplicated `findingIds` once available,
- whether the pass found any issue and whether findings were new, repeated, or overlapping,
- actual token usage when the runtime exposes it; otherwise use `null`, never an estimate,
- duration when observable and any failure or retry.

Use these exact event keys: `reviewerId`, `findingIds`, `sessionId`, and `tokenUsage`.
The finish helper reconstructs the canonical reviewer rounds and continuity checks from these
events. This is the source of truth; do not hand-write aliases such as `reviewer`,
`finding_ids`, `id`, `model`, or `initialFindingIds` in the finish summary.

Do not log full prompts, full review bodies, code contents, credentials, environment variables, or auth material. Finding IDs and concise summaries are enough for later analysis.

## Finish Schema

Always attempt `finish`, including for blocked or failed runs. Pass a summary with this shape:

```json
{
  "status": "complete",
  "reviewers": [
    {
      "reviewerId": "sol-1",
      "launchMechanism": "native",
      "sessionId": "opaque-session-id",
      "modelRequested": "gpt-5.6-sol",
      "modelApplied": "gpt-5.6-sol",
      "reasoningRequested": "high",
      "reasoningApplied": "high",
      "continuityVerified": true,
      "continuityChecks": [
        {
          "round": 1,
          "verified": true,
          "tokenUsage": null
        }
      ],
      "rounds": [
        {
          "phase": "initial",
          "round": 1,
          "findingIds": ["F1"],
          "tokenUsage": null
        }
      ]
    }
  ],
  "findings": [
    {
      "findingId": "F1",
      "classification": "valid",
      "reportedBy": ["sol-1"],
      "action": "fixed"
    }
  ],
  "githubReviewBots": [{ "login": "claude[bot]", "model": null, "findingIds": ["B1"] }],
  "reviewBotLoopCount": 1
}
```

Include one reviewer object for every configured reviewer, even when it found no issues. Preserve applied model and reasoning fields so comparisons and labels reflect what actually ran rather than what was merely requested; leave an unavailable `modelApplied` or `reasoningApplied` unset so the helper reports it as `unknown`. Record every continuity attempt in `continuityChecks`, including retries and `tokenUsage: null` when the runtime exposes no accounting.

The helper merges this summary with the run's reviewer events before collecting usage. It rejects a
summary that lacks a recorded reviewer round or continuity check, rather than rendering a
plausible-looking table with placeholder reviewers. Fix the missing event or session metadata and
rerun `finish`; never substitute a guessed token count.

```bash
node scripts/review-run-log.mjs finish \
  --log "$REVIEW_RUN_LOG" \
  --collect-codex-usage \
  --data-file .context/review-run-summary.json
```

For native Codex reviewers, `--collect-codex-usage` deterministically discovers the cohort under `${CODEX_HOME:-~/.codex}/sessions`, matches the run window, repository root, parent thread, and reviewer IDs, verifies that each session's completed task count equals its recorded review-plus-continuity invocation count, and copies the final cumulative `token_count` values into the finished log. It refuses ambiguous cohorts or mismatched invocation counts instead of guessing. Record exact session IDs in the summary whenever the runtime exposes them; they further constrain discovery.

The helper derives reviewer session and invocation counts, continuity-invocation counts, rounds per reviewer, initial and cumulative unique findings, pairwise shared/unique finding IDs with Jaccard overlap, reviewers that found issues, GitHub bot counts, and token totals with per-field coverage. Invocation and cumulative token metrics include both review rounds and continuity checks; initial token metrics remain limited to the initial review pass. The helper also groups reviewers only by applied model and derives initial finding classifications, valid and model-unique valid finding IDs, cross-model overlap, per-reviewer usage, and estimated costs.

Cost is an API-equivalent estimate based on the embedded, dated standard-service GPT-5.6 pricing snapshot. The helper prices `cachedInputTokens` as cache reads, prices the remaining input as uncached, and prices all output tokens at the output rate; reasoning tokens are already included in output and are not added again. It returns `null` rather than estimating when the applied model or any required token field is missing. The estimate is not an invoice: Codex plan billing may differ, cache-write premiums cannot be identified from the aggregate counters, and long-context or non-standard service-tier premiums are excluded. Cite the pricing date and source in the final report.

After `finish`, generate the final usage section deterministically:

```bash
node scripts/review-run-log.mjs report --log "$REVIEW_RUN_LOG" \
  > .context/reviewer-usage-report.md
```

Append `.context/reviewer-usage-report.md` verbatim as the final section of the user-facing workflow summary. Do not manually recompute, reorder, or reformat its values. The command renders this exact Markdown column order, with `Estimated cost` immediately after `Total`:

```markdown
| Reviewer | Input | Cached input | Output | Reasoning | Total | Estimated cost |
|---|---:|---:|---:|---:|---:|---:|
| Sol1 (high) | 100,000 | 90,000 | 2,000 | 1,200 | 102,000 | $0.1550 |
```

The generated table uses `n/a` for unavailable usage or estimates. If collection is unavailable, report the helper's reason before the final generated section, but do not have the parent model parse rollout files or invent replacement values. Preserve the raw reviewer/round/continuity/finding arrays so future analyses can compute different metrics without changing old logs. Treat these metrics as observations from one run, not a general model ranking.

If logging fails, do not hide the failure or fabricate a record. Report it, but do not let telemetry failure cause unsafe Git, PR, or code mutations.
