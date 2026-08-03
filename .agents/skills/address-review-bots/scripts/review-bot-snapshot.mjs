#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const DEFAULT_BOT_LOGINS = [
  'claude[bot]',
  'devin-ai-integration[bot]',
  'devin-ai-integration',
  'devin[bot]',
]

const DEFAULT_CHECK_PATTERNS = ['claude', 'devin', 'review']

const usage = `Usage: review-bot-snapshot.mjs [options]

Collect fresh review-bot checks and comments for the current GitHub PR.

Options:
  --wait                         Wait for review-like checks to finish before snapshotting.
  --timeout-minutes <n>          Max wait time. Default: 35.
  --poll-seconds <n>             Poll interval while waiting. Default: 20.
  --discovery-seconds <n>        Wait this long for review checks to appear. Default: 90.
  --pr <number>                  PR number. Default: current branch PR from gh pr view.
  --since <iso-timestamp>        Include top-level bot comments created at/after this time.
  --bot-logins <csv>             Bot logins to include. Default: REVIEW_BOT_LOGINS or Claude/Devin.
  --check-patterns <csv>         Check/status name patterns to wait on. Default: claude,devin,review.
  --include-stale                Include comments from old head SHAs in freshComments.
  --json                         Emit JSON. Default: markdown summary.
  --help                         Show this help.
`

const parseArgs = (argv) => {
  const options = {
    botLogins: (process.env.REVIEW_BOT_LOGINS || DEFAULT_BOT_LOGINS.join(','))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    checkPatterns: DEFAULT_CHECK_PATTERNS,
    discoverySeconds: 90,
    includeStale: false,
    json: false,
    pollSeconds: 20,
    pr: undefined,
    since: undefined,
    timeoutMinutes: 35,
    wait: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (!value) {
        throw new Error(`Missing value for ${arg}`)
      }
      return value
    }

    switch (arg) {
      case '--bot-logins':
        options.botLogins = next()
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
        break
      case '--check-patterns':
        options.checkPatterns = next()
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
        break
      case '--discovery-seconds':
        options.discoverySeconds = Number(next())
        break
      case '--help':
        process.stdout.write(usage)
        process.exit(0)
        break
      case '--include-stale':
        options.includeStale = true
        break
      case '--json':
        options.json = true
        break
      case '--poll-seconds':
        options.pollSeconds = Number(next())
        break
      case '--pr':
        options.pr = Number(next())
        break
      case '--since':
        options.since = next()
        break
      case '--timeout-minutes':
        options.timeoutMinutes = Number(next())
        break
      case '--wait':
        options.wait = true
        break
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage}`)
    }
  }

  for (const [name, value] of [
    ['discovery-seconds', options.discoverySeconds],
    ['poll-seconds', options.pollSeconds],
    ['timeout-minutes', options.timeoutMinutes],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`--${name} must be a positive number`)
    }
  }

  if (options.pr !== undefined && (!Number.isInteger(options.pr) || options.pr <= 0)) {
    throw new Error('--pr must be a positive integer')
  }

  return options
}

const runText = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })

  if (result.error) {
    if (options.allowFailure) {
      return undefined
    }
    throw result.error
  }

  if (result.status !== 0) {
    if (options.allowFailure) {
      return undefined
    }

    const stderr = result.stderr.trim()
    const detail = stderr ? `\n${stderr}` : ''
    throw new Error(`Command failed: ${command} ${args.join(' ')}${detail}`)
  }

  return result.stdout.trim()
}

const runJson = (command, args, options = {}) => {
  const stdout = runText(command, args, options)
  if (stdout === undefined || stdout === '') {
    return undefined
  }

  return JSON.parse(stdout)
}

const ghJson = (endpoint) => {
  return runJson('gh', ['api', '-H', 'Accept: application/vnd.github+json', endpoint])
}

const fetchPagedArray = (endpoint) => {
  const output = []
  const separator = endpoint.includes('?') ? '&' : '?'

  for (let page = 1; page <= 20; page += 1) {
    const data = ghJson(`${endpoint}${separator}per_page=100&page=${page}`)
    if (!Array.isArray(data)) {
      throw new Error(`Expected array response from ${endpoint}`)
    }

    output.push(...data)
    if (data.length < 100) {
      break
    }
  }

  return output
}

const getRepo = () => {
  const repo = runJson('gh', ['repo', 'view', '--json', 'owner,name'])
  const owner = repo?.owner?.login
  const name = repo?.name

  if (!owner || !name) {
    throw new Error('Could not determine GitHub owner/repo with gh repo view')
  }

  return { name, owner }
}

const getPullForCurrentBranch = () => {
  return runJson('gh', ['pr', 'view', '--json', 'number,url,headRefName,headRefOid'])
}

const getPull = (repo, prNumber) => {
  const pull = ghJson(`/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`)

  return {
    headRefName: pull.head?.ref,
    headSha: pull.head?.sha,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    url: pull.html_url,
  }
}

const getHeadCommitIso = (sha) => {
  return runText('git', ['show', '-s', '--format=%cI', sha], { allowFailure: true })
}

const textIncludesAny = (value, patterns) => {
  const lower = value.toLowerCase()
  return patterns.some((pattern) => lower.includes(pattern))
}

const getChecks = (repo, sha, patterns) => {
  const checkRunsResponse = ghJson(
    `/repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?per_page=100`,
  )
  const checkRuns = (checkRunsResponse.check_runs || []).map((check) => {
    const text = [
      check.name,
      check.app?.name,
      check.app?.slug,
      check.details_url,
      check.html_url,
    ]
      .filter(Boolean)
      .join(' ')

    return {
      app: check.app?.slug || check.app?.name || undefined,
      completedAt: check.completed_at,
      conclusion: check.conclusion,
      id: check.id,
      isReviewRelated: textIncludesAny(text, patterns),
      name: check.name,
      startedAt: check.started_at,
      status: check.status,
      type: 'check_run',
      url: check.html_url || check.details_url,
    }
  })

  const statusesResponse = ghJson(`/repos/${repo.owner}/${repo.name}/commits/${sha}/status`)
  const statuses = (statusesResponse.statuses || []).map((status) => {
    const text = [status.context, status.description, status.target_url].filter(Boolean).join(' ')

    return {
      app: undefined,
      completedAt: status.updated_at,
      conclusion: status.state === 'success' ? 'success' : status.state,
      id: undefined,
      isReviewRelated: textIncludesAny(text, patterns),
      name: status.context,
      startedAt: status.created_at,
      status: status.state === 'pending' ? 'in_progress' : 'completed',
      type: 'status',
      url: status.target_url,
    }
  })

  return [...checkRuns, ...statuses].filter((check) => check.isReviewRelated)
}

const isPendingCheck = (check) => {
  return ['queued', 'requested', 'waiting', 'pending', 'in_progress'].includes(check.status)
}

const waitForReviewChecks = async (repo, prNumber, options) => {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMinutes * 60 * 1000
  const discoveryMs = options.discoverySeconds * 1000
  const pollMs = options.pollSeconds * 1000
  let lastChecks = []
  let lastPull = getPull(repo, prNumber)
  let sawReviewChecks = false
  let timedOut = false

  while (true) {
    lastPull = getPull(repo, prNumber)
    lastChecks = getChecks(repo, lastPull.headSha, options.checkPatterns)
    const pending = lastChecks.filter(isPendingCheck)
    const elapsedMs = Date.now() - startedAt

    if (lastChecks.length > 0) {
      sawReviewChecks = true
    }

    process.stderr.write(
      `[review-bots] ${lastPull.headSha.slice(0, 7)} review-checks=${lastChecks.length} pending=${pending.length}\n`,
    )

    if (sawReviewChecks && pending.length === 0) {
      break
    }

    if (!sawReviewChecks && elapsedMs >= discoveryMs) {
      break
    }

    if (elapsedMs >= timeoutMs) {
      timedOut = true
      break
    }

    await sleep(pollMs)
  }

  return {
    checks: lastChecks,
    headSha: lastPull.headSha,
    sawReviewChecks,
    timedOut,
  }
}

const truncate = (value, length = 300) => {
  const trimmed = (value || '').trim()
  if (trimmed.length <= length) {
    return trimmed
  }

  return `${trimmed.slice(0, length - 1)}...`
}

const isBotLogin = (login, botLogins) => {
  const normalized = login?.toLowerCase()
  return Boolean(normalized && botLogins.some((bot) => bot.toLowerCase() === normalized))
}

const isoToMs = (value) => {
  if (!value) {
    return undefined
  }

  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO timestamp: ${value}`)
  }

  return ms
}

