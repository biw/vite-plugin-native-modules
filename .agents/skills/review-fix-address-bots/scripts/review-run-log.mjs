#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 1

export const PRICING_SNAPSHOT = Object.freeze({
  currency: 'USD',
  serviceTier: 'standard',
  effectiveDate: '2026-07-09',
  source: 'https://openai.com/index/gpt-5-6/',
  cachedInputDiscount: 0.9,
  ratesPerMillionTokens: Object.freeze({
    'gpt-5.6-sol': Object.freeze({ input: 5, cachedInput: 0.5, output: 30 }),
    'gpt-5.6-terra': Object.freeze({ input: 2.5, cachedInput: 0.25, output: 15 }),
    'gpt-5.6-luna': Object.freeze({ input: 1, cachedInput: 0.1, output: 6 }),
  }),
  limitations: Object.freeze([
    'API-equivalent estimate; Codex plan billing may differ.',
    'Treats cachedInputTokens as cache reads and cannot identify cache-write premiums.',
    'Excludes long-context and non-standard service-tier premiums.',
  ]),
})

const scriptPath = fileURLToPath(import.meta.url)
const skillRoot = dirname(dirname(scriptPath))

const fail = (message) => {
  throw new Error(message)
}

const expandHome = (value) => {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

const isoTimestamp = (value) => {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) fail(`Invalid timestamp: ${value}`)
  return date.toISOString()
}

const runGit = (repoRoot, args) => {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return result.status === 0 ? result.stdout.trim() : undefined
}

export const sanitizeRemote = (remote, fallback) => {
  if (!remote) return fallback

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      const url = new URL(remote)
      const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
      return [url.hostname, path].filter(Boolean).join('/') || fallback
    } catch {
      return fallback
    }
  }

  const scp = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/)
  if (scp) return `${scp[1]}/${scp[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}`

  return fallback
}

const discoverRepo = (requestedRoot) => {
  const candidate = resolve(expandHome(requestedRoot || process.cwd()))
  const root = runGit(candidate, ['rev-parse', '--show-toplevel']) || candidate
  const remotes = (runGit(root, ['remote']) || '').split('\n').filter(Boolean)
  const remoteName = remotes.includes('origin') ? 'origin' : remotes[0]
  const remote = remoteName ? runGit(root, ['remote', 'get-url', remoteName]) : undefined

  return {
    key: sanitizeRemote(remote, basename(root)),
    root,
    remoteName: remoteName || null,
  }
}

const discoverGitState = (repoRoot) => ({
  branch: runGit(repoRoot, ['branch', '--show-current']) || null,
  head: runGit(repoRoot, ['rev-parse', 'HEAD']) || null,
})

