/**
 * story-runs/run.ts — End-to-end story → PR pipeline executor.
 *
 * [Engineer-Principal · Opus · run-story-pr-pipeline]
 *
 * Orchestrates: clone → branch → agent → commit (via ScmClient) → open PR →
 * persist diff stats. State machine transitions are committed eagerly to
 * story_pr_runs so the UI can poll progress.
 *
 * Failure semantics: any thrown error finalises the run as 'failed' and
 * destroys the worktree. The branch (if pushed) and any partial commits are
 * intentionally left in place for reviewer inspection via the existing
 * Attempts diff UI.
 */

import { eq, and, desc } from 'drizzle-orm'
import { db as defaultDb } from '../db/client.js'
import { stories, storyAcceptanceCriteria } from '../db/schema/backlog.js'
import { tasks } from '../db/schema/orchestration.js'
import { projects } from '../db/schema/projects.js'
import { costLedger } from '../db/schema/cost.js'
import { logger } from '../config/logger.js'
import { loadEnv } from '../config/env.js'
import { createGithubClient } from '../github/client.js'
import { getScmClient, type ScmProvider } from '../scm/factory.js'
import type { ScmClient } from '../scm/client.js'

import { buildBranchName, buildCommitMessage } from './commit-message.js'
import { reduceDiffStats } from './diff-stats.js'
import {
  cloneRepo,
  checkoutBranch,
  collectScmFiles,
  destroyWorktree,
  hasChanges,
  scaffoldEmptyWorktree,
  type WorktreeHandle,
} from './worktree.js'
import {
  finalizeFailure,
  finalizeSuccess,
  loadRunById,
  setStatus,
  setStoryPrUrl,
} from './repo.js'

export interface RunStoryPrInput {
  tenantId: string
  runId: string
  storyId: string
}

export interface RunStoryPrDeps {
  /** Override for tests — defaults to the real ScmClient factory. */
  scmClientFactory?: (
    provider: ScmProvider,
    repoId: string | null,
  ) => ScmClient
  /**
   * Override for tests — invokes the agent inside `cwd`. Default delegates to
   * the real Claude Code spawn (or fake-claude if ANTHROPIC_API_KEY missing
   * AND RUN_MODE=fake; otherwise we surface the configuration gap rather than
   * silently degrade per the project's "Real Implementations Only" rule).
   */
  runAgent?: (opts: { cwd: string; prompt: string }) => Promise<{ exitCode: number }>
}

export interface RunStoryPrResult {
  prUrl: string | null
  commitSha: string | null
  status: 'succeeded' | 'failed'
  error?: string
}

/**
 * Defaults: spawn the real Claude Code CLI from spawn-worker.js. When
 * ANTHROPIC_API_KEY is missing we throw — silent fake mode is opt-in via
 * RUN_MODE=fake.
 */
async function defaultRunAgent(opts: { cwd: string; prompt: string }): Promise<{ exitCode: number }> {
  const haveKey = !!process.env['ANTHROPIC_API_KEY']
  const fakeOptIn = process.env['RUN_MODE'] === 'fake'
  if (!haveKey && !fakeOptIn) {
    throw new Error(
      'agent_disabled: ANTHROPIC_API_KEY is not configured and RUN_MODE!=fake; cannot run agent end-to-end',
    )
  }
  // Lazy import — story-executor is a sibling package; we use its
  // spawn-worker.js (the same surface QA uses for failure-mode walks).
  // The require path is resolved relative to this file at runtime.
  // @ts-expect-error — JS module without TS declarations
  const mod = await import('@orbital/story-executor/spawn-worker')
  const spawnWorker = (mod as { spawnWorker: (o: unknown) => Promise<{ exitCode: number }> }).spawnWorker
  // Minimal BudgetTracker implementation — the daemon enforces global cost
  // budgets elsewhere; for a single story-pr run we bound by wall clock.
  const budget = {
    cap_cents: 2500,
    used_cents: 0,
    add(c: number): boolean {
      this.used_cents += c
      return this.used_cents <= this.cap_cents
    },
  }
  const result = await spawnWorker({
    prompt: opts.prompt,
    cwd: opts.cwd,
    budget,
    mode: haveKey ? 'real' : 'fake',
    wallClockMs: 15 * 60 * 1000,
    onEvent: () => {},
  })
  return { exitCode: result.exitCode }
}

