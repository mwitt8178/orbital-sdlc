/**
 * story-runs/repo.ts — DB access for the story_pr_runs aggregate.
 *
 * [Engineer-Principal · Opus · run-story-pr-pipeline]
 *
 * All mutations go through OCC retry per aws-dsql-constraints. Each
 * transition is a single-row update; story side-effects (stories.pr_url)
 * are separate transactions.
 */

import { and, desc, eq } from 'drizzle-orm'
import { db as defaultDb } from '../db/client.js'
import { storyPrRuns, type StoryPrRunRow, type StoryPrRunStatus, type StoryPrRunDiffStats } from '../db/schema/story-pr-runs.js'
import { stories } from '../db/schema/backlog.js'
import { logger } from '../config/logger.js'

export type Db = typeof defaultDb

function isSerializationFailure(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '40001'
}

export async function withOccRetry<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isSerializationFailure(err)) throw err
      const backoff = 50 * Math.pow(2, attempt) + Math.floor(Math.random() * 50)
      logger.warn({ attempt: attempt + 1, backoff }, 'story-runs: OCC retry')
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
  throw lastErr
}

export interface InsertStoryRunInput {
  id: string
  tenantId: string
  storyId: string
  projectId: string | null
  branch: string
}

export async function insertRun(
  input: InsertStoryRunInput,
  db: Db = defaultDb,
): Promise<StoryPrRunRow> {
  return withOccRetry(async () => {
    const [row] = await db
      .insert(storyPrRuns)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        storyId: input.storyId,
        projectId: input.projectId,
        branch: input.branch,
        status: 'queued',
      })
      .returning()
    if (!row) throw new Error('story-runs: insert returned no row')
    return row
  })
}

export async function setStatus(
  tenantId: string,
  runId: string,
  status: StoryPrRunStatus,
  db: Db = defaultDb,
): Promise<void> {
  await withOccRetry(async () => {
    await db
      .update(storyPrRuns)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(storyPrRuns.tenantId, tenantId), eq(storyPrRuns.id, runId)))
  })
}

export interface FinalizeSuccessInput {
  tenantId: string
  runId: string
  prUrl: string
  commitSha: string
  diffStats: StoryPrRunDiffStats
}

export async function finalizeSuccess(input: FinalizeSuccessInput, db: Db = defaultDb): Promise<void> {
  await withOccRetry(async () => {
    await db
      .update(storyPrRuns)
      .set({
        status: 'succeeded',
        prUrl: input.prUrl,
        commitSha: input.commitSha,
        diffStats: input.diffStats,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(storyPrRuns.tenantId, input.tenantId), eq(storyPrRuns.id, input.runId)))
  })
}

export async function finalizeFailure(
  tenantId: string,
  runId: string,
  error: string,
  db: Db = defaultDb,
): Promise<void> {
  await withOccRetry(async () => {
    await db
      .update(storyPrRuns)
      .set({
        status: 'failed',
        diffStats: { error },
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(storyPrRuns.tenantId, tenantId), eq(storyPrRuns.id, runId)))
  })
}

export async function setStoryPrUrl(
  tenantId: string,
  storyId: string,
  prUrl: string,
  db: Db = defaultDb,
): Promise<void> {
  await withOccRetry(async () => {
    await db
      .update(stories)
      .set({ prUrl, updatedAt: new Date() })
      .where(and(eq(stories.tenantId, tenantId), eq(stories.storyId, storyId)))
  })
}

export async function loadRunById(
  tenantId: string,
  runId: string,
  db: Db = defaultDb,
): Promise<StoryPrRunRow | null> {
  const rows = await db
    .select()
    .from(storyPrRuns)
    .where(and(eq(storyPrRuns.tenantId, tenantId), eq(storyPrRuns.id, runId)))
    .limit(1)
  return rows[0] ?? null
}

export async function loadLatestForStory(
  tenantId: string,
  storyId: string,
  db: Db = defaultDb,
): Promise<StoryPrRunRow | null> {
  const rows = await db
    .select()
    .from(storyPrRuns)
    .where(and(eq(storyPrRuns.tenantId, tenantId), eq(storyPrRuns.storyId, storyId)))
    .orderBy(desc(storyPrRuns.startedAt))
    .limit(1)
  return rows[0] ?? null
}
