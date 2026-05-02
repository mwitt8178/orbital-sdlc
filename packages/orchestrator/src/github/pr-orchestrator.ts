/**
 * github/pr-orchestrator.ts — Subscribes to task lifecycle events and manages
 * GitHub pull requests: open on TaskCompleted, label on verifier outcome.
 *
 * Per Round 5D spec §2.
 *
 * Lifecycle:
 *   TaskCompleted  → git push + createPR → store pr_number on task → emit PROpened
 *   VerifierPassed → addLabels(['verified-by-orbital'])
 *   VerifierFailed → addLabels(['orbital-verifier-failed'])
 *   PROpened       → post system message + create reviewer task (Round 6 #2)
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 * New methods: postReviewComment, submitReview.
 * PROpened event triggers onPROpened hook (creates reviewer child task).
 *
 * The orchestrator is intentionally fire-and-forget from the subscriber
 * perspective: errors are logged but never re-thrown so they cannot crash the
 * EventStore subscription loop.
 */

import { spawnSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { GithubClient } from './client.js'
import { tasks, worktrees } from '../db/schema/orchestration.js'
import { stories, storyAcceptanceCriteria, sprints } from '../db/schema/backlog.js'
import { projects } from '../db/schema/projects.js'
import { buildPRBody } from './pr-body-builder.js'
import { logger } from '../config/logger.js'
import type { EventEnvelope } from '../events/types.js'
// Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
// [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
import { onPROpened as onPROpenedCreateReviewTask } from '../hooks/post-pr-opened.js'
import { onCodeReviewSubmitted } from '../hooks/post-review-submitted.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubPROrchestratorOptions {
  db: DB
  eventStore: EventStore
  githubClient: GithubClient
  /** GitHub API token — used to inject credentials into the push URL. */
  githubToken: string
  /**
   * Round 7-08 — Operator-Attributed UI
   * Display name of the local install (e.g. "matt-laptop").
   * When present, embedded in PR review comment bodies and PR footers.
   * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
   */
  installDisplayName?: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GitHubPROrchestrator {
  private unsubscribe: (() => void) | null = null

  constructor(private readonly opts: GitHubPROrchestratorOptions) {}

  start(): void {
    if (this.unsubscribe !== null) return
    this.unsubscribe = this.opts.eventStore.subscribe(null, (envelope) => {
      void this.handleEvent(envelope).catch((err: unknown) => {
        logger.error(
          { err, eventType: envelope.event_type, eventId: envelope.event_id },
          'GitHubPROrchestrator: unhandled error in handleEvent',
        )
      })
    })
    logger.info('GitHubPROrchestrator: started')
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    logger.info('GitHubPROrchestrator: stopped')
  }

  // -------------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------------

  private async handleEvent(envelope: EventEnvelope): Promise<void> {
    switch (envelope.event_type) {
      case 'TaskCompleted':
        await this.onTaskCompleted(envelope)
        break
      case 'VerifierPassed':
        await this.onVerifierResult(envelope, ['verified-by-orbital'])
        break
      case 'VerifierFailed':
        await this.onVerifierResult(envelope, ['orbital-verifier-failed'])
        break
      case 'PROpened':
        await this.onPROpened(envelope)
        break
      // Round 6 #2 — handle review submission
      // [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
      case 'CodeReviewSubmitted':
        await this.onCodeReviewSubmitted(envelope)
        break
    }
  }

  // -------------------------------------------------------------------------
  // TaskCompleted → git push + open PR
  // -------------------------------------------------------------------------

  private async onTaskCompleted(envelope: EventEnvelope): Promise<void> {
    const taskId = envelope.aggregate_id
    const { db, githubClient, eventStore, githubToken } = this.opts

    // 1. Load the task row
    const [taskRow] = await db.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1)
    if (!taskRow) {
      logger.warn({ taskId }, 'GitHubPROrchestrator.onTaskCompleted: task not found')
      return
    }

    // 2. If PR already opened (retry safety) — skip
    if (taskRow.githubPrNumber !== null && taskRow.githubPrNumber !== undefined) {
      logger.debug({ taskId, prNumber: taskRow.githubPrNumber }, 'GitHubPROrchestrator: PR already exists; skipping')
      return
    }

    // 3. Load worktree
    const [worktreeRow] = await db
      .select()
      .from(worktrees)
      .where(eq(worktrees.taskId, taskId))
      .limit(1)
    if (!worktreeRow) {
      logger.warn({ taskId }, 'GitHubPROrchestrator.onTaskCompleted: no worktree found')
      return
    }

    // 4. Load project via sprint → find matching project
    //    Story → sprint → project lookup chain
    const storyId = taskRow.storyId
    const sprintId = taskRow.sprintId

    // Attempt to get project through sprint's stories
    let githubOwner: string | null = null
    let githubRepo: string | null = null
    let githubDefaultBranch = 'main'

    // Try to get project from story's epic → project lookup, or fall back to
    // the first project row that has github_owner set.
    // Load all projects and find the first one that has GitHub connected.
    // In most installs there is a single project. If storyId is set a more
    // precise lookup via epic.project_id would be more accurate — deferred
    // as a future improvement when the project_id FK is consistently populated.
    const allProjects = await db.select().from(projects)
    const connectedProject = allProjects.find(
      (p) => p.githubOwner !== null && p.githubRepo !== null,
    ) ?? null

    if (!connectedProject) {
      logger.warn(
        { taskId, sprintId },
        'GitHubPROrchestrator.onTaskCompleted: no GitHub-connected project found; skipping PR',
      )
      return
    }
    githubOwner = connectedProject.githubOwner!
    githubRepo = connectedProject.githubRepo!
    githubDefaultBranch = connectedProject.githubDefaultBranch ?? 'main'

    // 5. git push origin <branch>
    const branchName = worktreeRow.branchName
    const worktreePath = worktreeRow.path

    // 5a. Resolve head SHA before push (needed for BranchPushed event + CI re-run)
    let headSha: string | undefined
    try {
      const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      })
      if (shaResult.status === 0 && shaResult.stdout) {
        headSha = shaResult.stdout.trim()
      }
    } catch {
      // best-effort; continue without SHA
    }

    // Check for remote availability before attempting push — fail clearly
    const remoteCheckResult = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    })
    if (remoteCheckResult.status !== 0) {
      logger.error(
        { taskId, worktreePath },
        'GitHubPROrchestrator: git remote "origin" is not configured in the worktree. ' +
          'Configure a GitHub remote and set ORBITAL_PR_LOOP=on. ' +
          'See Settings → GitHub to connect a repo.',
      )
      return
    }

    // Determine the push remote URL. If origin points to a github.com URL, inject
    // the token for authentication. If origin is already a local path (e.g. in
    // tests or CI with a pre-configured remote), push to origin directly.
    const remoteUrlRaw = (remoteCheckResult.stdout ?? '').trim()
    const isGithubRemote = remoteUrlRaw.includes('github.com')
    const pushRemote = isGithubRemote
      ? `https://x-access-token:${githubToken}@github.com/${githubOwner}/${githubRepo}.git`
      : 'origin'

    const pushResult = spawnSync(
      'git',
      ['push', '--force-with-lease', pushRemote, `${branchName}:${branchName}`],
      {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    )

    if (pushResult.status !== 0) {
      const stderr = pushResult.stderr ?? ''
      logger.error(
        { taskId, branchName, worktreePath, stderr },
        'GitHubPROrchestrator: git push failed',
      )
      // Emit a system event but do not retry — operator must investigate.
      await eventStore.append({
        aggregate_id: taskId,
        aggregate_type: 'task',
        event_type: 'PRPushFailed',
        payload: { task_id: taskId, branch: branchName, stderr: stderr.slice(0, 500) },
        actor: { type: 'system', component: 'orchestrator' },
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })
      return
    }

    logger.info({ taskId, branchName }, 'GitHubPROrchestrator: git push succeeded')

    // 5b. Emit BranchPushed event
    // [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
    await eventStore.append({
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'BranchPushed',
      payload: {
        task_id: taskId,
        branch: branchName,
        head_sha: headSha ?? '',
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: envelope.trace_id,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    logger.info({ taskId, branchName, headSha }, 'GitHubPROrchestrator: BranchPushed emitted')

    // 6. Build PR body
    let prBody = `## Task\nTask ${taskId}\n\nAutomatically opened by Orbital.`
    try {
      prBody = await this.buildBody({ taskRow, storyId, sprintId })
    } catch (err) {
      logger.warn({ err, taskId }, 'GitHubPROrchestrator: PR body build failed; using fallback')
    }

    // 7. Create PR
    const prTitle = taskRow.title || `Task ${taskId.slice(0, 8)}`
    let prNumber: number
    let htmlUrl: string
    try {
      const result = await githubClient.createPullRequest({
        owner: githubOwner,
        repo: githubRepo,
        head: branchName,
        base: githubDefaultBranch,
        title: prTitle,
        body: prBody,
      })
      prNumber = result.pr_number
      htmlUrl = result.html_url
    } catch (err) {
      logger.error({ err, taskId, branchName }, 'GitHubPROrchestrator: createPullRequest failed')
      return
    }

    // 8. Store PR number / url / head_sha / pr_state on task row
    // [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
    await db
      .update(tasks)
      .set({
        githubPrNumber: prNumber,
        githubPrUrl: htmlUrl,
        githubHeadSha: headSha ?? null,
        githubPrState: 'open',
      })
      .where(eq(tasks.taskId, taskId))

    // 9. Emit PROpened
    await eventStore.append({
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'PROpened',
      payload: {
        task_id: taskId,
        pr_number: prNumber,
        html_url: htmlUrl,
        owner: githubOwner,
        repo: githubRepo,
        branch: branchName,
        head_sha: headSha,
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: envelope.trace_id,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    logger.info({ taskId, prNumber, htmlUrl }, 'GitHubPROrchestrator: PROpened emitted')
  }

  // -------------------------------------------------------------------------
  // VerifierPassed / VerifierFailed → add label
  // -------------------------------------------------------------------------

  private async onVerifierResult(envelope: EventEnvelope, labels: string[]): Promise<void> {
    const taskId = envelope.aggregate_id
    const { db, githubClient } = this.opts

    // Resolve PR number from task row
    const [taskRow] = await db
      .select({
        githubPrNumber: tasks.githubPrNumber,
        storyId: tasks.storyId,
      })
      .from(tasks)
      .where(eq(tasks.taskId, taskId))
      .limit(1)

    if (!taskRow?.githubPrNumber) {
      logger.debug(
        { taskId, event: envelope.event_type },
        'GitHubPROrchestrator: no PR on task; skipping label',
      )
      return
    }

    // Get the project for owner/repo
    const allProjects = await db.select().from(projects)
    const connectedProject = allProjects.find(
      (p) => p.githubOwner !== null && p.githubRepo !== null,
    ) ?? null

    if (!connectedProject?.githubOwner || !connectedProject.githubRepo) {
      logger.warn({ taskId }, 'GitHubPROrchestrator.onVerifierResult: no connected project')
      return
    }

    try {
      await githubClient.addLabels({
        owner: connectedProject.githubOwner,
        repo: connectedProject.githubRepo,
        pr_number: taskRow.githubPrNumber,
        labels,
      })
      logger.info(
        { taskId, prNumber: taskRow.githubPrNumber, labels },
        'GitHubPROrchestrator: label(s) added',
      )
    } catch (err) {
      logger.error(
        { err, taskId, prNumber: taskRow.githubPrNumber, labels },
        'GitHubPROrchestrator: addLabels failed',
      )
    }
  }

  // -------------------------------------------------------------------------
  // PROpened → post system message + create reviewer task (Round 6 #2)
  // -------------------------------------------------------------------------

  private async onPROpened(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as Record<string, unknown>
    const taskId = envelope.aggregate_id
    const prNumber = payload['pr_number']
    const htmlUrl = payload['html_url']

    logger.info(
      { taskId, prNumber, htmlUrl },
      `GitHubPROrchestrator: PR #${String(prNumber)} opened → ${String(htmlUrl)}`,
    )

    // Channel posting would normally go through ChannelsService. Since the
    // PR orchestrator is wired at boot without a direct ChannelsService
    // reference (to avoid a circular dep graph), we emit a PROpenedChannelMessage
    // event and let a separate subscriber post it. For now we log — the UI
    // picks up the PROpened event directly via EventStore subscription.

    // Round 6 #2 — create reviewer child task for this PR
    // [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
    await onPROpenedCreateReviewTask(envelope, {
      db: this.opts.db,
      eventStore: this.opts.eventStore,
    }).catch((err: unknown) => {
      logger.error(
        { err, taskId, prNumber },
        'GitHubPROrchestrator: post-pr-opened hook failed (non-fatal); reviewer task not created',
      )
    })
  }

  // -------------------------------------------------------------------------
  // CodeReviewSubmitted → update code_review_state + handle iteration
  // -------------------------------------------------------------------------

  private async onCodeReviewSubmitted(envelope: EventEnvelope): Promise<void> {
    await onCodeReviewSubmitted(envelope, {
      db: this.opts.db,
      eventStore: this.opts.eventStore,
    }).catch((err: unknown) => {
      logger.error(
        { err, eventId: envelope.event_id },
        'GitHubPROrchestrator: post-review-submitted handler failed (non-fatal)',
      )
    })
  }

  // -------------------------------------------------------------------------
  // Round 6 #2 — postReviewComment / submitReview
  // [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
  // -------------------------------------------------------------------------

  /**
   * Post a single inline comment on a PR diff.
   *
   * @param pr_number GitHub PR number
   * @param comment   Inline comment body, path, and position
   */
  async postReviewComment(
    pr_number: number,
    comment: { path: string; line: number; body: string },
  ): Promise<void> {
    const { githubClient } = this.opts

    // Resolve owner/repo from DB
    const { owner, repo } = await this.resolveOwnerRepo()
    if (!owner || !repo) {
      logger.warn({ pr_number }, 'GitHubPROrchestrator.postReviewComment: no GitHub project configured')
      return
    }

    try {
      await githubClient.createReviewComment({
        owner,
        repo,
        pr_number,
        path: comment.path,
        line: comment.line,
        body: comment.body,
      })
      logger.info(
        { owner, repo, pr_number, path: comment.path, line: comment.line },
        'GitHubPROrchestrator: review comment posted',
      )
    } catch (err) {
      logger.error(
        { err, owner, repo, pr_number, comment },
        'GitHubPROrchestrator.postReviewComment: failed',
      )
      throw err
    }
  }

  /**
   * Submit a PR review with a state (APPROVED / CHANGES_REQUESTED / COMMENTED).
   *
   * @param pr_number GitHub PR number
   * @param review    Review state, body, and inline comments
   * @returns GitHub review ID
   */
  async submitReview(
    pr_number: number,
    review: {
      state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'
      body: string
      comments?: Array<{ path: string; line: number; body: string }>
      /**
       * Round 7-08 — Operator-Attributed UI
       * Persona slug of the reviewer agent (e.g. "reviewer").
       * When provided, appended to the review body as an operator badge.
       * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
       */
      reviewerPersona?: string
    },
  ): Promise<number> {
    const { githubClient } = this.opts

    const { owner, repo } = await this.resolveOwnerRepo()
    if (!owner || !repo) {
      logger.warn({ pr_number }, 'GitHubPROrchestrator.submitReview: no GitHub project configured')
      throw new Error('No GitHub project configured')
    }

    // Round 7-08 — Operator-Attributed UI: append operator badge to review body.
    // Format: "\n\n---\nReviewed by [<install-display-name>] · <persona> · Sonnet"
    // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
    const installName = this.opts.installDisplayName ?? null
    const persona = review.reviewerPersona ?? 'reviewer'
    const attributionSuffix = installName
      ? `\n\n---\nReviewed by [${installName}] · ${persona} · Sonnet`
      : `\n\n---\nReviewed by [orbital] · ${persona} · Sonnet`
    const bodyWithAttribution = review.body + attributionSuffix

    try {
      const result = await githubClient.submitPRReview({
        owner,
        repo,
        pr_number,
        state: review.state,
        body: bodyWithAttribution,
        comments: review.comments ?? [],
      })
      logger.info(
        { owner, repo, pr_number, state: review.state, reviewId: result.id },
        'GitHubPROrchestrator: review submitted',
      )
      return result.id
    } catch (err) {
      logger.error(
        { err, owner, repo, pr_number, state: review.state },
        'GitHubPROrchestrator.submitReview: failed',
      )
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Helper: resolve owner/repo from first connected project
  // -------------------------------------------------------------------------

  private async resolveOwnerRepo(): Promise<{ owner: string | null; repo: string | null }> {
    const allProjects = await this.opts.db.select().from(projects)
    const connected = allProjects.find(
      (p) => p.githubOwner !== null && p.githubRepo !== null,
    ) ?? null
    return {
      owner: connected?.githubOwner ?? null,
      repo: connected?.githubRepo ?? null,
    }
  }

  // -------------------------------------------------------------------------
  // PR body assembly (best-effort)
  // -------------------------------------------------------------------------

  private async buildBody(ctx: {
    taskRow: typeof tasks.$inferSelect
    storyId: string | null | undefined
    sprintId: string
  }): Promise<string> {
    const { taskRow, storyId, sprintId } = ctx
    const { db } = this.opts

    // Load sprint
    const [sprintRow] = await db
      .select()
      .from(sprints)
      .where(eq(sprints.sprintId, sprintId))
      .limit(1)

    // Load story + ACs
    let storyRow: typeof stories.$inferSelect | undefined
    let acRows: typeof storyAcceptanceCriteria.$inferSelect[] = []

    if (storyId) {
      const storyResult = await db
        .select()
        .from(stories)
        .where(eq(stories.storyId, storyId))
        .limit(1)
      storyRow = storyResult[0]

      acRows = await db
        .select()
        .from(storyAcceptanceCriteria)
        .where(eq(storyAcceptanceCriteria.storyId, storyId))
    }

    return buildPRBody({
      story: {
        title: storyRow?.title ?? taskRow.title,
        description: storyRow?.description ?? taskRow.description,
      },
      acceptanceCriteria: acRows.map((ac) => ({ title: ac.text })),
      personaId: taskRow.personaId,
      personaDisplayName: taskRow.personaId, // display name same as id until personas expose displayName
      sprint: {
        number: sprintRow?.sequence ?? 0,
        id: sprintId,
      },
      capabilityId: taskRow.currentCapabilityId ?? 'unknown',
      taskId: taskRow.taskId,
      // Round 7-08 — Operator-Attributed UI: embed install attribution in footer
      // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
      installDisplayName: this.opts.installDisplayName ?? undefined,
    })
  }
}