const commentBase = (type, raw) => {
  return {
    author: raw.user?.login,
    body: raw.body || '',
    bodyPreview: truncate(raw.body || ''),
    createdAt: raw.created_at || raw.submitted_at,
    htmlUrl: raw.html_url,
    id: raw.id,
    type,
    updatedAt: raw.updated_at,
  }
}

const classifyFreshness = (comment, headSha, sinceMs, includeStale) => {
  if (includeStale) {
    return { fresh: true, staleReason: undefined }
  }

  if (comment.commitId && comment.commitId !== headSha) {
    return { fresh: false, staleReason: `comment is for ${comment.commitId.slice(0, 7)}` }
  }

  if (!comment.commitId && sinceMs !== undefined) {
    const createdAt = isoToMs(comment.createdAt)
    if (createdAt !== undefined && createdAt < sinceMs) {
      return { fresh: false, staleReason: `top-level comment predates ${new Date(sinceMs).toISOString()}` }
    }
  }

  return { fresh: true, staleReason: undefined }
}

const collectBotComments = (repo, pull, options, sinceIso) => {
  const sinceMs = isoToMs(sinceIso)
  const inlineComments = fetchPagedArray(`/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`)
  const reviews = fetchPagedArray(`/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/reviews`)
  const issueComments = fetchPagedArray(`/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`)
  const freshComments = []
  const staleComments = []

  const add = (comment) => {
    if (!isBotLogin(comment.author, options.botLogins)) {
      return
    }

    if (!comment.body.trim()) {
      return
    }

    const freshness = classifyFreshness(comment, pull.headSha, sinceMs, options.includeStale)
    const annotated = {
      ...comment,
      fresh: freshness.fresh,
      staleReason: freshness.staleReason,
    }

    if (freshness.fresh) {
      freshComments.push(annotated)
    } else {
      staleComments.push(annotated)
    }
  }

  for (const raw of inlineComments) {
    add({
      ...commentBase('inline', raw),
      commitId: raw.commit_id,
      diffHunk: raw.diff_hunk,
      line: raw.line || raw.original_line || raw.position,
      originalCommitId: raw.original_commit_id,
      path: raw.path,
      pullRequestReviewId: raw.pull_request_review_id,
    })
  }

  for (const raw of reviews) {
    add({
      ...commentBase('review', raw),
      commitId: raw.commit_id,
      state: raw.state,
    })
  }

  for (const raw of issueComments) {
    add({
      ...commentBase('issue', raw),
      commitId: undefined,
    })
  }

  return {
    freshComments: freshComments.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    staleComments: staleComments.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
  }
}

