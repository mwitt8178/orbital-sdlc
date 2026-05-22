#!/usr/bin/env node
/**
 * main.js — Story Executor verification daemon.
 *
 * Loop:
 *   1. Pick up a story.ready event (synthetic in-memory queue here).
 *   2. Insert worker_runs row (status=spawning).
 *   3. Transition story status: ready -> in_progress (via JSONL audit log).
 *   4. Spawn worker (real claude OR fake-claude; controlled by mode).
 *   5. Run tests in sandbox; on failure retry up to 3x (each is its own
 *      worker_runs row; story stays in_progress).
 *   6. On green tests: open real GitHub PR. Story -> in_review -> done.
 *      Channel post: pr.opened.
 *   7. On 3 failures / budget kill / timeout: story -> cancelled.
 *
 * Concurrency: single-worker for verification; the dispatcher is structured
 * so multi-worker concurrency is a trivial loop change later.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { BudgetTracker } from './budget.js'
import { spawnWorker } from './spawn-worker.js'
import {
  insertWorkerRun,
  updateWorkerRun,
  listWorkerRuns,
  closePool,
  writeAuditLine,
  ulidToUuid,
  checkProjectBudget,
} from './db.js'
import { ulid } from 'ulid'
import {
  ensureRepoExists,
  commitAndPush,
  openPullRequest,
  ghAuthenticatedUser,
} from './github-pr.js'

const execFileP = promisify(execFile)

const MAX_TEST_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// In-memory story + event registry (stand-in for stories/events tables, since
// the user authorized only migration 0038 against this DB).
// ---------------------------------------------------------------------------

const stories = new Map()
const eventQueue = []

function emitEvent(kind, payload) {
  const evt = { event_id: ulidToUuid(ulid()), kind, ...payload, ts: new Date().toISOString() }
  eventQueue.push(evt)
  void writeAuditLine('event', evt)
  return evt
}

function transitionStory(storyId, from, to, reason = null) {
  const s = stories.get(storyId)
  if (!s) throw new Error(`unknown story ${storyId}`)
  if (s.status !== from) {
    throw new Error(`story ${storyId} expected status ${from} but is ${s.status}`)
  }
  s.status = to
  void writeAuditLine('story.transition', { storyId, from, to, reason })
}

function postChannelEvent(channel, postType, payload) {
  const post = {
    post_id: ulidToUuid(ulid()),
    channel,
    post_type: postType,
    payload,
    created_at: new Date().toISOString(),
  }
  void writeAuditLine('channel_post', post)
  return post
}

// ---------------------------------------------------------------------------
// Sandbox management
// ---------------------------------------------------------------------------

async function makeSandboxDir(runId) {
  const dir = path.join(os.tmpdir(), `orbital-exec-${runId}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// One attempt: spawn worker, run tests.
// ---------------------------------------------------------------------------

async function runOneAttempt({ story, attempt, mode, fakeBehaviour, wallClockMs }) {
  const budget = getOrCreateBudget(story.storyId)
  const { runId } = await insertWorkerRun({ storyId: story.storyId, attempt })
  void writeAuditLine('worker_run.started', { runId, storyId: story.storyId, attempt, mode })

  const sandboxDir = await makeSandboxDir(runId)

  // Initial scaffold: package.json with a test script using node --test.
  await fs.writeFile(
    path.join(sandboxDir, 'package.json'),
    JSON.stringify(
      {
        name: 'orbital-sandbox',
        version: '0.0.0',
        type: 'module',
        scripts: { test: 'node --test "src/**/*.test.js"' },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  await fs.writeFile(
    path.join(sandboxDir, 'README.md'),
    `# ${story.title}\n\n${story.description}\n`,
    'utf8',
  )

  await updateWorkerRun(runId, { status: 'running' })

  const result = await spawnWorker({
    prompt: `Implement: ${story.title}\n\n${story.description}`,
    cwd: sandboxDir,
    budget,
    mode,
    wallClockMs,
    fakeBehaviour,
    onEvent: (evt) =>
      writeAuditLine('worker_stream', { runId, evt: clipEvent(evt) }),
  })

  // Persist final cost / tokens / pid.
  await updateWorkerRun(runId, {
    pid: result.pid,
    cost_usd_cents: result.totalCostCents,
    prompt_tokens: result.promptTokens,
    output_tokens: result.outputTokens,
    exit_code: result.exitCode,
  })

  if (result.killedReason === 'budget') {
    await updateWorkerRun(runId, {
      status: 'budget_killed',
      ended_at: new Date(),
      failure_reason: 'budget_cap_exceeded',
    })
    return { runId, sandboxDir, outcome: 'budget_killed', cost: result.totalCostCents }
  }
  if (result.killedReason === 'timeout') {
    await updateWorkerRun(runId, {
      status: 'timed_out',
      ended_at: new Date(),
      failure_reason: 'wall_clock_timeout',
    })
    return { runId, sandboxDir, outcome: 'timed_out', cost: result.totalCostCents }
  }
  if (result.exitCode !== 0) {
    await updateWorkerRun(runId, {
      status: 'failed',
      ended_at: new Date(),
      failure_reason: `worker_exit_${result.exitCode}`,
    })
    return { runId, sandboxDir, outcome: 'worker_error', cost: result.totalCostCents }
  }

  // Run tests.
  let testsOk = false
  let testStderr = ''
  try {
    await execFileP('npm', ['test', '--silent'], { cwd: sandboxDir })
    testsOk = true
  } catch (err) {
    testStderr = String(err.stderr ?? err.message ?? err).slice(0, 1000)
  }

  if (!testsOk) {
    await updateWorkerRun(runId, {
      status: 'failed',
      ended_at: new Date(),
      failure_reason: `tests_failed: ${testStderr.slice(0, 200)}`,
    })
    return { runId, sandboxDir, outcome: 'tests_failed', cost: result.totalCostCents }
  }

  await updateWorkerRun(runId, {
    status: 'succeeded',
    ended_at: new Date(),
  })
  return { runId, sandboxDir, outcome: 'succeeded', cost: result.totalCostCents }
}

