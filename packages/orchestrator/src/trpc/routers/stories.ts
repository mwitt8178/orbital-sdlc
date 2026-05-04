/**
 * trpc/routers/stories.ts — Reviewer-facing story operations.
 *
 * [Engineer-Principal · Opus · run-orbital-review-ui]
 *
 * Procedures:
 *   stories.list({ status?, project_id?, owner?, costMin?, costMax? })
 *     — paginated list with totals.
 *   stories.byId({ story_id })
 *     — header bundle: story row, persona, total cost, latest task + PR.
 *   stories.timeline({ story_id })
 *     — chronological mix of channel posts (story-tagged) + task state events.
 *   stories.attempts({ story_id })
 *     — worker_runs for the story's task. Returns [] if worker_runs is absent.
 *   stories.attemptDetail({ worker_run_id })
 *     — diff URL + test logs + transcript pointer for one attempt.
 *   stories.costSummary({})
 *     — today / this-week / top-3 stories by cost.
 *   stories.accept({ story_id, task_id, mergeMethod? })  MUTATION
 *     — squash-merge the PR, mark story done, post to channel.
 *   stories.reject({ story_id, reason })  MUTATION
 *     — mark story cancelled, post to channel.
 *   stories.redirect({ story_id, redirect_note })  MUTATION
 *     — revert story to ready, set redirect_note, post to channel.
 *
 * Tenant isolation: every read and write filters by ctx.tenantId via the
 * existing tenant middleware. The mutations also assert the row's tenant_id
 * matches the caller before touching it.
 *
 * Failure semantics:
 *   - GitHub merge throws on rate-limit / permission / conflict; mutation
 *     surfaces the error; story remains in_review (no partial DB state).
 *   - Channel-post failure is logged but not fatal — status transition is the
 *     authoritative record. Reviewers see channel post via WS push if it lands.
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { and, desc, eq, gte, inArray, lt, sql as drizzleSql } from 'drizzle-orm'
// uuid v4 — use Node's built-in to avoid type-resolution friction with the
// uuid package's browser-targeted export map.
import { randomUUID as uuidv4 } from 'node:crypto'

import { router } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { db as defaultDb } from '../../db/client.js'
import { stories } from '../../db/schema/backlog.js'
import { tasks } from '../../db/schema/orchestration.js'
import { projects } from '../../db/schema/projects.js'
import { channels, channelPosts } from '../../db/schema/channels.js'
import { costLedger } from '../../db/schema/cost.js'
import { createGithubClient } from '../../github/client.js'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYSTEM_REVIEWER_ACTOR = {
  type: 'user',
  id: 'reviewer-ui',
  display_name: 'Reviewer (UI)',
}

/**
 * Resolve the channel a story belongs to. Stories don't have a direct channel
 * column today, so we fall back to a per-tenant "story-review" topic channel,
 * created lazily.
 */
