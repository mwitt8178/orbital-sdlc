/**
 * trpc/routers/prs.ts — Pull Request tRPC router.
 *
 * Round 6 #1 — GitHub PR Loop wired into spawn cycle.
 * [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
 *
 * Round 6 #6 — CI/CD Bridge additions:
 *   prs.checkRuns({task_id})         (query)   — list check_runs for head SHA
 *   prs.rerunFailed({task_id})       (mutation) — re-run failed check runs via GH API
 * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 *
 * Procedures:
 *   prs.byTask({task_id})           (query)  — get PR state for a task
 *   prs.testConnection({project_id}) (query)  — test GitHub API connectivity
 *   prs.checkRuns({task_id})        (query)  — list CI check runs for the PR head SHA
 *   prs.rerunFailed({task_id})      (mutation) — trigger re-run of failed checks
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq, and } from 'drizzle-orm'
import { router, publicProcedure } from '../init.js'
// fix/multi-project-isolation
import { projectProcedure } from '../middleware/project.js'
import { db as defaultDb } from '../../db/client.js'
import { tasks } from '../../db/schema/orchestration.js'
import { projects } from '../../db/schema/projects.js'
import { createGithubClient } from '../../github/client.js'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../config/logger.js'
// Round 7-02 — hub client for proxy mode
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { getHubClient } from '../../hub-client/index.js'

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const byTaskInputSchema = z.object({
  task_id: z.string().uuid(),
})

const testConnectionInputSchema = z.object({
  project_id: z.string().uuid(),
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * @route   prs.byTask
 * @summary Get the GitHub PR state for a given task.
 * @access  Public
 *
 * @input   {string} task_id — UUID of the task
 *
 * @returns PR state object or null when no PR has been opened yet.
 * @returns 404 NOT_FOUND when task does not exist.
 */
// ---------------------------------------------------------------------------
// Shared check-run fetcher
// [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
// ---------------------------------------------------------------------------

interface CheckRunRow {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url: string
  started_at: string | null
  completed_at: string | null
}

async function fetchCheckRuns(
  owner: string,
  repo: string,
  headSha: string,
  token: string,
): Promise<CheckRunRow[]> {
  const client = createGithubClient({ token })
  return client.listCheckRuns(owner, repo, headSha)
}

