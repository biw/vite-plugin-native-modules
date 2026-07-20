# Electron Patterns

Use the desktop runtime's real operation boundaries, not web assumptions.

## Good Units of Instrumentation

- tRPC mutations and important queries
- `ipcMain.handle` commands
- startup and shutdown steps
- background job ticks
- queue or worker executions
- native operation wrappers with meaningful success or failure outcomes

## Prefer a Boundary Wrapper

Wrap the entrypoint once, enrich inside the operation, and finalize in `finally`.

```ts
type OperationOutcome = {
  appVersion: string
  actor?: { idHash?: string | undefined; type: string } | undefined
  completedAt?: string | undefined
  correlationId?: string | undefined
  durationMs?: number | undefined
  environment: 'development' | 'preview' | 'production'
  errorCode?: null | string | undefined
  errorMessage?: null | string | undefined
  gitCommit?: string | undefined
  metrics?: Record<string, number> | undefined
  operationId: string
  operationName: string
  operationType:
    | 'ipc_command'
    | 'trpc_mutation'
    | 'trpc_query'
    | 'background_job'
    | 'startup_step'
    | 'queue_consumer'
  resource?: { id?: string | undefined; type: string } | undefined
  retryCount: number
  rollout?: Record<string, boolean | number | string> | undefined
  sessionId?: string | undefined
  startedAt: string
  statusCode?: number | undefined
  success: boolean
  trigger?: 'manual' | 'startup' | 'background' | 'retry' | 'auto' | undefined
}

type OperationOutcomeSeed = Omit<
  OperationOutcome,
  | 'completedAt'
  | 'durationMs'
  | 'errorCode'
  | 'errorMessage'
  | 'operationId'
  | 'startedAt'
  | 'success'
>

// Put these helpers in one shared file such as src/backend/lib/outcome.ts.
const classifyError = (error: unknown): string => {
  // Classify domain errors before they reach this function.
  // Returning error.name is a last-resort fallback; prefer stable codes
  // like "update_feed_http_404" at the call site when possible.
  return error instanceof Error ? error.name : 'unknown_error'
}

const formatErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : 'Unknown error'
}

// Keep camelCase in memory and map to storage casing at the persistence boundary.
const toStoredOutcome = (outcome: OperationOutcome) => ({
  app_version: outcome.appVersion,
  completed_at: outcome.completedAt,
  correlation_id: outcome.correlationId,
  duration_ms: outcome.durationMs,
  environment: outcome.environment,
  error_code: outcome.errorCode,
  error_message: outcome.errorMessage,
  git_commit: outcome.gitCommit,
  metrics: outcome.metrics,
  operation_id: outcome.operationId,
  operation_name: outcome.operationName,
  operation_type: outcome.operationType,
  resource: outcome.resource,
  retry_count: outcome.retryCount,
  rollout: outcome.rollout,
  session_id: outcome.sessionId,
  started_at: outcome.startedAt,
  status_code: outcome.statusCode,
  success: outcome.success,
  trigger: outcome.trigger,
  actor: outcome.actor,
})

const persistOutcome = async (outcome: OperationOutcome): Promise<void> => {
  // Replace this with a Prisma, SQLite, or analytics-sink write in your app.
  // Example: await prisma.operationOutcome.create({ data: toStoredOutcome(outcome) })
  void outcome
}

const withOutcome = async <T>(
  seed: OperationOutcomeSeed,
  run: (outcome: OperationOutcome) => Promise<T>,
): Promise<T> => {
  const startMs = Date.now()
  const outcome: OperationOutcome = {
    ...seed,
    operationId: crypto.randomUUID(),
    startedAt: new Date(startMs).toISOString(),
    errorCode: null,
    success: false,
  }

  try {
    const result = await run(outcome)
    outcome.success = true
    return result
  } catch (error) {
    outcome.errorCode = classifyError(error)
    outcome.errorMessage = formatErrorMessage(error)
    throw error
  } finally {
    outcome.completedAt = new Date().toISOString()
    outcome.durationMs = Date.now() - startMs
    await persistOutcome(outcome).catch((persistError: unknown) => {
      console.error('[outcome] failed to persist outcome', persistError)
    })
  }
}
```

If your store supports camelCase cleanly, standardize on camelCase end-to-end instead of mapping. The important rule is one casing per layer, not a forced snake_case database.

## tRPC

- Instrument procedure entry, not only inner helpers.
- Use procedure metadata or naming conventions to derive `operation_name`.
- Include renderer versus backend origin when the distinction matters.
- If one shared middleware is too disruptive, wrap the top 3 mutations manually first.
- Use `trpc_query` when an important query needs the same durable outcome treatment.

Suggested names:

- `update.check`
- `audio.start_microphone`
- `audio.start_application`
- `tracking.pause`

## IPC

- Treat each `ipcMain.handle` as a command boundary.
- Persist the outcome even if the handler returns a serializable error object instead of throwing.
- Include native status codes and endpoint details in redacted form when relevant.

## Background Jobs

- Emit one event per job execution, not one per log line.
- Include `job_name`, `job_id`, `attempt`, `queue_wait_ms`, and `worker_version` when available.
- Persist child metrics separately only when they are genuinely high volume. Keep one parent outcome event per execution.

## Startup Flows

- Treat app-ready orchestration as a sequence of named startup steps.
- Instrument steps like `db.initialize`, `auth.restore_session`, `background_services.start`, `window.create_main`.
- Startup instrumentation is often the fastest route to explaining "works locally, fails on launch."

## Persistence Choices

Prefer one of these:

- local SQLite table for durable local debugging
- existing operational events table if one already exists
- analytics sink only if it supports real querying and privacy is acceptable

Avoid:

- only `electron-log`
- only in-memory ring buffers
- only product analytics events with thin schemas

## Migration Order

1. Instrument user-visible failures first.
2. Instrument update, auth, and media start/stop flows next.
3. Instrument background jobs after the foreground flows are queryable.
