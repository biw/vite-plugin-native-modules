# Event Schema

Use one canonical shape for durable operation outcomes. Extend it per domain, but do not change the meaning of the base fields between features.

## Required Fields

- `operation_name`
  Stable identifier such as `update.check`, `audio.start_microphone`, `timelapse.ocr.process_file`.
- `operation_type`
  Short category such as `http_request`, `trpc_mutation`, `trpc_query`, `ipc_command`, `background_job`, `startup_step`, `queue_consumer`.
- `operation_id`
  Unique ID for this execution.
- `started_at`
  ISO timestamp for entry.
- `completed_at`
  ISO timestamp for completion.
- `duration_ms`
  Integer duration in milliseconds.
- `success`
  Boolean success outcome.
- `error_code`
  Stable machine-queryable code. Use `null` on success.
- `retry_count`
  Integer retry count for this execution.
- `environment`
  `development`, `preview`, `production`, or repo-specific equivalent.
- `app_version`
  Version or release identifier visible to operators.
- `git_commit`
  Commit hash or build revision if available.

## Strongly Recommended Fields

- `correlation_id`
  Request ID, trace ID, job ID, or similar cross-hop identifier.
- `session_id`
  User or app session identifier when available.
- `actor`
  Small object describing the initiator. Example: `{ type: 'user', id_hash: '...' }`.
- `resource`
  Small object describing the target. Example: `{ type: 'timelapse_file', id: 'file_123' }`.
- `trigger`
  `manual`, `startup`, `background`, `retry`, `auto`, or runtime-specific equivalent.
- `status_code`
  HTTP status, native return code, or domain status when meaningful.
- `rollout`
  Feature flags, worker version, deployment channel, experiment bucket.
- `metrics`
  Small numeric bag for domain metrics such as `queue_wait_ms`, `bytes_written`, `candidate_frames`.

## Error Guidance

- Keep `error_code` stable and enumerable.
- Keep `error_message` short and redacted. Use it for operator context, not parsing.
- Prefer this pattern:

```json
{
  "success": false,
  "error_code": "update_feed_http_404",
  "error_message": "Update feed returned 404",
  "retry_count": 1
}
```

- Avoid this pattern:

```json
{
  "success": false,
  "error_message": "Request to https://secret.example.com/token?key=... failed with weird stack trace..."
}
```

## Redaction Rules

- Do not store raw secrets, tokens, cookies, refresh tokens, or authorization headers.
- Hash or omit user identifiers unless exact IDs are essential for local-only debugging.
- Avoid full URLs when path or host is enough.
- Avoid raw prompts or user content unless the product explicitly depends on querying them and privacy allows it.
- Persist pointers to large payloads rather than embedding blobs in the outcome event.

## Example Event

```json
{
  "operation_name": "update.check",
  "operation_type": "ipc_command",
  "operation_id": "op_01JY...",
  "started_at": "2026-04-13T18:11:02.120Z",
  "completed_at": "2026-04-13T18:11:03.406Z",
  "duration_ms": 1286,
  "success": false,
  "error_code": "update_feed_http_404",
  "error_message": "Update feed returned 404",
  "retry_count": 0,
  "environment": "production",
  "app_version": "2.4.1",
  "git_commit": "abc1234",
  "correlation_id": "req_8bf7ec2d",
  "session_id": "sess_01JY...",
  "trigger": "manual",
  "status_code": 404,
  "actor": {
    "type": "user"
  },
  "resource": {
    "type": "updater"
  },
  "rollout": {
    "channel": "stable"
  },
  "metrics": {
    "queue_wait_ms": 0
  }
}
```

## Naming Rules

- Use snake_case or camelCase consistently within a repo. Do not mix styles within one event family.
- A good default is camelCase in TypeScript types and snake_case in persisted rows or JSON payloads. Convert once at the storage boundary and keep each layer internally consistent.
- Keep `operation_name` verb-first and specific.
- Reuse the same `error_code` vocabulary across features when the same failure class appears in multiple places.
