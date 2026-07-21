# Rollout And Queries

## Retrofit Plan

1. Pick the top 3 critical operations.
2. Define the shared base schema before adding more fields.
3. Add wrappers at the operation boundary.
4. Add only the domain fields that help answer real debugging questions.
5. Verify with queries before expanding rollout.
6. Expand to background jobs, startup steps, and lower-priority paths.

## Acceptance Checklist

- Every critical operation has a stable `operation_name`.
- Every critical operation records `duration_ms`.
- Failures have stable `error_code` values.
- At least one correlation field exists.
- Operators can answer "what failed?", "how often?", "for whom?", and "since which release?" without reading raw logs first.
- The event shape is privacy-safe by default.

## Questions The Instrumentation Must Answer

- Which operations are failing most often by `error_code`?
- Which failures started after version `X` or commit `Y`?
- Which operations exceed the latency budget?
- Which retries eventually succeed, and how many attempts do they take?
- Which background jobs fail only on a specific worker version or rollout flag?
- Which user-visible commands fail only in production or only on startup?

## Example Queries

These examples use SQLite-style date and JSON syntax. Adapt the functions and JSON operators if your backing store is Postgres, ClickHouse, BigQuery, or another warehouse.

### Failed outcomes by code

```sql
SELECT operation_name, error_code, COUNT(*) AS failures
FROM operation_outcomes
WHERE success = 0
GROUP BY operation_name, error_code
ORDER BY failures DESC;
```

### Slow outcomes by release

```sql
SELECT app_version, operation_name, AVG(duration_ms) AS avg_duration_ms
FROM operation_outcomes
WHERE completed_at >= datetime('now', '-7 days')
GROUP BY app_version, operation_name
ORDER BY avg_duration_ms DESC;
```

### Regressions after a rollout

```sql
SELECT json_extract(rollout, '$.channel') AS rollout_channel, error_code, COUNT(*) AS failures
FROM operation_outcomes
WHERE operation_name = 'update.check'
  AND completed_at >= datetime('now', '-1 day')
GROUP BY json_extract(rollout, '$.channel'), error_code
ORDER BY failures DESC;
```

If your table flattens rollout fields into separate columns, prefer `rollout_channel` over JSON extraction.

## Anti-Patterns

- Starting with 50 fields before proving the first 10 are useful
- Logging full payloads because they might help someday
- Using free-form messages as the primary query dimension
- Treating product analytics events as a complete replacement for operational outcomes
