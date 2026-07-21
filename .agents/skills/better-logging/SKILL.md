---
name: better-logging
description: Design durable, queryable operation outcome events for HTTP, IPC, tRPC, jobs, startup flows, and queues so failures and latency are easy to investigate.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Better Logging

Turn important operations into durable structured records that answer "what happened?" with one query instead of a trail of log lines.

Treat the unit of instrumentation as an operation owned by the runtime, not as individual log statements sprinkled through the codebase.

## Quick Start

- Run the audit script first:

```bash
python3 scripts/audit_queryable_outcomes.py \
  --root . \
  --format markdown
```

Run the bundled `scripts/audit_queryable_outcomes.py` from this skill directory. If needed, resolve the directory containing this `SKILL.md` and pass the script path explicitly.

- Read exactly one runtime reference before changing code:
  - Electron, tRPC, IPC, background desktop jobs: `references/runtime-patterns-electron.md`
  - Node HTTP apps and workers: `references/runtime-patterns-node.md`
- Use `references/event-schema.md` to define the canonical event shape before writing middleware or wrappers.
- Instrument the top 3 user-critical operations first. Do not start with every route or command in the repo.

## Workflow

1. Inventory operation boundaries.
   Transport boundaries usually matter most: HTTP handlers, tRPC procedures, IPC commands, queue consumers, cron jobs, startup flows.
   Treat low-level helper functions as enrichment points, not as the canonical operation.
2. Choose the operation record shape.
   Read `references/event-schema.md`.
   Lock required fields first: operation name, type, timestamps, duration, success, stable error code, correlation ID, version metadata.
3. Add one wrapper at the boundary.
   Start the record at entry.
   Enrich while the operation runs.
   Finalize and persist in `finally` so success and failure paths both emit an outcome.
4. Add domain context that improves debugging.
   Include actor, resource, trigger, rollout flags, retry count, and version data when available.
   Omit fields that are only interesting for local debugging or that contain secrets.
5. Persist or emit the result durably.
   Prefer a local table, operational event store, or queryable analytics sink.
   Do not rely on ephemeral console logs or in-memory buffers for critical outcomes.
6. Verify with real questions.
   Read `references/rollout-and-queries.md`.
   If the new shape cannot answer failure, latency, and regression questions quickly, the instrumentation is still too thin.

## Runtime Selection

- Electron desktop app:
  Read `references/runtime-patterns-electron.md` for tRPC mutations, `ipcMain.handle`, startup actions, and background jobs.
- Node server or worker:
  Read `references/runtime-patterns-node.md` for Express, Fastify, Hono-style handlers, queues, and cron jobs.

## Guardrails

- Prefer one durable outcome event per important operation over many scattered log lines.
- Keep `error_code` stable and machine-queryable. Treat free-form messages as secondary.
- Record durations and retry counts on every critical operation.
- Add correlation fields early. A missing `request_id`, `operation_id`, or `session_id` weakens every downstream query.
- Separate operational truth from product analytics. Mirroring is fine; substitution is not.
- Redact or hash secrets, tokens, raw prompts, user content, and full URLs when they are not strictly required.
- Do not emit giant blobs by default. Persist pointers or summarized context instead.

## Resources

- `scripts/audit_queryable_outcomes.py`
  Scan a repo for likely operation boundaries, existing instrumentation, correlation fields, and durable outcome signals.
- `references/event-schema.md`
  Required and recommended fields, naming guidance, and redaction rules.
- `references/runtime-patterns-electron.md`
  Boundary choices and wrapper patterns for Electron, tRPC, IPC, startup flows, and background jobs.
- `references/runtime-patterns-node.md`
  Boundary choices and wrapper patterns for HTTP apps, queue consumers, and cron jobs.
- `references/rollout-and-queries.md`
  Retrofit plan, acceptance checklist, and example questions the new instrumentation must answer.