interface ResolvedProject {
  projectId: string
  scmProvider: ScmProvider
  repoId: string | null
  defaultBranch: string
  githubOwner: string | null
  githubRepo: string | null
  region: string
}

async function resolveProjectForStory(
  tenantId: string,
  storyId: string,
  db: typeof defaultDb = defaultDb,
): Promise<ResolvedProject | null> {
  // Most recent task → cost_ledger gives us the project the story was budgeted to.
  const taskRows = await db
    .select({ taskId: tasks.taskId })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.storyId, storyId)))
    .orderBy(desc(tasks.createdAt))
    .limit(1)
  const taskId = taskRows[0]?.taskId
  let projectId: string | null = null
  if (taskId) {
    const ledger = await db
      .select({ projectId: costLedger.projectId })
      .from(costLedger)
      .where(eq(costLedger.taskId, taskId))
      .orderBy(desc(costLedger.occurredAt))
      .limit(1)
    projectId = ledger[0]?.projectId ?? null
  }
  if (!projectId) {
    // Fall back: any project for this tenant — single-project tenants are common.
    const anyProj = await db
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(eq(projects.tenantId, tenantId))
      .limit(1)
    projectId = anyProj[0]?.projectId ?? null
  }
  if (!projectId) return null
  const projRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.tenantId, tenantId), eq(projects.projectId, projectId)))
    .limit(1)
  const p = projRows[0]
  if (!p) return null
  const provider = ((p as unknown as { scmProvider?: string | null }).scmProvider ?? 'internal') as ScmProvider
  const repoId =
    (p as unknown as { repoId?: string | null }).repoId ??
    ((p as unknown as { githubOwner?: string; githubRepo?: string }).githubOwner &&
    (p as unknown as { githubRepo?: string }).githubRepo
      ? `${(p as unknown as { githubOwner: string }).githubOwner}/${(p as unknown as { githubRepo: string }).githubRepo}`
      : null)
  return {
    projectId,
    scmProvider: provider,
    repoId,
    defaultBranch:
      (p as unknown as { githubDefaultBranch?: string }).githubDefaultBranch ?? 'main',
    githubOwner: (p as unknown as { githubOwner?: string | null }).githubOwner ?? null,
    githubRepo: (p as unknown as { githubRepo?: string | null }).githubRepo ?? null,
    region: process.env['AWS_REGION'] ?? 'us-east-1',
  }
}

function defaultScmClientFactory(provider: ScmProvider, repoId: string | null): ScmClient {
  const env = loadEnv()
  let githubClient: ReturnType<typeof createGithubClient> | undefined
  if (provider === 'github') {
    if (!env.GITHUB_API_TOKEN) {
      throw new Error('GITHUB_API_TOKEN not configured for github project')
    }
    githubClient = createGithubClient({ token: env.GITHUB_API_TOKEN })
  }
  return getScmClient({ scmProvider: provider, repoId }, { region: process.env['AWS_REGION'] ?? 'us-east-1', githubClient })
}

async function loadStoryHeader(
  tenantId: string,
  storyId: string,
  db: typeof defaultDb,
): Promise<{ title: string; description: string; redirectNote: string | null } | null> {
  const rows = await db
    .select({
      title: stories.title,
      description: stories.description,
      redirectNote: stories.redirectNote,
    })
    .from(stories)
    .where(and(eq(stories.tenantId, tenantId), eq(stories.storyId, storyId)))
    .limit(1)
  return rows[0] ?? null
}

