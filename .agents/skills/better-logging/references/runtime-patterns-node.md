# Node Patterns

Use this reference for HTTP services, webhooks, queue consumers, and cron jobs.

## HTTP Handlers

Instrument one outcome per request or per important handler.

```ts
type OperationOutcome = {
  appVersion: string
  actor?: { idHash?: string | undefined; type: string } | undefined
  completedAt?: string | undefined
  correlationId?: string | undefined
  durationMs?: number | undefined
  environment: 'development' | 'preview' | 'production' | string
  errorCode?: null | string | undefined
  errorMessage?: null | string | undefined
  gitCommit?: string | undefined
  metrics?: Record<string, number> | undefined
  operationId: string
  operationName: string
  operationType: 'http_request' | 'queue_consumer' | 'cron_run'
  resource?: { id?: string | undefined; type: string } | undefined
  retryCount: number
  rollout?: Record<string, boolean | number | string> | undefined
  sessionId?: string | undefined
  startedAt: string
  statusCode?: number | undefined
  success: boolean
  trigger?: 'manual' | 'startup' | 'background' | 'retry' | 'auto' | undefined
}

const startOutcome = (
  startMs: number,
  seed: Omit<
    OperationOutcome,
    | 'completedAt'
    | 'durationMs'
    | 'errorCode'
    | 'errorMessage'
    | 'operationId'
    | 'startedAt'
    | 'statusCode'
    | 'success'
  >,
): OperationOutcome => ({
  ...seed,
  errorCode: null,
  operationId: crypto.randomUUID(),
  startedAt: new Date(startMs).toISOString(),
  success: false,
})

const classifyError = (error: unknown): string => {
  // Classify domain errors before they reach this function.
  // Returning error.name is a last-resort fallback; prefer stable codes
  // like "checkout_card_declined" at the call site when possible.
  return error instanceof Error ? error.name : 'unknown_error'
}

const formatErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : 'Unknown error'
}

const inferStatusCode = (error: unknown): number => {
  return error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : 500
}

// Put these helpers in a shared file such as src/lib/outcome.ts.
const persistOutcome = async (outcome: OperationOutcome): Promise<void> => {
  void outcome
  // Replace this with your real DB or analytics write.
}

app.post('/checkout', async (req, res, next) => {
  const startMs = Date.now()
  const requestId = req.headers['x-request-id']
  const outcome = startOutcome(startMs, {
    appVersion: process.env.APP_VERSION ?? 'dev',
    correlationId: Array.isArray(requestId) ? requestId[0] : requestId,
    environment: process.env.NODE_ENV ?? 'development',
    operationName: 'checkout.submit',
    operationType: 'http_request',
    retryCount: 0,
    trigger: 'manual',
  })

  try {
    const result = await runCheckout(req, outcome)
    outcome.success = true
    outcome.statusCode = 200
    res.json(result)
  } catch (error) {
    outcome.success = false
    outcome.errorCode = classifyError(error)
    outcome.errorMessage = formatErrorMessage(error)
    outcome.statusCode = inferStatusCode(error)
    next(error)
  } finally {
    outcome.completedAt = new Date().toISOString()
    outcome.durationMs = Date.now() - startMs
    await persistOutcome(outcome).catch((persistError: unknown) => {
      console.error('[outcome] failed to persist outcome', persistError)
    })
  }
})
```

## Queues and Workers

- Use one event per consumed message or job execution.
- Include `job_id`, `attempt`, `queue`, `worker_version`, and `dedupe_key` when available.
- Distinguish handler failure from downstream dependency failure in `error_code`.

## Cron and Scheduled Tasks

- Emit one outcome per run.
- Include the schedule, selected time window, and counts of processed items.
- Record "no work found" as a successful outcome when it is expected behavior.

## Tracing

- Keep distributed tracing if the service already uses it.
- Treat traces and queryable outcomes as complementary:
  traces show flow;
  outcomes show the business-relevant result of each operation.

## Storage

Prefer:

- Postgres or SQLite table for local or service-owned operations
- ClickHouse, BigQuery, or similar columnar store for high-volume fleets
- log/analytics sink only if it can query structured fields with acceptable latency and cost

Avoid:

- plain-text grep as the primary operator workflow
- storing only free-form messages
