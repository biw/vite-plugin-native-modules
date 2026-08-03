import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendEvent,
  canonicalSummaryFromEvents,
  finishRun,
  startRun,
  validateFinishSummary,
} from './review-run-log.mjs'

const reviewerStart = (reviewerId, model) => ({
  event: 'reviewer_session_started',
  data: {
    launchMechanism: 'native',
    modelApplied: model,
    modelRequested: model,
    reasoningApplied: 'high',
    reasoningRequested: 'high',
    reviewerId,
    sessionId: `/root/${reviewerId.replace('-', '_')}`,
  },
})

test('reconstructs canonical reviewer records from the append-only event ledger', () => {
  const events = [
    reviewerStart('sol-1', 'gpt-5.6-sol'),
    reviewerStart('terra-1', 'gpt-5.6-terra'),
    reviewerStart('luna-1', 'gpt-5.6-luna'),
    {
      event: 'reviewer_pass_completed',
      data: { finding_ids: ['F1'], reviewer: 'sol-1', round: 1 },
    },
    {
      event: 'remediation_reviewer_pass_completed',
      data: { findingIds: [], reviewerId: 'sol-1', round: 1 },
    },
    {
      event: 'reviewer_continuity_verified',
      data: { reviewer: 'sol-1', round: 1 },
    },
  ]
  const summary = {
    reviewers: [
      { id: 'sol-1', model: 'gpt-5.6-sol', reasoning: 'high' },
      { id: 'terra-1', model: 'gpt-5.6-terra', reasoning: 'high' },
      { id: 'luna-1', model: 'gpt-5.6-luna', reasoning: 'high' },
    ],
  }

  const canonical = canonicalSummaryFromEvents(events, summary)
  const sol = canonical.reviewers.find((reviewer) => reviewer.reviewerId === 'sol-1')

  assert.deepEqual(sol?.rounds, [
    { findingIds: ['F1'], phase: 'initial', round: 1, tokenUsage: null },
    { findingIds: [], phase: 'remediation', round: 1, tokenUsage: null },
  ])
  assert.deepEqual(sol?.continuityChecks, [{ round: 1, tokenUsage: null, verified: true }])
  assert.equal(sol?.modelApplied, 'gpt-5.6-sol')
  assert.equal(sol?.reasoningApplied, 'high')

  assert.throws(() => validateFinishSummary(canonical), /has no recorded review rounds/)
})

test('collectCodexUsage enriches the ledger-canonicalized reviewer records', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-run-log-'))
  const repoRoot = process.cwd()
  const startedAt = '2026-07-23T12:00:00.000Z'
  const reviewerIds = ['sol-1', 'terra-1', 'luna-1']

  try {
    const { logPath } = startRun({ outputRoot: root, repoRoot, timestamp: startedAt, runId: 'usage-regression' })
    for (const reviewerId of reviewerIds) {
      appendEvent({ logPath, ...reviewerStart(reviewerId, `gpt-5.6-${reviewerId.split('-')[0]}`), timestamp: startedAt })
      appendEvent({
        logPath,
        event: 'reviewer_pass_completed',
        data: { findingIds: [], reviewerId, round: 1 },
        timestamp: startedAt,
      })
      appendEvent({
        logPath,
        event: 'reviewer_continuity_verified',
        data: { reviewerId, round: 1 },
        timestamp: startedAt,
      })
    }

    const sessionsRoot = join(root, 'sessions')
    const sessionDirectory = join(sessionsRoot, '2026', '07', '23')
    mkdirSync(sessionDirectory, { recursive: true })
    for (const reviewerId of reviewerIds) {
      const sessionId = `/root/${reviewerId.replace('-', '_')}`
      const records = [
        {
          type: 'session_meta',
          payload: {
            cwd: repoRoot,
            id: sessionId,
            source: { subagent: { thread_spawn: { agent_path: sessionId, parent_thread_id: 'parent-run' } } },
            timestamp: startedAt,
          },
        },
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_complete' } },
        { type: 'event_msg', payload: { type: 'task_complete' } },
        {
          type: 'event_msg',
          payload: {
            info: {
              total_token_usage: {
                cached_input_tokens: 10,
                input_tokens: 20,
                output_tokens: 30,
                reasoning_output_tokens: 5,
                total_tokens: 55,
              },
            },
            type: 'token_count',
          },
        },
      ]
      writeFileSync(
        join(sessionDirectory, `${reviewerId}.jsonl`),
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      )
    }

    const record = finishRun({
      collectCodexUsage: true,
      logPath,
      sessionsRoot,
      summary: {
        reviewers: reviewerIds.map((id) => ({ id, model: `gpt-5.6-${id.split('-')[0]}`, reasoning: 'high' })),
      },
      timestamp: '2026-07-23T12:01:00.000Z',
    })

    assert.equal(record.data.tokenUsageCollection.status, 'complete')
    assert.equal(record.data.derived.reviewerInvocationCount, 6)
    assert.deepEqual(
      record.data.reviewers.map((reviewer) => reviewer.reviewerId),
      [...reviewerIds].sort(),
    )
    assert.ok(record.data.reviewers.every((reviewer) => reviewer.sessionTokenUsage?.totalTokens === 55))
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