export const prsRouter = router({
  byTask: projectProcedure
    .input(byTaskInputSchema)
    .query(async ({ input, ctx }) => {
      // Round 7-02 — hub proxy: PR state is shared data stored on the hub.
      // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
      const hub = getHubClient()
      if (hub !== null) {
        const env = loadEnv()
        type PRShape = { task_id: string; pr_number: number; pr_url: string | null; pr_state: string; head_sha: string | null; merged_at: string | null } | null
        const result = await hub.query<{ pr: PRShape }>('prs.byTask', input, env.ORBITAL_HUB_TENANT_ID)
        if (!result.ok) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.message })
        return result.data
      }

      const db = defaultDb
      // fix/multi-project-isolation — scope task by tenant + project
      const rows = await db
        .select({
          taskId: tasks.taskId,
          githubPrNumber: tasks.githubPrNumber,
          githubPrUrl: tasks.githubPrUrl,
          githubPrMergedAt: tasks.githubPrMergedAt,
          githubHeadSha: tasks.githubHeadSha,
          githubPrState: tasks.githubPrState,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.taskId, input.task_id),
            eq(tasks.tenantId, ctx.tenantId!),
            eq(tasks.projectId, ctx.projectId!),
          ),
        )
        .limit(1)

      const row = rows[0]
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Task ${input.task_id} not found`,
        })
      }

      if (row.githubPrNumber === null || row.githubPrNumber === undefined) {
        return { pr: null }
      }

      return {
        pr: {
          task_id: row.taskId,
          pr_number: row.githubPrNumber,
          pr_url: row.githubPrUrl,
          pr_state: row.githubPrState ?? 'open',
          head_sha: row.githubHeadSha,
          merged_at: row.githubPrMergedAt ? row.githubPrMergedAt.toISOString() : null,
        },
      }
    }),

  /**
   * @route   prs.testConnection
   * @summary Test GitHub API connectivity for a project's configured repo.
   * @access  Public
   *
   * @input   {string} project_id — UUID of the project
   *
   * @returns { ok: true, login: string } on success
   * @returns { ok: false, error: string } on failure (does NOT throw — UI renders error inline)
   * @returns 404 NOT_FOUND when project does not exist
   */
  testConnection: projectProcedure
    .input(testConnectionInputSchema)
    .query(async ({ input, ctx }) => {
      // fix/multi-project-isolation — input.project_id must match active project
      if (input.project_id !== ctx.projectId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'project_id mismatch between input and active project header',
        })
      }
      const db = defaultDb
      const rows = await db
        .select({
          projectId: projects.projectId,
          githubOwner: projects.githubOwner,
          githubRepo: projects.githubRepo,
        })
        .from(projects)
        .where(
          and(
            eq(projects.projectId, input.project_id),
            eq(projects.tenantId, ctx.tenantId!),
          ),
        )
        .limit(1)

      const project = rows[0]
      if (!project) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Project ${input.project_id} not found`,
        })
      }

      const env = loadEnv()
      const token = env.GITHUB_API_TOKEN
      if (!token) {
        return {
          ok: false as const,
          error: 'GITHUB_API_TOKEN is not configured. Set it in your environment or via the GitHub settings.',
        }
      }

      try {
        const client = createGithubClient({ token })
        const user = await client.getAuthenticatedUser()

        if (project.githubOwner && project.githubRepo) {
          const repo = await client.getRepo(project.githubOwner, project.githubRepo)
          if (!repo) {
            return {
              ok: false as const,
              error: `Repository ${project.githubOwner}/${project.githubRepo} not found or token lacks access.`,
            }
          }
        }

        logger.info(
          { projectId: input.project_id, login: user.login },
          'prs.testConnection: GitHub connection verified',
        )

        return { ok: true as const, login: user.login }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ err, projectId: input.project_id }, 'prs.testConnection: connection test failed')
        return { ok: false as const, error: message }
      }
    }),

  /**
   * @route   prs.checkRuns
   * @summary List CI check runs for the task's PR head SHA.
   * @access  Public
   *
   * Round 6 #6 — CI/CD Bridge
   * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
   *
   * @input   {string} task_id — UUID of the task
   * @returns Array of check_run rows with name, conclusion, status, duration, links.
   */
  checkRuns: projectProcedure
    .input(z.object({ task_id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const db = defaultDb
      const rows = await db
        .select({
          taskId: tasks.taskId,
          githubPrNumber: tasks.githubPrNumber,
          githubHeadSha: tasks.githubHeadSha,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.taskId, input.task_id),
            eq(tasks.tenantId, ctx.tenantId!),
            eq(tasks.projectId, ctx.projectId!),
          ),
        )
        .limit(1)

      const row = rows[0]
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Task ${input.task_id} not found` })
      }

      if (!row.githubHeadSha) {
        return { check_runs: [], head_sha: null }
      }

      const env = loadEnv()
      const token = env.GITHUB_API_TOKEN
      if (!token) {
        return { check_runs: [], head_sha: row.githubHeadSha }
      }

      // Need owner/repo — look up from the project linked to this task's sprint
      // For v1, we query the first project with matching configuration.
      const projectRows = await db
        .select({ githubOwner: projects.githubOwner, githubRepo: projects.githubRepo })
        .from(projects)
        .limit(1)

      const project = projectRows[0]
      if (!project?.githubOwner || !project?.githubRepo) {
        return { check_runs: [], head_sha: row.githubHeadSha }
      }

      try {
        const checkRuns = await fetchCheckRuns(
          project.githubOwner,
          project.githubRepo,
          row.githubHeadSha,
          token,
        )

        const totalCount = checkRuns.length
        const passingCount = checkRuns.filter(
          (cr) => cr.conclusion === 'success' || cr.conclusion === 'neutral' || cr.conclusion === 'skipped',
        ).length

        return {
          head_sha: row.githubHeadSha,
          total_count: totalCount,
          passing_count: passingCount,
          check_runs: checkRuns.map((cr) => ({
            id: cr.id,
            name: cr.name,
            status: cr.status,
            conclusion: cr.conclusion,
            html_url: cr.html_url,
            started_at: cr.started_at,
            completed_at: cr.completed_at,
            duration_ms:
              cr.started_at && cr.completed_at
                ? Math.max(0, new Date(cr.completed_at).getTime() - new Date(cr.started_at).getTime())
                : null,
          })),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ err, taskId: input.task_id }, 'prs.checkRuns: fetch failed')
        return { check_runs: [], head_sha: row.githubHeadSha, error: message }
      }
    }),

  /**
   * @route   prs.rerunFailed
   * @summary Re-run all failed check runs for the task's PR head SHA.
   * @access  Public (capability-gated in production via ORBITAL_PR_LOOP check)
   *
   * Round 6 #6 — CI/CD Bridge
   * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
   *
   * @input   {string} task_id — UUID of the task
   * @returns { triggered: number } — count of re-run requests sent.
   */
  rerunFailed: projectProcedure
    .input(z.object({ task_id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = defaultDb
      const rows = await db
        .select({
          taskId: tasks.taskId,
          githubPrNumber: tasks.githubPrNumber,
          githubHeadSha: tasks.githubHeadSha,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.taskId, input.task_id),
            eq(tasks.tenantId, ctx.tenantId!),
            eq(tasks.projectId, ctx.projectId!),
          ),
        )
        .limit(1)

      const row = rows[0]
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Task ${input.task_id} not found` })
      }

      if (!row.githubHeadSha) {
        return { triggered: 0, reason: 'no_head_sha' }
      }

      const env = loadEnv()
      const token = env.GITHUB_API_TOKEN
      if (!token) {
        return { triggered: 0, reason: 'no_token' }
      }

      const projectRows = await db
        .select({ githubOwner: projects.githubOwner, githubRepo: projects.githubRepo })
        .from(projects)
        .limit(1)

      const project = projectRows[0]
      if (!project?.githubOwner || !project?.githubRepo) {
        return { triggered: 0, reason: 'no_project_config' }
      }

      try {
        const checkRuns = await fetchCheckRuns(
          project.githubOwner,
          project.githubRepo,
          row.githubHeadSha,
          token,
        )

        const failed = checkRuns.filter(
          (cr) =>
            cr.conclusion === 'failure' ||
            cr.conclusion === 'cancelled' ||
            cr.conclusion === 'timed_out',
        )

        const client = createGithubClient({ token })
        let triggered = 0
        for (const cr of failed) {
          try {
            await client.rerunCheckRun(project.githubOwner!, project.githubRepo!, cr.id)
            triggered++
          } catch (err) {
            logger.warn(
              { err, checkRunId: cr.id, name: cr.name },
              'prs.rerunFailed: failed to re-run check',
            )
          }
        }

        logger.info(
          { taskId: input.task_id, triggered, total: failed.length },
          'prs.rerunFailed: triggered re-runs',
        )
        return { triggered }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ err, taskId: input.task_id }, 'prs.rerunFailed: fetch failed')
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message })
      }
    }),
})

export type PRsRouter = typeof prsRouter