const buildSnapshot = async (options) => {
  runText('gh', ['auth', 'status'], { allowFailure: false })

  const repo = getRepo()
  const currentPr = options.pr ? undefined : getPullForCurrentBranch()
  const prNumber = options.pr || currentPr?.number

  if (!prNumber) {
    throw new Error('No PR number found. Run from a branch with an open PR or pass --pr <number>.')
  }

  let waitResult = {
    checks: [],
    headSha: undefined,
    sawReviewChecks: false,
    timedOut: false,
  }

  if (options.wait) {
    waitResult = await waitForReviewChecks(repo, prNumber, options)
  }

  const pull = getPull(repo, prNumber)
  const checks = waitResult.checks.length > 0 ? waitResult.checks : getChecks(repo, pull.headSha, options.checkPatterns)
  const fallbackSince = getHeadCommitIso(pull.headSha)
  const sinceIso = options.since || fallbackSince
  const comments = collectBotComments(repo, pull, options, sinceIso)

  return {
    botLogins: options.botLogins,
    checkPatterns: options.checkPatterns,
    comments,
    generatedAt: new Date().toISOString(),
    includeStale: options.includeStale,
    pr: pull,
    reviewChecks: {
      checks,
      pending: checks.filter(isPendingCheck),
      sawReviewChecks: waitResult.sawReviewChecks || checks.length > 0,
      timedOut: waitResult.timedOut,
    },
    since: sinceIso,
  }
}

const renderMarkdown = (snapshot) => {
  const lines = []
  lines.push(`# Review Bot Snapshot`)
  lines.push('')
  lines.push(`PR: #${snapshot.pr.number} ${snapshot.pr.url}`)
  lines.push(`Head: ${snapshot.pr.headSha}`)
  lines.push(`Since: ${snapshot.since || 'not set'}`)
  lines.push(`Generated: ${snapshot.generatedAt}`)
  lines.push('')

  const checks = snapshot.reviewChecks.checks
  lines.push(`## Review Checks (${checks.length})`)
  if (checks.length === 0) {
    lines.push('No review-like checks or statuses found.')
  } else {
    for (const check of checks) {
      const conclusion = check.conclusion ? ` / ${check.conclusion}` : ''
      const url = check.url ? ` ${check.url}` : ''
      lines.push(`- ${check.name}: ${check.status}${conclusion}${url}`)
    }
  }
  if (snapshot.reviewChecks.timedOut) {
    lines.push('')
    lines.push('Wait timed out before all review-like checks completed.')
  }

  lines.push('')
  lines.push(`## Fresh Bot Comments (${snapshot.comments.freshComments.length})`)
  if (snapshot.comments.freshComments.length === 0) {
    lines.push('No fresh bot comments found.')
  } else {
    for (const comment of snapshot.comments.freshComments) {
      const location = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ''}` : 'top-level'
      lines.push('')
      lines.push(`### ${comment.type} ${comment.author} at ${location}`)
      lines.push(`URL: ${comment.htmlUrl}`)
      if (comment.commitId) {
        lines.push(`Commit: ${comment.commitId}`)
      }
      lines.push('')
      lines.push(comment.body.trim())
    }
  }

  lines.push('')
  lines.push(`## Stale Skipped Bot Comments (${snapshot.comments.staleComments.length})`)
  for (const comment of snapshot.comments.staleComments) {
    const location = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ''}` : 'top-level'
    lines.push(`- ${comment.author} ${comment.type} at ${location}: ${comment.staleReason} (${comment.htmlUrl})`)
  }

  return `${lines.join('\n')}\n`
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const snapshot = await buildSnapshot(options)

  if (options.json) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
  } else {
    process.stdout.write(renderMarkdown(snapshot))
  }
}

main().catch((error) => {
  process.stderr.write(`review-bot-snapshot: ${error.message}\n`)
  process.exit(1)
})