async function loadAcceptanceCriteria(
  tenantId: string,
  storyId: string,
  db: typeof defaultDb,
): Promise<string[]> {
  const rows = await db
    .select({ ordinal: storyAcceptanceCriteria.ordinal, text: storyAcceptanceCriteria.text })
    .from(storyAcceptanceCriteria)
    .where(
      and(
        eq(storyAcceptanceCriteria.tenantId, tenantId),
        eq(storyAcceptanceCriteria.storyId, storyId),
      ),
    )
    .orderBy(storyAcceptanceCriteria.ordinal)
  return rows.map((r) => r.text)
}

function buildAgentPrompt(opts: {
  title: string
  description: string
  redirectNote: string | null
  acceptanceCriteria: string[]
}): string {
  const ac = opts.acceptanceCriteria.length
    ? opts.acceptanceCriteria.map((t, i) => `${i + 1}. ${t}`).join('\n')
    : '(no acceptance criteria recorded)'
  const redirect = opts.redirectNote
    ? `\n\nREVIEWER REDIRECT (must address):\n${opts.redirectNote}\n`
    : ''
  return [
    'You are an autonomous engineering agent working in a git worktree.',
    'Implement the user story below end-to-end. Follow the project conventions',
    'already present in the repo. Do not commit; the orchestrator will commit',
    'and open the PR for you. Stay under a 15-minute wall clock and a $25 budget.',
    '',
    `# Story: ${opts.title}`,
    '',
    opts.description,
    '',
    '## Acceptance criteria',
    ac,
    redirect,
  ].join('\n')
}

/**
 * Run the story → PR pipeline end-to-end.
 *
 * Idempotency: callers should not invoke this twice for the same runId — the
 * SQS consumer dedupes on message id. If a run is already terminal we no-op.
 */