function clipEvent(evt) {
  const e = { ...evt }
  if (typeof e.text === 'string' && e.text.length > 200) e.text = e.text.slice(0, 200) + '…'
  return e
}

// Per-story budget: each story uses one tracker so retries share the cap.
const _budgets = new Map()
function getOrCreateBudget(storyId) {
  if (!_budgets.has(storyId)) _budgets.set(storyId, new BudgetTracker())
  return _budgets.get(storyId)
}

// ---------------------------------------------------------------------------
// Full per-story lifecycle.
// ---------------------------------------------------------------------------

export async function executeStory(story, opts = {}) {
  const {
    mode = 'fake',
    fakeBehaviour = {},
    wallClockMs,
    repoOwner,
    repoName,
    base = 'main',
    // Budget enforcement context — optional for backward-compat.
    // [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
    tenantId = '00000000-0000-0000-0000-000000000000',
    projectId,
  } = opts

  if (story.status !== 'ready') {
    throw new Error(`story ${story.storyId} must be 'ready' to execute, got ${story.status}`)
  }

  // Pre-flight budget check — block if monthly hard cap would be exceeded.
  // Conservative estimate: claude-sonnet-4-6 at 100k input + 20k output.
  // 100000/1M * $3.00 + 20000/1M * $15.00 = $0.30 + $0.30 = $0.60 per attempt.
  // [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
  if (projectId) {
    const budgetCheck = await checkProjectBudget({
      tenantId,
      projectId,
      persona: 'story-executor',
      estimatedCostUsd: 0.60,
    })
    if (!budgetCheck.allow) {
      void writeAuditLine('budget.blocked', {
        storyId: story.storyId,
        projectId,
        reason: budgetCheck.reason,
        budgetCapUsd: budgetCheck.budgetCapUsd,
        mtdSpendUsd: budgetCheck.mtdSpendUsd,
      })
      return {
        storyStatus: 'cancelled',
        reason: 'budget_exceeded',
        lastRunId: null,
        budgetBlocked: true,
        budgetReason: budgetCheck.reason,
      }
    }
    if (budgetCheck.reason) {
      // Soft threshold warning — log but continue.
      void writeAuditLine('budget.warning', {
        storyId: story.storyId,
        projectId,
        reason: budgetCheck.reason,
        mtdSpendUsd: budgetCheck.mtdSpendUsd,
      })
    }
  }

  transitionStory(story.storyId, 'ready', 'in_progress', 'story-executor pickup')
  postChannelEvent('orb-engineering', 'system_event', {
    kind: 'worker.spawned',
    storyId: story.storyId,
    title: story.title,
  })

  let lastResult = null
  for (let attempt = 1; attempt <= MAX_TEST_ATTEMPTS; attempt++) {
    lastResult = await runOneAttempt({
      story,
      attempt,
      mode,
      fakeBehaviour,
      wallClockMs,
    })
    if (lastResult.outcome === 'succeeded') break
    if (lastResult.outcome === 'budget_killed' || lastResult.outcome === 'timed_out') break
    // tests_failed / worker_error: try again until we hit MAX_TEST_ATTEMPTS.
  }

  if (!lastResult) throw new Error('unreachable: no attempt was made')

  if (lastResult.outcome === 'budget_killed') {
    transitionStory(story.storyId, 'in_progress', 'cancelled', 'budget_exceeded')
    postChannelEvent('orb-engineering', 'alert', {
      kind: 'budget_exceeded',
      storyId: story.storyId,
      cost_usd_cents: lastResult.cost,
    })
    return { storyStatus: 'cancelled', reason: 'budget_killed', lastRunId: lastResult.runId }
  }
  if (lastResult.outcome === 'timed_out') {
    transitionStory(story.storyId, 'in_progress', 'cancelled', 'wall_clock_timeout')
    postChannelEvent('orb-engineering', 'alert', {
      kind: 'worker_timeout',
      storyId: story.storyId,
    })
    return { storyStatus: 'cancelled', reason: 'timed_out', lastRunId: lastResult.runId }
  }
  if (lastResult.outcome !== 'succeeded') {
    transitionStory(story.storyId, 'in_progress', 'cancelled', 'tests_failed_3x')
    postChannelEvent('orb-engineering', 'blocker', {
      kind: 'worker.gave_up',
      storyId: story.storyId,
      attempts: MAX_TEST_ATTEMPTS,
    })
    return { storyStatus: 'cancelled', reason: 'tests_failed_3x', lastRunId: lastResult.runId }
  }

  // SUCCESS path — open a real PR.
  if (!repoOwner || !repoName) {
    transitionStory(story.storyId, 'in_progress', 'in_review', 'no-repo-config')
    return { storyStatus: 'in_review', reason: 'no_repo_configured', lastRunId: lastResult.runId }
  }

  await ensureRepoExists({
    owner: repoOwner,
    repo: repoName,
    description: 'Orbital story-executor verification sandbox',
  })
  const repoUrl = `https://github.com/${repoOwner}/${repoName}.git`
  const branch = `feat/${slug(story.title)}-${String(story.storyId).slice(0, 8)}`

  // Re-bootstrap the sandbox as a real git clone so we share history with the
  // remote (the gh repo create --add-readme made an initial commit).
  const cloneDir = lastResult.sandboxDir + '-clone'
  await execFileP('git', ['clone', '-q', repoUrl, cloneDir])
  // Copy worker artifacts on top of the clone.
  await execFileP('cp', ['-R', `${lastResult.sandboxDir}/.`, cloneDir])
  // Make sure node_modules from the test run is not pushed.
  await fs.rm(path.join(cloneDir, 'node_modules'), { recursive: true, force: true }).catch(() => {})

  await commitAndPush({
    sandboxDir: cloneDir,
    branch,
    commitMessage: `feat: ${story.title}\n\nStory: ${story.storyId}\nRun: ${lastResult.runId}\n\nCo-Authored-By: Orbital Story Executor <noreply@orbital.local>`,
  })

  const { url } = await openPullRequest({
    owner: repoOwner,
    repo: repoName,
    head: branch,
    base,
    title: `feat: ${story.title}`,
    body: [
      `## Story`,
      `- ID: \`${story.storyId}\``,
      `- Title: ${story.title}`,
      ``,
      `## Worker run`,
      `- Run ID: \`${lastResult.runId}\``,
      `- Total cost: ${(lastResult.cost / 100).toFixed(2)} USD`,
      ``,
      `Generated by orbital-story-executor (verification run).`,
    ].join('\n'),
  })

  await updateWorkerRun(lastResult.runId, { branch, pr_url: url })
  transitionStory(story.storyId, 'in_progress', 'in_review', `pr_opened ${url}`)
  postChannelEvent('orb-engineering', 'status_update', {
    kind: 'pr.opened',
    storyId: story.storyId,
    runId: lastResult.runId,
    pr_url: url,
  })
  // Verification framing: also mark merged=done synthetically (we do NOT call
  // gh pr merge — we only mark the local story state as 'done' to complete
  // the trace mapping. See architecture.md note on why.).
  transitionStory(story.storyId, 'in_review', 'done', 'verification_terminal')
  postChannelEvent('orb-engineering', 'status_update', {
    kind: 'story.done',
    storyId: story.storyId,
    pr_url: url,
  })

  return { storyStatus: 'done', reason: 'pr_opened', lastRunId: lastResult.runId, pr_url: url }
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

// ---------------------------------------------------------------------------
// Public registry helpers (used by verify-loop.js)
// ---------------------------------------------------------------------------

export function registerStory({ storyId, title, description, status = 'ready' }) {
  stories.set(storyId, { storyId, title, description, status })
  emitEvent('story.ready', { storyId, title })
  return stories.get(storyId)
}

export function getStory(id) {
  return stories.get(id)
}

export async function shutdown() {
  await closePool()
}

export { listWorkerRuns }