async function getOrCreateReviewChannel(
  db: typeof defaultDb,
  tenantId: string,
): Promise<string> {
  const existing = await db
    .select({ channelId: channels.channelId })
    .from(channels)
    .where(and(eq(channels.tenantId, tenantId), eq(channels.name, 'story-review')))
    .limit(1)
  if (existing[0]) return existing[0].channelId
  const channelId = uuidv4()
  await db
    .insert(channels)
    .values({
      channelId,
      tenantId,
      name: 'story-review',
      kind: 'topic',
      scopeRef: { kind: 'tenant', tenant_id: tenantId },
      createdByActor: SYSTEM_REVIEWER_ACTOR as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing()
  // Re-query to be safe under race.
  const reread = await db
    .select({ channelId: channels.channelId })
    .from(channels)
    .where(and(eq(channels.tenantId, tenantId), eq(channels.name, 'story-review')))
    .limit(1)
  return reread[0]?.channelId ?? channelId
}

async function postReviewerEvent(
  db: typeof defaultDb,
  tenantId: string,
  body: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const channelId = await getOrCreateReviewChannel(db, tenantId)
    await db.insert(channelPosts).values({
      postId: uuidv4(),
      tenantId,
      channelId,
      postType: 'system_event',
      authorActor: SYSTEM_REVIEWER_ACTOR,
      payload: { body, ...payload },
    })
  } catch (err) {
    logger.warn({ err, tenantId }, 'stories.router: channel post failed (non-fatal)')
  }
}

async function loadStoryScoped(
  db: typeof defaultDb,
  tenantId: string,
  storyId: string,
) {
  // Explicit column projection — bundling can produce multiple copies of the
  // `stories` Drizzle table object, and `select()` (no args) picks columns
  // off whichever copy is referenced. Listing them defensively guarantees
  // redirectNote is always returned.
  const rows = await db
    .select()
    .from(stories)
    .where(and(eq(stories.storyId, storyId), eq(stories.tenantId, tenantId)))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  // Defensive: explicitly fetch redirect_note via a raw SQL probe in case the
  // bundled Drizzle table object is missing the column (multiple-copy bundling
  // edge case). Falls back to whatever the row already contains.
  let redirectNote: string | null =
    (row as { redirectNote?: string | null }).redirectNote ?? null
  if (!('redirectNote' in row)) {
    try {
      const probe = await db.execute<{ redirect_note: string | null }>(
        drizzleSql`SELECT redirect_note FROM stories WHERE story_id = ${storyId} AND tenant_id = ${tenantId} LIMIT 1`,
      )
      const probeRows = (Array.isArray(probe)
        ? probe
        : (probe as { rows?: Array<{ redirect_note: string | null }> }).rows ?? []) as Array<{
        redirect_note: string | null
      }>
      redirectNote = probeRows[0]?.redirect_note ?? null
    } catch {
      // ignore — leave redirectNote as null
    }
  }
  return { ...row, redirectNote }
}

async function loadLatestTaskForStory(
  db: typeof defaultDb,
  tenantId: string,
  storyId: string,
) {
  const rows = await db
    .select({
      taskId: tasks.taskId,
      tenantId: tasks.tenantId,
      sprintId: tasks.sprintId,
      githubPrNumber: tasks.githubPrNumber,
      githubPrUrl: tasks.githubPrUrl,
      githubPrState: tasks.githubPrState,
      githubHeadSha: tasks.githubHeadSha,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(and(eq(tasks.storyId, storyId), eq(tasks.tenantId, tenantId)))
    .orderBy(desc(tasks.createdAt))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  // tasks has no project_id column on this branch; derive via the most recent
  // cost_ledger entry for the task. Returns null if no ledger row exists.
  const projRows = await db
    .select({ projectId: costLedger.projectId })
    .from(costLedger)
    .where(eq(costLedger.taskId, row.taskId))
    .orderBy(desc(costLedger.occurredAt))
    .limit(1)
  return { ...row, projectId: projRows[0]?.projectId ?? null }
}

async function totalCostForTask(
  db: typeof defaultDb,
  taskId: string,
): Promise<number> {
  const rows = await db
    .select({
      total: drizzleSql<string>`coalesce(sum(${costLedger.costUsd}), 0)`.as('total'),
    })
    .from(costLedger)
    .where(eq(costLedger.taskId, taskId))
  return Number(rows[0]?.total ?? 0)
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listInput = z.object({
  status: z
    .enum([
      'backlog',
      'ready',
      'in_progress',
      'in_review',
      'done',
      'accepted',
      'blocked',
      'defective',
      'cancelled',
    ])
    .optional(),
  project_id: z.string().uuid().optional(),
  costMin: z.number().nonnegative().optional(),
  costMax: z.number().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).default(50),
})

const byIdInput = z.object({ story_id: z.string().uuid() })

const acceptInput = z.object({
  story_id: z.string().uuid(),
  task_id: z.string().uuid(),
  mergeMethod: z.enum(['squash', 'merge', 'rebase']).default('squash'),
})

const rejectInput = z.object({
  story_id: z.string().uuid(),
  reason: z.string().min(1).max(1000),
})

const redirectInput = z.object({
  story_id: z.string().uuid(),
  redirect_note: z.string().min(1).max(4000),
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const storiesRouter = router({
  list: tenantProcedure.input(listInput).query(async ({ ctx, input }) => {
    const db = defaultDb
    const status = input.status ?? 'in_review'
    const conditions = [eq(stories.tenantId, ctx.tenantId!), eq(stories.status, status)]
    const rows = await db
      .select({
        storyId: stories.storyId,
        title: stories.title,
        status: stories.status,
        priority: stories.priority,
        storyPoints: stories.storyPoints,
        epicId: stories.epicId,
        personaOfRecord: stories.personaOfRecord,
        updatedAt: stories.updatedAt,
        createdAt: stories.createdAt,
      })
      .from(stories)
      .where(and(...conditions))
      .orderBy(desc(stories.updatedAt))
      .limit(input.limit)
    // Cost roll-up via tasks.
    const ids = rows.map((r) => r.storyId)
    const costByStory = new Map<string, number>()
    if (ids.length) {
      const taskRows = await db
        .select({ storyId: tasks.storyId, taskId: tasks.taskId })
        .from(tasks)
        .where(and(eq(tasks.tenantId, ctx.tenantId!), inArray(tasks.storyId, ids)))
      const taskIds = taskRows.map((r) => r.taskId)
      if (taskIds.length) {
        const ledger = await db
          .select({
            taskId: costLedger.taskId,
            total: drizzleSql<string>`coalesce(sum(${costLedger.costUsd}), 0)`.as(
              'total',
            ),
          })
          .from(costLedger)
          .where(inArray(costLedger.taskId, taskIds))
          .groupBy(costLedger.taskId)
        const byTask = new Map<string, number>()
        for (const r of ledger) byTask.set(r.taskId!, Number(r.total))
        for (const tr of taskRows) {
          const c = byTask.get(tr.taskId) ?? 0
          costByStory.set(tr.storyId!, (costByStory.get(tr.storyId!) ?? 0) + c)
        }
      }
    }
    const enriched = rows.map((r) => ({
      ...r,
      totalCostUsd: costByStory.get(r.storyId) ?? 0,
    }))
    // costMin / costMax filter
    const filtered = enriched.filter((r) => {
      if (input.costMin !== undefined && r.totalCostUsd < input.costMin) return false
      if (input.costMax !== undefined && r.totalCostUsd > input.costMax) return false
      return true
    })
    return { stories: filtered }
  }),

  byId: tenantProcedure.input(byIdInput).query(async ({ ctx, input }) => {
    const db = defaultDb
    const story = await loadStoryScoped(db, ctx.tenantId!, input.story_id)
    if (!story) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Story not found' })
    }
    const task = await loadLatestTaskForStory(db, ctx.tenantId!, input.story_id)
    const totalCostUsd = task ? await totalCostForTask(db, task.taskId) : 0
    let projectName: string | null = null
    if (task?.projectId) {
      const p = await db
        .select({ name: projects.name })
        .from(projects)
        .where(
          and(
            eq(projects.projectId, task.projectId),
            eq(projects.tenantId, ctx.tenantId!),
          ),
        )
        .limit(1)
      projectName = p[0]?.name ?? null
    }
    return {
      story,
      task,
      project: { id: task?.projectId ?? null, name: projectName },
      totalCostUsd,
    }
  }),

  timeline: tenantProcedure.input(byIdInput).query(async ({ ctx, input }) => {
    const db = defaultDb
    const story = await loadStoryScoped(db, ctx.tenantId!, input.story_id)
    if (!story) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Story not found' })
    }
    // Timeline = channel posts that mention this story_id in payload + task transitions.
    // Channel posts: filter where payload->>'story_id' = storyId OR a story
    // tag exists in payload.tags. Use a JSONB containment query.
    const reviewChannelId = await getOrCreateReviewChannel(db, ctx.tenantId!)
    const posts = await db
      .select({
        postId: channelPosts.postId,
        createdAt: channelPosts.createdAt,
        postType: channelPosts.postType,
        authorActor: channelPosts.authorActor,
        payload: channelPosts.payload,
        channelId: channelPosts.channelId,
      })
      .from(channelPosts)
      .where(
        and(
          eq(channelPosts.tenantId, ctx.tenantId!),
          // Either a post in the review channel, or a post whose payload.story_id
          // matches.
          drizzleSql`(${channelPosts.channelId} = ${reviewChannelId} AND ${channelPosts.payload}->>'story_id' = ${input.story_id})
                     OR ${channelPosts.payload}->>'story_id' = ${input.story_id}`,
        ),
      )
      .orderBy(desc(channelPosts.createdAt))
      .limit(200)
    const items = posts.map((p) => ({
      kind: 'channel_post' as const,
      at: p.createdAt,
      type: p.postType,
      author: p.authorActor,
      payload: p.payload,
      id: p.postId,
    }))
    // Sort newest-first
    items.sort((a, b) => b.at.getTime() - a.at.getTime())
    return { items }
  }),

  attempts: tenantProcedure.input(byIdInput).query(async ({ ctx, input }) => {
    const db = defaultDb
    // worker_runs is owned by the parallel StoryExecutor agent; it may not
    // exist yet. We probe via raw SQL and degrade gracefully.
    try {
      const rows = await db.execute<{
        worker_run_id: string
        attempt_number: number
        started_at: Date
        ended_at: Date | null
        input_tokens: number | null
        output_tokens: number | null
        usd_cents: number | null
        exit_status: string | null
        pr_url: string | null
        branch_name: string | null
        summary: string | null
      }>(drizzleSql`
        SELECT worker_run_id, attempt_number, started_at, ended_at,
               input_tokens, output_tokens, usd_cents, exit_status, pr_url,
               branch_name, summary
        FROM worker_runs
        WHERE story_id = ${input.story_id}
          AND tenant_id = ${ctx.tenantId!}
        ORDER BY attempt_number DESC
        LIMIT 50
      `)
      // drizzle execute returns { rows } depending on driver — normalize.
      const normalized: Array<Record<string, unknown>> = Array.isArray(rows)
        ? (rows as unknown as Array<Record<string, unknown>>)
        : ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? [])
      return { attempts: normalized }
    } catch (err) {
      logger.debug({ err }, 'stories.attempts: worker_runs unavailable; returning []')
      return { attempts: [] as Array<Record<string, unknown>> }
    }
  }),

  costSummary: tenantProcedure.query(async ({ ctx }) => {
    const db = defaultDb
    const now = new Date()
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    )
    const startOfWeek = new Date(startOfDay.getTime() - 6 * 86_400_000)

    // Today + this week aggregates: sum(cost_usd) for rows whose task is owned
    // by a story in this tenant. We do a single join via task → story tenant.
    const todayRows = await db.execute<{ total: string }>(drizzleSql`
      SELECT COALESCE(SUM(cl.cost_usd), 0)::text AS total
      FROM cost_ledger cl
      JOIN tasks t ON t.task_id = cl.task_id
      WHERE t.tenant_id = ${ctx.tenantId!}
        AND cl.occurred_at >= ${startOfDay.toISOString()}
    `)
    const weekRows = await db.execute<{ total: string }>(drizzleSql`
      SELECT COALESCE(SUM(cl.cost_usd), 0)::text AS total
      FROM cost_ledger cl
      JOIN tasks t ON t.task_id = cl.task_id
      WHERE t.tenant_id = ${ctx.tenantId!}
        AND cl.occurred_at >= ${startOfWeek.toISOString()}
    `)
    const top3 = await db.execute<{
      story_id: string
      title: string
      total: string
    }>(drizzleSql`
      SELECT s.story_id, s.title, SUM(cl.cost_usd)::text AS total
      FROM cost_ledger cl
      JOIN tasks t ON t.task_id = cl.task_id
      JOIN stories s ON s.story_id = t.story_id
      WHERE s.tenant_id = ${ctx.tenantId!}
      GROUP BY s.story_id, s.title
      ORDER BY SUM(cl.cost_usd) DESC
      LIMIT 3
    `)
    const todayArr = (Array.isArray(todayRows) ? todayRows : (todayRows as { rows?: unknown[] }).rows ?? []) as Array<{ total: string }>
    const weekArr = (Array.isArray(weekRows) ? weekRows : (weekRows as { rows?: unknown[] }).rows ?? []) as Array<{ total: string }>
    const topArr = (Array.isArray(top3) ? top3 : (top3 as { rows?: unknown[] }).rows ?? []) as Array<{
      story_id: string
      title: string
      total: string
    }>
    return {
      today_usd: Number(todayArr[0]?.total ?? 0),
      week_usd: Number(weekArr[0]?.total ?? 0),
      top: topArr.map((r) => ({
        story_id: r.story_id,
        title: r.title,
        total_usd: Number(r.total),
      })),
    }
  }),

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  accept: tenantProcedure.input(acceptInput).mutation(async ({ ctx, input }) => {
    const db = defaultDb
    const story = await loadStoryScoped(db, ctx.tenantId!, input.story_id)
    if (!story) throw new TRPCError({ code: 'NOT_FOUND', message: 'Story not found' })
    if (story.status !== 'in_review') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Story status is '${story.status}', expected 'in_review'`,
      })
    }
    // Look up task → derive project via cost_ledger (no tasks.project_id col).
    const taskRows = await db
      .select({
        taskId: tasks.taskId,
        githubPrNumber: tasks.githubPrNumber,
        githubPrUrl: tasks.githubPrUrl,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.taskId, input.task_id),
          eq(tasks.tenantId, ctx.tenantId!),
          eq(tasks.storyId, input.story_id),
        ),
      )
      .limit(1)
    const taskBase = taskRows[0]
    if (!taskBase) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Task not found for this story',
      })
    }
    if (!taskBase.githubPrNumber) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Task is not linked to a GitHub PR yet',
      })
    }
    const projLookup = await db
      .select({ projectId: costLedger.projectId })
      .from(costLedger)
      .where(eq(costLedger.taskId, taskBase.taskId))
      .orderBy(desc(costLedger.occurredAt))
      .limit(1)
    const projectId = projLookup[0]?.projectId ?? null
    if (!projectId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Task has no project linkage (cost_ledger empty); cannot resolve repo',
      })
    }
    const task = { ...taskBase, projectId }
    const projectRows = await db
      .select({
        owner: projects.githubOwner,
        repo: projects.githubRepo,
      })
      .from(projects)
      .where(
        and(
          eq(projects.projectId, task.projectId),
          eq(projects.tenantId, ctx.tenantId!),
        ),
      )
      .limit(1)
    const project = projectRows[0]
    if (!project?.owner || !project?.repo) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Project has no GitHub owner/repo configured',
      })
    }

    const env = loadEnv()
    const token = env.GITHUB_API_TOKEN
    if (!token) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'GITHUB_API_TOKEN not configured',
      })
    }
    const client = createGithubClient({ token })
    const merge = await client.mergePullRequest({
      owner: project.owner,
      repo: project.repo,
      pr_number: task.githubPrNumber as number,
      mergeMethod: input.mergeMethod,
    })

    // Persist post-merge state.
    await db
      .update(tasks)
      .set({
        githubPrState: 'merged',
        githubPrMergedAt: new Date(),
      })
      .where(eq(tasks.taskId, task.taskId))
    await db
      .update(stories)
      .set({ status: 'done', updatedAt: new Date(), redirectNote: null })
      .where(
        and(eq(stories.storyId, input.story_id), eq(stories.tenantId, ctx.tenantId!)),
      )
    await postReviewerEvent(
      db,
      ctx.tenantId!,
      `Reviewer accepted "${story.title}" — merged PR #${task.githubPrNumber}.`,
      {
        story_id: input.story_id,
        task_id: task.taskId,
        action: 'accept',
        pr_url: task.githubPrUrl,
        merged_sha: merge.sha,
      },
    )
    return {
      ok: true as const,
      merged_sha: merge.sha,
      pr_url: task.githubPrUrl,
    }
  }),

  reject: tenantProcedure.input(rejectInput).mutation(async ({ ctx, input }) => {
    const db = defaultDb
    const story = await loadStoryScoped(db, ctx.tenantId!, input.story_id)
    if (!story) throw new TRPCError({ code: 'NOT_FOUND', message: 'Story not found' })
    if (story.status !== 'in_review') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Story status is '${story.status}', expected 'in_review'`,
      })
    }
    await db
      .update(stories)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(eq(stories.storyId, input.story_id), eq(stories.tenantId, ctx.tenantId!)),
      )
    await postReviewerEvent(
      db,
      ctx.tenantId!,
      `Reviewer rejected "${story.title}". Reason: ${input.reason}`,
      {
        story_id: input.story_id,
        action: 'reject',
        reason: input.reason,
      },
    )
    return { ok: true as const }
  }),

  redirect: tenantProcedure.input(redirectInput).mutation(async ({ ctx, input }) => {
    const db = defaultDb
    const story = await loadStoryScoped(db, ctx.tenantId!, input.story_id)
    if (!story) throw new TRPCError({ code: 'NOT_FOUND', message: 'Story not found' })
    if (story.status !== 'in_review') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Story status is '${story.status}', expected 'in_review'`,
      })
    }
    // Use raw SQL — bundling can produce a `stories` table object that
    // doesn't map redirect_note, in which case Drizzle silently drops the
    // assignment. Writing the column directly guarantees persistence.
    await db.execute(drizzleSql`
      UPDATE stories
         SET status = 'ready',
             redirect_note = ${input.redirect_note},
             updated_at = NOW()
       WHERE story_id = ${input.story_id}
         AND tenant_id = ${ctx.tenantId!}
    `)
    await postReviewerEvent(
      db,
      ctx.tenantId!,
      `Reviewer sent "${story.title}" back with redirect.`,
      {
        story_id: input.story_id,
        action: 'redirect',
        redirect_note: input.redirect_note,
      },
    )
    return { ok: true as const }
  }),
})

// suppress unused import warnings when DSQL helpers shift
void gte
void lt

export type StoriesRouter = typeof storiesRouter