const skillFingerprint = () => {
  const hash = createHash('sha256')
  for (const relativePath of [
    'SKILL.md',
    'references/review-guidelines.md',
    'references/run-logging.md',
    'references/reviewer-sessions.md',
    'scripts/review-run-log.mjs',
  ]) {
    hash.update(relativePath)
    hash.update('\0')
    hash.update(readFileSync(join(skillRoot, relativePath)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const assertObject = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object`)
  }
  return value
}

const readEvents = (logPath) => {
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
  if (lines.length === 0) fail(`Run log is empty: ${logPath}`)
  return lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      fail(`Invalid JSON on line ${index + 1} of ${logPath}: ${error.message}`)
    }
  })
}

const runIdentity = (logPath) => {
  const events = readEvents(logPath)
  const first = events[0]
  if (first.event !== 'run_started' || !first.runId) fail(`Missing run_started header: ${logPath}`)
  return { events, runId: first.runId }
}

const tokenUsageFromCodex = (usage) =>
  usage
    ? {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.cached_input_tokens,
        outputTokens: usage.output_tokens,
        reasoningOutputTokens: usage.reasoning_output_tokens,
        totalTokens: usage.total_tokens,
      }
    : null

const readFirstJsonLine = (path) => {
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(2 * 1024 * 1024)
    const length = readSync(descriptor, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, length).toString('utf8')
    const newline = text.indexOf('\n')
    if (newline === -1) return null
    return JSON.parse(text.slice(0, newline))
  } catch {
    return null
  } finally {
    closeSync(descriptor)
  }
}

const sessionFilesForWindow = (sessionsRoot, startedAt, endedAt) => {
  const files = []
  const start = new Date(startedAt)
  const end = new Date(endedAt)
  start.setUTCDate(start.getUTCDate() - 1)
  end.setUTCDate(end.getUTCDate() + 1)

  for (let date = start; date <= end; date = new Date(date.getTime() + 86_400_000)) {
    const directory = join(
      sessionsRoot,
      String(date.getUTCFullYear()).padStart(4, '0'),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    )
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(directory, entry.name))
    }
  }
  return files
}

const codexSessionUsage = (path) => {
  let totalTokenUsage = null
  let invocationCount = 0
  let completedInvocationCount = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type !== 'event_msg') continue
    if (record.payload?.type === 'task_started') invocationCount += 1
    if (record.payload?.type === 'task_complete') completedInvocationCount += 1
    if (record.payload?.type === 'token_count' && record.payload.info?.total_token_usage) {
      totalTokenUsage = record.payload.info.total_token_usage
    }
  }
  return {
    invocationCount,
    completedInvocationCount,
    tokenUsage: tokenUsageFromCodex(totalTokenUsage),
  }
}

const expectedAgentName = (reviewerId) => reviewerId.replaceAll('-', '_')

export const collectCodexSessionUsage = (
  summary,
  {
    sessionsRoot = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
    startedAt,
    endedAt = new Date().toISOString(),
    repoRoot,
  } = {},
) => {
  assertObject(summary, 'summary')
  const reviewers = Array.isArray(summary.reviewers) ? summary.reviewers : []
  if (!startedAt || !repoRoot || reviewers.length === 0) {
    return {
      summary,
      collection: { status: 'unavailable', reason: 'startedAt, repoRoot, and reviewers are required' },
    }
  }

  const startTime = new Date(startedAt).getTime()
  const endTime = new Date(endedAt).getTime()
  const reviewerNames = new Set(reviewers.map((reviewer, index) => expectedAgentName(reviewer.reviewerId || `reviewer-${index + 1}`)))
  const candidates = sessionFilesForWindow(resolve(expandHome(sessionsRoot)), startedAt, endedAt)
    .map((path) => ({ path, record: readFirstJsonLine(path) }))
    .filter(({ record }) => record?.type === 'session_meta' && record.payload?.source?.subagent?.thread_spawn)
    .map(({ path, record }) => {
      const payload = record.payload
      const spawn = payload.source.subagent.thread_spawn
      return {
        path,
        sessionId: payload.id || null,
        parentThreadId: spawn.parent_thread_id || payload.parent_thread_id || null,
        agentPath: spawn.agent_path || payload.agent_path || '',
        agentName: basename(spawn.agent_path || payload.agent_path || ''),
        cwd: payload.cwd,
        timestamp: payload.timestamp || record.timestamp,
      }
    })
    .filter((candidate) => {
      const timestamp = new Date(candidate.timestamp).getTime()
      return (
        reviewerNames.has(candidate.agentName) &&
        resolve(candidate.cwd || '/') === resolve(repoRoot) &&
        timestamp >= startTime &&
        timestamp <= endTime
      )
    })

  const groups = new Map()
  for (const candidate of candidates) {
    if (!groups.has(candidate.parentThreadId)) groups.set(candidate.parentThreadId, [])
    groups.get(candidate.parentThreadId).push(candidate)
  }

  const matchingGroups = [...groups.entries()].filter(([, group]) =>
    reviewers.every((reviewer, index) => {
      const reviewerId = reviewer.reviewerId || `reviewer-${index + 1}`
      const exactSessionId = reviewer.sessionId || reviewer.sessionIdentifier
      const matches = group.filter(
        (candidate) =>
          candidate.agentName === expectedAgentName(reviewerId) &&
          (!exactSessionId || candidate.sessionId === exactSessionId || candidate.agentPath === exactSessionId),
      )
      return matches.length === 1
    }),
  )

  if (matchingGroups.length !== 1) {
    return {
      summary,
      collection: {
        status: 'unavailable',
        reason:
          matchingGroups.length === 0
            ? 'no unambiguous reviewer session cohort matched the run'
            : 'multiple reviewer session cohorts matched the run',
        candidateGroupCount: matchingGroups.length,
      },
    }
  }

  const [parentThreadId, group] = matchingGroups[0]
  const collected = []
  const enrichedReviewers = reviewers.map((reviewer, index) => {
    const reviewerId = reviewer.reviewerId || `reviewer-${index + 1}`
    const exactSessionId = reviewer.sessionId || reviewer.sessionIdentifier
    const candidate = group.find(
      (entry) =>
        entry.agentName === expectedAgentName(reviewerId) &&
        (!exactSessionId || entry.sessionId === exactSessionId || entry.agentPath === exactSessionId),
    )
    const usage = codexSessionUsage(candidate.path)
    const expectedInvocationCount = invocationsFor(reviewer).length
    const valid =
      usage.tokenUsage &&
      usage.invocationCount === expectedInvocationCount &&
      usage.completedInvocationCount === expectedInvocationCount
    collected.push({
      reviewerId,
      sessionId: candidate.sessionId,
      expectedInvocationCount,
      observedInvocationCount: usage.invocationCount,
      completedInvocationCount: usage.completedInvocationCount,
      collected: Boolean(valid),
    })
    return valid
      ? {
          ...reviewer,
          sessionId: candidate.sessionId,
          sessionTokenUsage: usage.tokenUsage,
          sessionTokenUsageSource: 'codex_rollout_token_count',
        }
      : reviewer
  })

  const collectedCount = collected.filter((reviewer) => reviewer.collected).length
  return {
    summary: { ...summary, reviewers: enrichedReviewers },
    collection: {
      status: collectedCount === reviewers.length ? 'complete' : 'partial',
      parentThreadId,
      reviewerCount: reviewers.length,
      collectedCount,
      reviewers: collected,
    },
  }
}

export const startRun = ({
  repoRoot,
  outputRoot,
  configuration = {},
  timestamp,
  runId = randomUUID(),
} = {}) => {
  assertObject(configuration, 'configuration')
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) fail('runId may contain only letters, numbers, dots, underscores, and hyphens')

  const createdAt = isoTimestamp(timestamp)
  const date = new Date(createdAt)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const root = resolve(
    expandHome(outputRoot || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'log', 'review-fix-address-bots')),
  )
  const directory = join(root, year, month, day)
  const filenameTimestamp = createdAt.replace(/[:.]/g, '-')
  const logPath = join(directory, `review-run-${filenameTimestamp}-${runId}.jsonl`)
  const repo = discoverRepo(repoRoot)

  mkdirSync(directory, { recursive: true })
  writeFileSync(
    logPath,
    `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      runId,
      timestamp: createdAt,
      event: 'run_started',
      skill: {
        name: 'review-fix-address-bots',
        fingerprintSha256: skillFingerprint(),
      },
      repo,
      git: discoverGitState(repo.root),
      configuration,
    })}\n`,
    { encoding: 'utf8', flag: 'wx' },
  )

  return { logPath, runId }
}

export const appendEvent = ({ logPath, event, data = {}, timestamp } = {}) => {
  if (!logPath) fail('logPath is required')
  if (!event || !/^[a-z][a-z0-9_]*$/.test(event)) fail('event must be lower_snake_case')
  if (event === 'run_started' || event === 'run_finished') fail(`Use the dedicated command for ${event}`)
  assertObject(data, 'data')

  const { events, runId } = runIdentity(logPath)
  if (events.some((item) => item.event === 'run_finished')) fail(`Run is already finished: ${logPath}`)
  const record = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    timestamp: isoTimestamp(timestamp),
    event,
    data,
  }
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

const findingIdsFor = (reviewer, phase) => {
  const rounds = Array.isArray(reviewer.rounds) ? reviewer.rounds : []
  const ids = rounds
    .filter((round) => !phase || round.phase === phase)
    .flatMap((round) => (Array.isArray(round.findingIds) ? round.findingIds : []))
    .filter((id) => typeof id === 'string' && id.length > 0)
  return [...new Set(ids)].sort()
}

const overlapFor = (reviewers, phase) => {
  const entries = reviewers.map((reviewer, index) => ({
    reviewerId: reviewer.reviewerId || `reviewer-${index + 1}`,
    findingIds: findingIdsFor(reviewer, phase),
  }))
  const frequency = new Map()
  for (const entry of entries) {
    for (const findingId of entry.findingIds) frequency.set(findingId, (frequency.get(findingId) || 0) + 1)
  }

  const pairs = []
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex]
      const right = entries[rightIndex]
      const leftSet = new Set(left.findingIds)
      const rightSet = new Set(right.findingIds)
      const sharedFindingIds = left.findingIds.filter((id) => rightSet.has(id))
      const onlyLeftFindingIds = left.findingIds.filter((id) => !rightSet.has(id))
      const onlyRightFindingIds = right.findingIds.filter((id) => !leftSet.has(id))
      const unionSize = new Set([...left.findingIds, ...right.findingIds]).size
      pairs.push({
        leftReviewerId: left.reviewerId,
        rightReviewerId: right.reviewerId,
        sharedFindingIds,
        onlyLeftFindingIds,
        onlyRightFindingIds,
        jaccard: unionSize === 0 ? null : Number((sharedFindingIds.length / unionSize).toFixed(4)),
      })
    }
  }

  const uniqueFindingIds = [...frequency.keys()].sort()
  return {
    basis: phase ? `${phase} rounds` : 'all rounds',
    uniqueFindingIds,
    allReviewersSharedFindingIds:
      entries.length === 0
        ? []
        : uniqueFindingIds.filter((findingId) => frequency.get(findingId) === entries.length),
    uniqueByReviewer: entries.map((entry) => ({
      reviewerId: entry.reviewerId,
      findingIds: entry.findingIds.filter((findingId) => frequency.get(findingId) === 1),
    })),
    pairs,
  }
}

const invocationsFor = (reviewer) => {
  const rounds = Array.isArray(reviewer.rounds) ? reviewer.rounds : []
  const continuityChecks = Array.isArray(reviewer.continuityChecks)
    ? reviewer.continuityChecks.map((check) => ({ ...check, phase: 'continuity' }))
    : []
  return [...rounds, ...continuityChecks]
}

const tokenMetrics = (reviewers, phase) => {
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']
  const totals = Object.fromEntries(fields.map((field) => [field, 0]))
  const fieldCoverage = Object.fromEntries(fields.map((field) => [field, 0]))
  let invocationCount = 0
  let invocationsWithUsage = 0

  for (const reviewer of reviewers) {
    for (const round of invocationsFor(reviewer)) {
      if (phase && round.phase !== phase) continue
      invocationCount += 1
      const usage = round.tokenUsage
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
      let foundValue = false
      for (const field of fields) {
        if (typeof usage[field] === 'number' && Number.isFinite(usage[field])) {
          totals[field] += usage[field]
          fieldCoverage[field] += 1
          foundValue = true
        }
      }
      if (foundValue) invocationsWithUsage += 1
    }
  }

  return {
    invocationCount,
    invocationsWithUsage,
    complete: invocationCount > 0 && invocationCount === invocationsWithUsage,
    fieldCoverage,
    totals:
      invocationsWithUsage > 0
        ? Object.fromEntries(fields.filter((field) => fieldCoverage[field] > 0).map((field) => [field, totals[field]]))
        : null,
  }
}

const metricsForSessionUsage = (usage) => {
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']
  const fieldCoverage = Object.fromEntries(fields.map((field) => [field, typeof usage?.[field] === 'number' ? 1 : 0]))
  const totals = Object.fromEntries(fields.filter((field) => fieldCoverage[field]).map((field) => [field, usage[field]]))
  return {
    invocationCount: 1,
    invocationsWithUsage: Object.keys(totals).length > 0 ? 1 : 0,
    complete: fields.every((field) => fieldCoverage[field] === 1),
    fieldCoverage,
    totals: Object.keys(totals).length > 0 ? totals : null,
    source: 'session',
  }
}

export const estimateTokenCost = (model, metrics) => {
  const rates = PRICING_SNAPSHOT.ratesPerMillionTokens[model]
  const totals = metrics?.totals
  if (!rates || !totals || !metrics || metrics.invocationCount === 0) return null

  const requiredFields = ['inputTokens', 'cachedInputTokens', 'outputTokens']
  if (requiredFields.some((field) => metrics.fieldCoverage?.[field] !== metrics.invocationCount)) return null

  const { inputTokens, cachedInputTokens, outputTokens } = totals
  if (
    ![inputTokens, cachedInputTokens, outputTokens].every((value) => Number.isFinite(value) && value >= 0) ||
    cachedInputTokens > inputTokens
  ) {
    return null
  }

  const uncachedInputTokens = inputTokens - cachedInputTokens
  const estimatedUsd =
    (uncachedInputTokens * rates.input + cachedInputTokens * rates.cachedInput + outputTokens * rates.output) /
    1_000_000

  return Number(estimatedUsd.toFixed(6))
}

const reviewerUsage = (reviewers) =>
  reviewers.map((reviewer, index) => {
    const model = reviewer.modelApplied || 'unknown'
    const tokenUsage = reviewer.sessionTokenUsage
      ? metricsForSessionUsage(reviewer.sessionTokenUsage)
      : tokenMetrics([reviewer])
    return {
      reviewerId: reviewer.reviewerId || `reviewer-${index + 1}`,
      model,
      reasoning: reviewer.reasoningApplied || 'unknown',
      tokenUsage,
      estimatedCostUsd: estimateTokenCost(model, tokenUsage),
    }
  })

const costMetrics = (usageByReviewer) => {
  const estimates = usageByReviewer.filter((reviewer) => reviewer.estimatedCostUsd !== null)
  const complete = usageByReviewer.length > 0 && estimates.length === usageByReviewer.length
  const estimatedKnownUsd =
    estimates.length > 0
      ? Number(estimates.reduce((total, reviewer) => total + reviewer.estimatedCostUsd, 0).toFixed(6))
      : null
  return {
    currency: PRICING_SNAPSHOT.currency,
    pricing: PRICING_SNAPSHOT,
    reviewerCount: usageByReviewer.length,
    reviewersWithEstimate: estimates.length,
    complete,
    estimatedKnownUsd,
    estimatedTotalUsd: complete ? estimatedKnownUsd : null,
  }
}

const formatInteger = (value) => (Number.isFinite(value) ? new Intl.NumberFormat('en-US').format(value) : 'n/a')
const formatCost = (value) => (Number.isFinite(value) ? `$${value.toFixed(4)}` : 'n/a')
const reviewerLabel = (reviewerId, reasoning) => {
  const parts = reviewerId.split('-')
  if (parts.length > 1 && /^\d+$/.test(parts.at(-1))) {
    parts.splice(-2, 2, `${parts.at(-2)}${parts.at(-1)}`)
  }
  const name = parts.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ')
  return `${name} (${reasoning || 'unknown'})`
}

export const renderUsageTable = (derived) => {
  const reviewers = Array.isArray(derived?.reviewerUsage) ? derived.reviewerUsage : []
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']
  const totals = Object.fromEntries(fields.map((field) => [field, 0]))
  const coverage = Object.fromEntries(fields.map((field) => [field, 0]))

  const rows = reviewers.map((reviewer) => {
    const usage = reviewer.tokenUsage?.totals || {}
    for (const field of fields) {
      if (Number.isFinite(usage[field])) {
        totals[field] += usage[field]
        coverage[field] += 1
      }
    }
    return `| ${reviewerLabel(reviewer.reviewerId, reviewer.reasoning)} | ${formatInteger(usage.inputTokens)} | ${formatInteger(usage.cachedInputTokens)} | ${formatInteger(usage.outputTokens)} | ${formatInteger(usage.reasoningOutputTokens)} | ${formatInteger(usage.totalTokens)} | ${formatCost(reviewer.estimatedCostUsd)} |`
  })

  const totalCells = fields.map((field) =>
    formatInteger(reviewers.length > 0 && coverage[field] === reviewers.length ? totals[field] : null),
  )
  const pricing = derived?.estimatedCost?.pricing || PRICING_SNAPSHOT
  const limitations = Array.isArray(pricing.limitations) ? pricing.limitations.join(' ') : ''
  return [
    '### Reviewer token usage',
    '',
    '| Reviewer | Input | Cached input | Output | Reasoning | Total | Estimated cost |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows,
    `| **Total** | **${totalCells[0]}** | **${totalCells[1]}** | **${totalCells[2]}** | **${totalCells[3]}** | **${totalCells[4]}** | **${formatCost(derived?.estimatedCost?.estimatedTotalUsd)}** |`,
    '',
    `Pricing: ${pricing.serviceTier} API-equivalent rates effective ${pricing.effectiveDate} ([source](${pricing.source})). ${limitations}`,
  ].join('\n')
}

const classificationCountsFor = (findingIds, findingsById) => {
  const counts = {}
  for (const findingId of findingIds) {
    const classification = findingsById.get(findingId)?.classification || 'unclassified'
    counts[classification] = (counts[classification] || 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

const modelComparison = (reviewers, findings) => {
  const groups = new Map()
  reviewers.forEach((reviewer, index) => {
    const model = reviewer.modelApplied || 'unknown'
    const reviewerId = reviewer.reviewerId || `reviewer-${index + 1}`
    if (!groups.has(model)) groups.set(model, { model, reviewerIds: [], reviewers: [] })
    const group = groups.get(model)
    group.reviewerIds.push(reviewerId)
    group.reviewers.push(reviewer)
  })

  const findingsById = new Map(
    findings
      .filter((finding) => finding && typeof finding.findingId === 'string' && finding.findingId.length > 0)
      .map((finding) => [finding.findingId, finding]),
  )
  const entries = [...groups.values()].map((group) => {
    const initialFindingIds = [
      ...new Set(group.reviewers.flatMap((reviewer) => findingIdsFor(reviewer, 'initial'))),
    ].sort()
    const cumulativeFindingIds = [
      ...new Set(group.reviewers.flatMap((reviewer) => findingIdsFor(reviewer))),
    ].sort()
    return {
      ...group,
      initialFindingIds,
      cumulativeFindingIds,
      initialValidFindingIds: initialFindingIds.filter(
        (findingId) => findingsById.get(findingId)?.classification === 'valid',
      ),
    }
  })

  const initialFrequency = new Map()
  for (const entry of entries) {
    for (const findingId of entry.initialFindingIds) {
      initialFrequency.set(findingId, (initialFrequency.get(findingId) || 0) + 1)
    }
  }

  const syntheticReviewers = entries.map((entry) => ({
    reviewerId: entry.model,
    rounds: [
      { phase: 'initial', findingIds: entry.initialFindingIds },
      { phase: 'remediation', findingIds: entry.cumulativeFindingIds },
    ],
  }))

  return {
    byModel: entries.map((entry) => {
      const initialTokenUsage = tokenMetrics(entry.reviewers, 'initial')
      const cumulativeTokenUsage = tokenMetrics(entry.reviewers)
      return {
        model: entry.model,
        reviewerIds: entry.reviewerIds,
        reviewerCount: entry.reviewers.length,
        invocationCount: entry.reviewers.reduce(
          (count, reviewer) => count + invocationsFor(reviewer).length,
          0,
        ),
        initialFindingIds: entry.initialFindingIds,
        initialClassificationCounts: classificationCountsFor(entry.initialFindingIds, findingsById),
        initialValidFindingIds: entry.initialValidFindingIds,
        initialUniqueToModelFindingIds: entry.initialFindingIds.filter(
          (findingId) => initialFrequency.get(findingId) === 1,
        ),
        initialUniqueValidFindingIds: entry.initialValidFindingIds.filter(
          (findingId) => initialFrequency.get(findingId) === 1,
        ),
        cumulativeFindingIds: entry.cumulativeFindingIds,
        initialTokenUsage,
        cumulativeTokenUsage,
        initialEstimatedCostUsd: estimateTokenCost(entry.model, initialTokenUsage),
        cumulativeEstimatedCostUsd: estimateTokenCost(entry.model, cumulativeTokenUsage),
      }
    }),
    initialOverlap: overlapFor(syntheticReviewers, 'initial'),
    cumulativeOverlap: overlapFor(syntheticReviewers),
  }
}

export const deriveMetrics = (summary = {}) => {
  assertObject(summary, 'summary')
  const reviewers = Array.isArray(summary.reviewers) ? summary.reviewers : []
  const findings = Array.isArray(summary.findings) ? summary.findings : []
  const initialOverlap = overlapFor(reviewers, 'initial')
  const cumulativeOverlap = overlapFor(reviewers)
  const githubReviewBots = Array.isArray(summary.githubReviewBots) ? summary.githubReviewBots : []
  const usageByReviewer = reviewerUsage(reviewers)

  return {
    reviewerSessionCount: reviewers.length,
    reviewerInvocationCount: reviewers.reduce(
      (count, reviewer) => count + invocationsFor(reviewer).length,
      0,
    ),
    continuityInvocationCount: reviewers.reduce(
      (count, reviewer) => count + (Array.isArray(reviewer.continuityChecks) ? reviewer.continuityChecks.length : 0),
      0,
    ),
    roundsByReviewer: reviewers.map((reviewer, index) => ({
      reviewerId: reviewer.reviewerId || `reviewer-${index + 1}`,
      roundCount: Array.isArray(reviewer.rounds) ? reviewer.rounds.length : 0,
      continuityInvocationCount: Array.isArray(reviewer.continuityChecks) ? reviewer.continuityChecks.length : 0,
      invocationCount: invocationsFor(reviewer).length,
    })),
    reviewersWhoFoundIssues: reviewers
      .map((reviewer, index) => ({
        reviewerId: reviewer.reviewerId || `reviewer-${index + 1}`,
        foundIssues: findingIdsFor(reviewer).length > 0,
      }))
      .filter((reviewer) => reviewer.foundIssues)
      .map((reviewer) => reviewer.reviewerId),
    initialUniqueFindingCount: initialOverlap.uniqueFindingIds.length,
    cumulativeUniqueFindingCount: cumulativeOverlap.uniqueFindingIds.length,
    initialOverlap,
    cumulativeOverlap,
    modelComparison: modelComparison(reviewers, findings),
    reviewerUsage: usageByReviewer,
    tokenUsage: tokenMetrics(reviewers),
    estimatedCost: costMetrics(usageByReviewer),
    githubReviewBotCount: githubReviewBots.length,
    reviewBotLoopCount:
      typeof summary.reviewBotLoopCount === 'number' && Number.isFinite(summary.reviewBotLoopCount)
        ? summary.reviewBotLoopCount
        : null,
  }
}

export const finishRun = ({ logPath, summary = {}, timestamp, collectCodexUsage = false, sessionsRoot } = {}) => {
  if (!logPath) fail('logPath is required')
  assertObject(summary, 'summary')
  const { events, runId } = runIdentity(logPath)
  if (events.some((item) => item.event === 'run_finished')) fail(`Run is already finished: ${logPath}`)
  let finalSummary = summary
  let tokenUsageCollection = null
  if (collectCodexUsage) {
    const first = events[0]
    const result = collectCodexSessionUsage(summary, {
      sessionsRoot,
      startedAt: first.timestamp,
      endedAt: timestamp || new Date().toISOString(),
      repoRoot: first.repo?.root,
    })
    finalSummary = result.summary
    tokenUsageCollection = result.collection
  }
  const derived = deriveMetrics(finalSummary)
  const record = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    timestamp: isoTimestamp(timestamp),
    event: 'run_finished',
    data: { ...finalSummary, ...(tokenUsageCollection ? { tokenUsageCollection } : {}), derived },
  }
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

const parseOptions = (args) => {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) fail(`Unexpected argument: ${argument}`)
    const equals = argument.indexOf('=')
    if (equals !== -1) {
      options[argument.slice(2, equals)] = argument.slice(equals + 1)
      continue
    }
    const key = argument.slice(2)
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) options[key] = true
    else {
      options[key] = next
      index += 1
    }
  }
  return options
}

const readDataOption = (options, label) => {
  if (options['data-json'] && options['data-file']) fail('Use only one of --data-json or --data-file')
  let raw = '{}'
  if (options['data-json']) raw = options['data-json']
  if (options['data-file']) raw = readFileSync(options['data-file'] === '-' ? 0 : options['data-file'], 'utf8')
  try {
    return assertObject(JSON.parse(raw), label)
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`)
  }
}