export async function runStoryPr(
  input: RunStoryPrInput,
  deps: RunStoryPrDeps = {},
): Promise<RunStoryPrResult> {
  const db = defaultDb
  const log = logger.child({ tenant_id: input.tenantId, run_id: input.runId, story_id: input.storyId })
  let worktree: WorktreeHandle | null = null

  try {
    const existing = await loadRunById(input.tenantId, input.runId)
    if (!existing) {
      throw new Error(`story-pr-run not found: ${input.runId}`)
    }
    if (existing.status === 'succeeded' || existing.status === 'failed' || existing.status === 'cancelled') {
      log.info({ status: existing.status }, 'story-runs: run already terminal, skipping')
      return {
        prUrl: existing.prUrl,
        commitSha: existing.commitSha,
        status: existing.status === 'succeeded' ? 'succeeded' : 'failed',
      }
    }

    const story = await loadStoryHeader(input.tenantId, input.storyId, db)
    if (!story) throw new Error(`story not found: ${input.storyId}`)

    const project = await resolveProjectForStory(input.tenantId, input.storyId, db)
    if (!project) throw new Error('no project linkage for story; cannot resolve repo')
    if (!project.repoId) throw new Error('project has no repo configured')

    const scmFactory = deps.scmClientFactory ?? defaultScmClientFactory
    const scm = scmFactory(project.scmProvider, project.repoId)

    const branch = buildBranchName(input.storyId)

    // ---- cloning ----
    await setStatus(input.tenantId, input.runId, 'cloning')
    let cloneUrl: string
    try {
      cloneUrl = await scm.cloneUrl(project.repoId)
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'story-runs: cloneUrl failed; falling back to scaffold')
      cloneUrl = ''
    }
    if (cloneUrl) {
      try {
        worktree = await cloneRepo({
          cloneUrl,
          runId: input.runId,
          defaultBranch: project.defaultBranch,
          authHeader:
            project.scmProvider === 'github' && loadEnv().GITHUB_API_TOKEN
              ? `Basic ${Buffer.from(`x-access-token:${loadEnv().GITHUB_API_TOKEN}`).toString('base64')}`
              : undefined,
        })
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'story-runs: clone failed; scaffolding empty worktree')
        worktree = await scaffoldEmptyWorktree(input.runId)
      }
    } else {
      worktree = await scaffoldEmptyWorktree(input.runId)
    }

    // ---- branching ----
    await setStatus(input.tenantId, input.runId, 'branching')
    if (cloneUrl) {
      worktree = await checkoutBranch(worktree, branch)
    } else {
      worktree = { ...worktree, branch }
    }

    // ---- running_agent ----
    await setStatus(input.tenantId, input.runId, 'running_agent')
    const ac = await loadAcceptanceCriteria(input.tenantId, input.storyId, db)
    const prompt = buildAgentPrompt({
      title: story.title,
      description: story.description,
      redirectNote: story.redirectNote,
      acceptanceCriteria: ac,
    })
    const runAgent = deps.runAgent ?? defaultRunAgent
    const agentRes = await runAgent({ cwd: worktree.cwd, prompt })
    if (agentRes.exitCode !== 0) {
      throw new Error(`agent exited non-zero: ${agentRes.exitCode}`)
    }

    // ---- committing ----
    await setStatus(input.tenantId, input.runId, 'committing')
    if (cloneUrl) {
      // For real clones, only commit changed files.
      const changed = await hasChanges(worktree.cwd)
      if (!changed) {
        throw new Error('agent produced no changes')
      }
    }
    const files = await collectScmFiles(worktree.cwd)
    if (files.length === 0) {
      throw new Error('worktree empty after agent run')
    }
    const message = buildCommitMessage({
      storyId: input.storyId,
      title: story.title,
      redirectNote: story.redirectNote,
    })
    const { commitSha } = await scm.commitFiles(project.repoId, branch, files, message)

    // ---- pushing (no-op marker for UI clarity) ----
    await setStatus(input.tenantId, input.runId, 'pushing')

    // ---- opening_pr ----
    await setStatus(input.tenantId, input.runId, 'opening_pr')
    const prTitle = `feat(story-${input.storyId.replace(/-/g, '').slice(0, 8)}): ${story.title}`.slice(0, 100)
    const prBody = [
      `Closes story \`${input.storyId}\``,
      '',
      '## Acceptance criteria',
      ac.length ? ac.map((t) => `- [ ] ${t}`).join('\n') : '_(none recorded)_',
      '',
      '_Generated by Orbital story-pr pipeline._',
    ].join('\n')
    const { url: prUrl } = await scm.openPullRequest(
      project.repoId,
      branch,
      project.defaultBranch,
      prTitle,
      prBody,
    )

    // ---- diff stats ----
    let stats = { files: files.length, additions: 0, deletions: 0 }
    try {
      const diff = await scm.getDifferences(project.repoId, project.defaultBranch, branch)
      stats = reduceDiffStats(diff.files)
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'story-runs: getDifferences failed; using file count fallback')
    }

    // Tx-1: finalise the run.
    await finalizeSuccess({
      tenantId: input.tenantId,
      runId: input.runId,
      prUrl,
      commitSha,
      diffStats: stats,
    })
    // Tx-2: denormalize prUrl onto the story.
    await setStoryPrUrl(input.tenantId, input.storyId, prUrl)

    log.info({ pr_url: prUrl, commit: commitSha, ...stats }, 'story-runs: run succeeded')
    return { prUrl, commitSha, status: 'succeeded' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err: msg }, 'story-runs: run failed')
    try {
      await finalizeFailure(input.tenantId, input.runId, msg)
    } catch (finalizeErr) {
      log.error({ finalizeErr }, 'story-runs: finalizeFailure also failed')
    }
    return { prUrl: null, commitSha: null, status: 'failed', error: msg }
  } finally {
    await destroyWorktree(worktree)
  }
}