const help = `Usage:
  review-run-log.mjs start [--repo-root <path>] [--output-root <path>] [--data-json <object>]
  review-run-log.mjs append --log <path> --event <lower_snake_case> [--data-json <object>]
  review-run-log.mjs finish --log <path> [--collect-codex-usage] [--sessions-root <path>] [--data-json <summary>]
  review-run-log.mjs report --log <path>

Use --data-file <path> instead of --data-json, or --data-file - to read JSON from stdin.
Each command prints JSON. start prints logPath and runId; finish prints the derived metrics.`

const main = () => {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(`${help}\n`)
    return
  }
  const options = parseOptions(args)
  if (command === 'start') {
    const result = startRun({
      repoRoot: options['repo-root'],
      outputRoot: options['output-root'],
      configuration: readDataOption(options, 'configuration'),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (command === 'append') {
    const result = appendEvent({
      logPath: options.log,
      event: options.event,
      data: readDataOption(options, 'data'),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (command === 'finish') {
    const result = finishRun({
      logPath: options.log,
      summary: readDataOption(options, 'summary'),
      collectCodexUsage: Boolean(options['collect-codex-usage']),
      sessionsRoot: options['sessions-root'],
    })
    process.stdout.write(`${JSON.stringify({ logPath: resolve(options.log), derived: result.data.derived })}\n`)
    return
  }
  if (command === 'report') {
    const events = readEvents(options.log)
    const finished = [...events].reverse().find((event) => event.event === 'run_finished')
    if (!finished) fail(`Run is not finished: ${options.log}`)
    process.stdout.write(`${renderUsageTable(finished.data?.derived)}\n`)
    return
  }
  fail(`Unknown command: ${command}`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === scriptPath) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`review-run-log: ${error.message}\n`)
    process.exitCode = 1
  }
}
