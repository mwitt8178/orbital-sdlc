/**
 * github/webhook.ts — GitHub → Orbital webhook receiver.
 *
 * Per Round 5D spec §4.
 *
 * Route: POST /api/v1/webhooks/github
 *
 * Authentication:
 *   - Header `x-hub-signature-256` is `sha256=<HMAC-SHA256(rawBody, secret)>`
 *   - Use `crypto.timingSafeEqual` to prevent timing attacks.
 *   - Mismatch → 401.
 *
 * Supported events (via X-GitHub-Event header):
 *   - pull_request.closed (merged=true)    → emit PRMerged
 *   - pull_request.review_requested        → emit PRReviewRequested
 *   - pull_request.review_submitted        → emit PRReviewSubmitted
 *   - issue_comment.created (on a PR)      → emit PRCommentCreated
 *   - check_run.created                    → emit CIRunStarted
 *   - check_run.completed                  → emit CIRunCompleted | CIRunFailed
 *   - workflow_run.completed               → emit CIRunCompleted | CIRunFailed
 *   - check_suite.completed                → emit CIRunCompleted | CIRunFailed
 *
 * PR-to-task mapping: query tasks WHERE github_pr_number = n.
 * Unknown PR numbers → log warning, return 200 to silence GitHub retries.
 *
 * Idempotency: GitHub redelivers events. We dedupe by X-GitHub-Delivery header
 * using an in-memory TTL map (DeliveryCache). Inject a custom cache for tests.
 *
 * Round 6 #6 CI/CD Bridge additions:
 * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { eq, or } from 'drizzle-orm'
import { OrbitalError } from '@orbital/types'
import { logger } from '../config/logger.js'
import type { EventStore } from '../events/store.js'
import type { DB } from '../db/client.js'
import { tasks } from '../db/schema/orchestration.js'
import { uuidv7 } from 'uuidv7'

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

const GITHUB_WEBHOOK_ERROR_CODES = {
  WEBHOOK_INVALID_SIGNATURE: 'WEBHOOK_INVALID_SIGNATURE',
  WEBHOOK_PARSE_ERROR: 'WEBHOOK_PARSE_ERROR',
  STARTUP_ERROR: 'STARTUP_ERROR',
} as const

// ---------------------------------------------------------------------------
// DeliveryCache — idempotency memo with TTL
// [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
// ---------------------------------------------------------------------------

export interface DeliveryCacheOptions {
  /** How long to remember a delivery_id (ms). Default: 10 minutes. */
  ttlMs?: number
}

/**
 * In-memory TTL cache for X-GitHub-Delivery IDs.
 *
 * GitHub guarantees delivery_id is globally unique per delivery attempt.
 * On retry GitHub sends a NEW delivery_id, so deduping prevents exact
 * duplicates while still processing retries.
 *
 * The cache stores expiry timestamps. On hasSeen(), we evict expired entries
 * lazily to avoid a background timer.
 */
export class DeliveryCache {
  private readonly seen = new Map<string, number>()
  private readonly ttlMs: number

  constructor(opts: DeliveryCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000
  }

  hasSeen(deliveryId: string): boolean {
    const expiry = this.seen.get(deliveryId)
    if (expiry === undefined) return false
    if (Date.now() > expiry) {
      this.seen.delete(deliveryId)
      return false
    }
    return true
  }

  markSeen(deliveryId: string): void {
    this.seen.set(deliveryId, Date.now() + this.ttlMs)
  }

  /** Best-effort lazy eviction of all expired entries. */
  evictExpired(): void {
    const now = Date.now()
    for (const [id, expiry] of this.seen) {
      if (now > expiry) this.seen.delete(id)
    }
  }
}

// ---------------------------------------------------------------------------
// Default shared cache (one per process)
// ---------------------------------------------------------------------------
const defaultDeliveryCache = new DeliveryCache()

// ---------------------------------------------------------------------------
// Public verification helper (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Verify a `x-hub-signature-256` header (format: `sha256=<hex>`) against the
 * raw body using the shared secret.
 *
 * Returns true iff the HMAC-SHA256 matches in constant time.
 */
export function verifyGithubSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false
  // GitHub format: "sha256=<hexdigest>"
  if (!signatureHeader.startsWith('sha256=')) return false
  const receivedHex = signatureHeader.slice('sha256='.length)

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody
  const expectedHex = createHmac('sha256', secret).update(body).digest('hex')

  const received = Buffer.from(receivedHex, 'utf-8')
  const expected = Buffer.from(expectedHex, 'utf-8')
  if (received.length !== expected.length) return false
  try {
    return timingSafeEqual(received, expected)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// PR-number extractor from GitHub payload url strings
// ---------------------------------------------------------------------------

function extractPrNumber(htmlUrl: string | undefined): number | null {
  if (!htmlUrl) return null
  const match = /\/pull\/(\d+)/.exec(htmlUrl)
  if (!match || !match[1]) return null
  const n = parseInt(match[1], 10)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// PR-to-task lookup by PR number
// ---------------------------------------------------------------------------

async function findTaskByPrNumber(
  db: DB,
  prNumber: number,
): Promise<{ taskId: string } | null> {
  const rows = await db
    .select({ taskId: tasks.taskId })
    .from(tasks)
    .where(eq(tasks.githubPrNumber, prNumber))
    .limit(1)
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Task lookup with story_id and tenant_id (for PR review job dispatch)
// [Engineer-Sr · Sonnet · run-pr-review-agent-001]
// ---------------------------------------------------------------------------

async function findTaskWithStoryId(
  db: DB,
  taskId: string,
): Promise<{ taskId: string; tenantId: string; storyId: string | null; projectId: string | null } | null> {
  const rows = await db
    .select({
      taskId: tasks.taskId,
      tenantId: tasks.tenantId,
      storyId: tasks.storyId,
    })
    .from(tasks)
    .where(eq(tasks.taskId, taskId))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  // Resolve projectId via cost_ledger (no tasks.project_id col on this branch)
  try {
    const { costLedger } = await import('../db/schema/cost.js')
    const { desc: descOp } = await import('drizzle-orm')
    const projRows = await db
      .select({ projectId: costLedger.projectId })
      .from(costLedger)
      .where(eq(costLedger.taskId, taskId))
      .orderBy(descOp(costLedger.occurredAt))
      .limit(1)
    return { ...row, projectId: projRows[0]?.projectId ?? null }
  } catch {
    return { ...row, projectId: null }
  }
}

// ---------------------------------------------------------------------------
// Head SHA to task lookup (for workflow_run / check_suite which may lack PR refs)
// ---------------------------------------------------------------------------

async function findTaskByHeadSha(
  db: DB,
  headSha: string,
): Promise<{ taskId: string } | null> {
  const rows = await db
    .select({ taskId: tasks.taskId })
    .from(tasks)
    .where(eq(tasks.githubHeadSha, headSha))
    .limit(1)
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Determine which PR numbers are referenced by a check_run
// ---------------------------------------------------------------------------

function extractPrNumbersFromCheckRun(
  checkRun: Record<string, unknown>,
): number[] {
  const prs = checkRun['pull_requests']
  if (!Array.isArray(prs)) return []
  const numbers: number[] = []
  for (const pr of prs) {
    if (typeof pr === 'object' && pr !== null && typeof (pr as Record<string, unknown>)['number'] === 'number') {
      numbers.push((pr as Record<string, unknown>)['number'] as number)
    }
  }
  return numbers
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RegisterGithubWebhookOptions {
  /** HMAC shared secret from GitHub webhook settings. */
  secret: string
  /** EventStore for emitting TaskMerged etc. */
  eventStore: EventStore
  /** DB for PR → task mapping. */
  db: DB
  /**
   * Optional delivery cache for idempotency. Defaults to a shared process-level
   * cache. Inject a fresh DeliveryCache in tests for isolation.
   */
  deliveryCache?: DeliveryCache
  /**
   * Optional callback invoked asynchronously when a pull_request.opened event
   * arrives and a task is resolved. Fires-and-forgets so the webhook handler
   * returns 200 immediately.
   *
   * Payload shape mirrors PrReviewJobPayload from pr-review-processor.ts.
   * Kept as a loosely-typed Record here so the webhook module has no direct
   * import of the processor (avoids circular deps and keeps the module testable
   * without a real Anthropic client).
   *
   * [Engineer-Sr · Sonnet · run-pr-review-agent-001]
   */
  onPROpenedForReview?: (job: {
    kind: 'pr_review'
    tenant_id: string
    project_id: string | null
    story_id: string | null
    task_id: string
    pr_number: number
    pr_url: string
    head_sha: string
    github_owner: string
    github_repo: string
  }) => void
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register the POST /api/v1/webhooks/github route.
 *
 * If `secret` is empty this throws immediately (same contract as Monday webhook).
 * Route returns 200 for all processed payloads, 401 on signature mismatch, 200
 * with a warning log for unrecognized PR → task mappings.
 *
 * Round 6 #6: Also handles check_run, workflow_run, check_suite events.
 * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 */
export function registerGithubWebhook(
  app: FastifyInstance,
  options: RegisterGithubWebhookOptions,
): void {
  if (!options.secret || options.secret.length === 0) {
    throw new OrbitalError(
      GITHUB_WEBHOOK_ERROR_CODES.STARTUP_ERROR,
      'registerGithubWebhook: secret is required',
    )
  }

  const deliveryCache = options.deliveryCache ?? defaultDeliveryCache

  app.post(
    '/api/v1/webhooks/github',
    {
      bodyLimit: 10 * 1024 * 1024, // 10 MiB — GitHub payloads can be large
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const sig = req.headers['x-hub-signature-256'] as string | undefined
      const githubEvent = req.headers['x-github-event'] as string | undefined
      const deliveryId = req.headers['x-github-delivery'] as string | undefined

      const raw =
        (req as unknown as { rawBody?: Buffer }).rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}), 'utf-8')

      if (!verifyGithubSignature(raw, sig, options.secret)) {
        logger.warn(
          { githubEvent, sig: sig ? sig.slice(0, 16) + '…' : undefined },
          'github-webhook: invalid signature',
        )
        return reply.status(401).send({
          error: {
            code: GITHUB_WEBHOOK_ERROR_CODES.WEBHOOK_INVALID_SIGNATURE,
            message: 'invalid x-hub-signature-256',
          },
        })
      }

      // Idempotency: skip if this delivery_id was already processed
      if (deliveryId) {
        if (deliveryCache.hasSeen(deliveryId)) {
          logger.debug(
            { githubEvent, deliveryId },
            'github-webhook: duplicate delivery_id; skipping',
          )
          return reply.status(200).send({ ok: true, skipped: 'duplicate_delivery' })
        }
        deliveryCache.markSeen(deliveryId)
        // Best-effort lazy eviction on every ~100th request
        if (Math.random() < 0.01) deliveryCache.evictExpired()
      }

      const payload = req.body as Record<string, unknown>
      if (typeof payload !== 'object' || payload === null) {
        return reply.status(200).send({ ok: true, skipped: 'empty body' })
      }

      const action = typeof payload['action'] === 'string' ? payload['action'] : undefined
      logger.debug({ githubEvent, action }, 'github-webhook: received')

      try {
        await routeGithubEvent({
          githubEvent,
          action,
          payload,
          eventStore: options.eventStore,
          db: options.db,
          onPROpenedForReview: options.onPROpenedForReview,
        })
      } catch (err) {
        logger.error({ err, githubEvent, action }, 'github-webhook: routing failed')
        // Return 200 to prevent GitHub retrying — we log the failure internally.
      }

      return reply.status(200).send({ ok: true })
    },
  )
}

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

interface RouteContext {
  githubEvent: string | undefined
  action: string | undefined
  payload: Record<string, unknown>
  eventStore: EventStore
  db: DB
  /** [Engineer-Sr · Sonnet · run-pr-review-agent-001] */
  onPROpenedForReview?: RegisterGithubWebhookOptions['onPROpenedForReview']
}

async function routeGithubEvent(ctx: RouteContext): Promise<void> {
  const { githubEvent, action, payload, eventStore, db } = ctx

  // -------------------------------------------------------------------------
  // pull_request events (pre-existing Round 6 #1 logic, unchanged)
  // -------------------------------------------------------------------------
  if (githubEvent === 'pull_request') {
    const pr = payload['pull_request'] as Record<string, unknown> | undefined
    const prNumber = pr ? extractPrNumber(pr['html_url'] as string | undefined) : null

    if (!prNumber) {
      logger.warn({ githubEvent, action }, 'github-webhook: could not extract PR number; skipping')
      return
    }

    const task = await findTaskByPrNumber(db, prNumber)
    if (!task) {
      logger.warn(
        { prNumber, action },
        'github-webhook: no task found for PR number; skipping (PR may not be Orbital-owned)',
      )
      return
    }

    // -----------------------------------------------------------------------
    // pull_request.opened → enqueue automated PR review job
    // [Engineer-Sr · Sonnet · run-pr-review-agent-001]
    // -----------------------------------------------------------------------
    if (action === 'opened') {
      const prData = payload['pull_request'] as Record<string, unknown> | undefined
      const htmlUrl = prData?.['html_url'] as string | undefined
      const headSha = (prData?.['head'] as Record<string, unknown> | undefined)?.['sha'] as string | undefined
      const repoData = payload['repository'] as Record<string, unknown> | undefined
      const repoFullName = typeof repoData?.['full_name'] === 'string' ? repoData['full_name'] : ''
      const [githubOwner = '', githubRepo = ''] = repoFullName.split('/')

      // Mark story review_status = 'pending' immediately
      const taskDetails = await findTaskWithStoryId(db, task.taskId)

      if (ctx.onPROpenedForReview && githubOwner && githubRepo) {
        ctx.onPROpenedForReview({
          kind: 'pr_review',
          tenant_id: taskDetails?.tenantId ?? '00000000-0000-0000-0000-000000000000',
          project_id: taskDetails?.projectId ?? null,
          story_id: taskDetails?.storyId ?? null,
          task_id: task.taskId,
          pr_number: prNumber,
          pr_url: htmlUrl ?? `https://github.com/${repoFullName}/pull/${prNumber}`,
          head_sha: headSha ?? '',
          github_owner: githubOwner,
          github_repo: githubRepo,
        })
        logger.info(
          { taskId: task.taskId, prNumber, storyId: taskDetails?.storyId },
          'github-webhook: PR review job enqueued',
        )
      } else {
        logger.info(
          { taskId: task.taskId, prNumber, reason: !ctx.onPROpenedForReview ? 'no_review_callback' : 'no_repo_info' },
          'github-webhook: pull_request.opened received (review callback not configured)',
        )
      }
    } else if (action === 'closed') {
      const prData = payload['pull_request'] as Record<string, unknown> | undefined
      const merged = (prData?.['merged'] as boolean | undefined) ?? false
      const mergedAt = (prData?.['merged_at'] as string | null | undefined) ?? new Date().toISOString()
      const mergeSha = (prData?.['merge_commit_sha'] as string | null | undefined) ?? undefined

      if (merged) {
        await eventStore.append({
          aggregate_id: task.taskId,
          aggregate_type: 'task',
          event_type: 'PRMerged',
          payload: {
            task_id: task.taskId,
            pr_number: prNumber,
            merged_at: mergedAt,
            merge_sha: mergeSha,
          },
          actor: { type: 'system', component: 'orchestrator' },
          trace_id: uuidv7(),
          occurred_at: new Date().toISOString(),
          schema_version: 1,
        })

        await db
          .update(tasks)
          .set({
            githubPrMergedAt: new Date(mergedAt),
            githubPrState: 'merged',
          })
          .where(eq(tasks.taskId, task.taskId))

        logger.info(
          { taskId: task.taskId, prNumber },
          'github-webhook: PRMerged emitted',
        )
      } else {
        await eventStore.append({
          aggregate_id: task.taskId,
          aggregate_type: 'task',
          event_type: 'PRClosed',
          payload: {
            task_id: task.taskId,
            pr_number: prNumber,
            closed_at: new Date().toISOString(),
          },
          actor: { type: 'system', component: 'orchestrator' },
          trace_id: uuidv7(),
          occurred_at: new Date().toISOString(),
          schema_version: 1,
        })

        await db
          .update(tasks)
          .set({ githubPrState: 'closed' })
          .where(eq(tasks.taskId, task.taskId))

        logger.info(
          { taskId: task.taskId, prNumber },
          'github-webhook: PRClosed emitted',
        )
      }
    } else if (action === 'review_requested') {
      logger.info(
        { taskId: task.taskId, prNumber, action },
        'github-webhook: review requested on Orbital PR',
      )
      await eventStore.append({
        aggregate_id: task.taskId,
        aggregate_type: 'task',
        event_type: 'PRReviewRequested',
        payload: { task_id: task.taskId, pr_number: prNumber },
        actor: { type: 'system', component: 'orchestrator' },
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })
    } else if (action === 'submitted') {
      const review = payload['review'] as Record<string, unknown> | undefined
      const state = typeof review?.['state'] === 'string' ? review['state'] : undefined
      await eventStore.append({
        aggregate_id: task.taskId,
        aggregate_type: 'task',
        event_type: 'PRReviewSubmitted',
        payload: {
          task_id: task.taskId,
          pr_number: prNumber,
          review_state: state,
        },
        actor: { type: 'system', component: 'orchestrator' },
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })
      logger.info(
        { taskId: task.taskId, prNumber, reviewState: state },
        'github-webhook: PRReviewSubmitted emitted',
      )
    }
    return
  }

  // -------------------------------------------------------------------------
  // issue_comment (pre-existing)
  // -------------------------------------------------------------------------
  if (githubEvent === 'issue_comment' && action === 'created') {
    const issue = payload['issue'] as Record<string, unknown> | undefined
    const isPr = typeof issue?.['pull_request'] !== 'undefined'
    if (!isPr) return

    const htmlUrl = issue?.['html_url'] as string | undefined
    const prNumber = htmlUrl ? extractPrNumber(htmlUrl) : null
    if (!prNumber) return

    const task = await findTaskByPrNumber(db, prNumber)
    if (!task) return

    const comment = payload['comment'] as Record<string, unknown> | undefined
    const body = typeof comment?.['body'] === 'string' ? comment['body'] : ''

    await eventStore.append({
      aggregate_id: task.taskId,
      aggregate_type: 'task',
      event_type: 'PRCommentCreated',
      payload: {
        task_id: task.taskId,
        pr_number: prNumber,
        comment_body: body.slice(0, 2000),
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })
    logger.info(
      { taskId: task.taskId, prNumber },
      'github-webhook: PRCommentCreated emitted',
    )
    return
  }

  // -------------------------------------------------------------------------
  // check_run events
  // Round 6 #6 — CI/CD Bridge
  // [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
  // -------------------------------------------------------------------------
  if (githubEvent === 'check_run') {
    await handleCheckRunEvent(ctx)
    return
  }

  // -------------------------------------------------------------------------
  // workflow_run events
  // Round 6 #6 — CI/CD Bridge
  // [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
  // -------------------------------------------------------------------------
  if (githubEvent === 'workflow_run') {
    await handleWorkflowRunEvent(ctx)
    return
  }

  // -------------------------------------------------------------------------
  // check_suite events
  // Round 6 #6 — CI/CD Bridge
  // [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
  // -------------------------------------------------------------------------
  if (githubEvent === 'check_suite') {
    await handleCheckSuiteEvent(ctx)
    return
  }
}

// ---------------------------------------------------------------------------
// check_run handler
// [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
// ---------------------------------------------------------------------------

async function handleCheckRunEvent(ctx: RouteContext): Promise<void> {
  const { action, payload, eventStore, db } = ctx

  const checkRun = payload['check_run'] as Record<string, unknown> | undefined
  if (!checkRun) return

  const checkName = typeof checkRun['name'] === 'string' ? checkRun['name'] : 'unknown'
  const htmlUrl = typeof checkRun['html_url'] === 'string' ? checkRun['html_url'] : ''
  const headSha = typeof checkRun['head_sha'] === 'string' ? checkRun['head_sha'] : ''
  const startedAt = typeof checkRun['started_at'] === 'string' ? checkRun['started_at'] : new Date().toISOString()
  const completedAt = typeof checkRun['completed_at'] === 'string' ? checkRun['completed_at'] : null
  const conclusion = typeof checkRun['conclusion'] === 'string' ? checkRun['conclusion'] : null

  // Resolve task from PR number first, then fall back to head_sha
  const prNumbers = extractPrNumbersFromCheckRun(checkRun)
  let task: { taskId: string } | null = null

  for (const prNumber of prNumbers) {
    task = await findTaskByPrNumber(db, prNumber)
    if (task) break
  }

  if (!task && headSha) {
    task = await findTaskByHeadSha(db, headSha)
  }

  if (!task) {
    logger.debug(
      { checkName, headSha, prNumbers },
      'github-webhook: check_run for unknown PR/SHA; skipping',
    )
    return
  }

  const prNumber = prNumbers[0] ?? 0
  const now = new Date().toISOString()

  if (action === 'created' || action === 'rerequested') {
    // CIRunStarted
    await eventStore.append({
      aggregate_id: task.taskId,
      aggregate_type: 'task',
      event_type: 'CIRunStarted',
      payload: {
        task_id: task.taskId,
        pr_number: prNumber,
        ci_check_name: checkName,
        ci_run_url: htmlUrl,
        head_sha: headSha,
        started_at: startedAt,
        source: 'check_run',
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: now,
      schema_version: 1,
    })
    logger.info(
      { taskId: task.taskId, prNumber, checkName },
      'github-webhook: CIRunStarted emitted',
    )
    return
  }

  if (action === 'completed') {
    const completed = completedAt ?? now
    const durationMs = computeDurationMs(startedAt, completed)

    const isFailure = isCIFailure(conclusion)

    if (isFailure) {
      // CIRunFailed
      await eventStore.append({
        aggregate_id: task.taskId,
        aggregate_type: 'task',
        event_type: 'CIRunFailed',
        payload: {
          task_id: task.taskId,
          pr_number: prNumber,
          ci_check_name: checkName,
          ci_run_url: htmlUrl,
          ci_conclusion: conclusion ?? 'unknown',
          head_sha: headSha,
          started_at: startedAt,
          completed_at: completed,
          duration_ms: durationMs,
          source: 'check_run',
        },
        actor: { type: 'system', component: 'orchestrator' },
        trace_id: uuidv7(),
        occurred_at: now,
        schema_version: 1,
      })
      logger.warn(
        { taskId: task.taskId, prNumber, checkName, conclusion },
        'github-webhook: CIRunFailed emitted',
      )
    } else {
      // CIRunCompleted (success, neutral, skipped)
      await eventStore.append({
        aggregate_id: task.taskId,
        aggregate_type: 'task',
        event_type: 'CIRunCompleted',
        payload: {
          task_id: task.taskId,
          pr_number: prNumber,
          ci_check_name: checkName,
          ci_run_url: htmlUrl,
          ci_conclusion: conclusion ?? 'success',
          head_sha: headSha,
          started_at: startedAt,
          completed_at: completed,
          duration_ms: durationMs,
          source: 'check_run',
        },
        actor: { type: 'system', component: 'orchestrator' },
        trace_id: uuidv7(),
        occurred_at: now,
        schema_version: 1,
      })
      logger.info(
        { taskId: task.taskId, prNumber, checkName, conclusion },
        'github-webhook: CIRunCompleted emitted',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// workflow_run handler
// [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
// ---------------------------------------------------------------------------

async function handleWorkflowRunEvent(ctx: RouteContext): Promise<void> {
  const { action, payload, eventStore, db } = ctx

  const workflowRun = payload['workflow_run'] as Record<string, unknown> | undefined
  if (!workflowRun) return

  const checkName = typeof workflowRun['name'] === 'string' ? workflowRun['name'] : 'workflow'
  const htmlUrl = typeof workflowRun['html_url'] === 'string' ? workflowRun['html_url'] : ''
  const headSha = typeof workflowRun['head_sha'] === 'string' ? workflowRun['head_sha'] : ''
  const startedAt = typeof workflowRun['run_started_at'] === 'string'
    ? workflowRun['run_started_at']
    : (typeof workflowRun['created_at'] === 'string' ? workflowRun['created_at'] : new Date().toISOString())
  const updatedAt = typeof workflowRun['updated_at'] === 'string' ? workflowRun['updated_at'] : null
  const conclusion = typeof workflowRun['conclusion'] === 'string' ? workflowRun['conclusion'] : null

  // Resolve task from PR refs or head_sha
  const prs = workflowRun['pull_requests']
  const prNumbers: number[] = []
  if (Array.isArray(prs)) {
    for (const pr of prs) {
      if (typeof pr === 'object' && pr !== null && typeof (pr as Record<string, unknown>)['number'] === 'number') {
        prNumbers.push((pr as Record<string, unknown>)['number'] as number)
      }
    }
  }

  let task: { taskId: string } | null = null
  for (const prNumber of prNumbers) {
    task = await findTaskByPrNumber(db, prNumber)
    if (task) break
  }
  if (!task && headSha) {
    task = await findTaskByHeadSha(db, headSha)
  }

  if (!task) {
    logger.debug(
      { checkName, headSha, prNumbers },
      'github-webhook: workflow_run for unknown PR/SHA; skipping',
    )
    return
  }

  const prNumber = prNumbers[0] ?? 0
  const now = new Date().toISOString()

  if (action === 'completed') {
    const completed = updatedAt ?? now
    const durationMs = computeDurationMs(startedAt, completed)
    const isFailure = isCIFailure(conclusion)

    if (isFailure) {
      await eventStore.append({
        aggregate_id: task.taskId,
        aggregate_type: 'task',
        event_type: 'CIRunFailed',
        payload: {
          task_id: task.taskId,
          pr_number: prNumber,
          ci_check_name: checkName,
          ci_run_url: htmlUrl,
          ci_conclusion: conclusion ?? 'unknown',
          head_sha: headSha,
          started_at: startedAt,
          completed_at: completed,
          duration_ms: durationMs,
          source: 'workflow_run',
        },
        actor: { type: 'system', component: 'orchestrator' },
        trace_id: uuidv7(),
        occurred_at: now,
        schema_version: 1,
      })
      logger.warn(
        { taskId: task.taskId, prNumber, checkName, conclusion },
        'github-webhook: CIRunFailed (workflow_run) emitted',
      )
    } else {
      await eventStore.append({
        aggregate_id: task.taskId,
        aggregate_type: 'task',
        event_type: 'CIRunCompleted',
        payload: {
          task_id: task.taskId,
          pr_number: prNumber,
          ci_check_name: checkName,
          ci_run_url: htmlUrl,
          ci_conclusion: conclusion ?? 'success',
          head_sha: headSha,
          started_at: startedAt,
          completed_at: completed,
          duration_ms: durationMs,
          source: 'workflow_run',
        },
        actor: { type: 'system', component: 'orchestrator' },
        trace_id: uuidv7(),
        occurred_at: now,
        schema_version: 1,
      })
      logger.info(
        { taskId: task.taskId, prNumber, checkName, conclusion },
        'github-webhook: CIRunCompleted (workflow_run) emitted',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// check_suite handler
// [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
// ---------------------------------------------------------------------------

async function handleCheckSuiteEvent(ctx: RouteContext): Promise<void> {
  const { action, payload, eventStore, db } = ctx

  const suite = payload['check_suite'] as Record<string, unknown> | undefined
  if (!suite) return

  const headSha = typeof suite['head_sha'] === 'string' ? suite['head_sha'] : ''
  const conclusion = typeof suite['conclusion'] === 'string' ? suite['conclusion'] : null
  const htmlUrl = '' // check_suite payloads don't have a direct html_url; use GitHub URL pattern
  const checkName = 'check_suite'

  const prs = suite['pull_requests']
  const prNumbers: number[] = []
  if (Array.isArray(prs)) {
    for (const pr of prs) {
      if (typeof pr === 'object' && pr !== null && typeof (pr as Record<string, unknown>)['number'] === 'number') {
        prNumbers.push((pr as Record<string, unknown>)['number'] as number)
      }
    }
  }

  let task: { taskId: string } | null = null
  for (const prNumber of prNumbers) {
    task = await findTaskByPrNumber(db, prNumber)
    if (task) break
  }
  if (!task && headSha) {
    task = await findTaskByHeadSha(db, headSha)
  }

  if (!task) {
    logger.debug(
      { headSha, prNumbers },
      'github-webhook: check_suite for unknown PR/SHA; skipping',
    )
    return
  }

  const prNumber = prNumbers[0] ?? 0
  const now = new Date().toISOString()

  if (action === 'completed') {
    const isFailure = isCIFailure(conclusion)
    const eventType = isFailure ? 'CIRunFailed' : 'CIRunCompleted'

    await eventStore.append({
      aggregate_id: task.taskId,
      aggregate_type: 'task',
      event_type: eventType,
      payload: {
        task_id: task.taskId,
        pr_number: prNumber,
        ci_check_name: checkName,
        ci_run_url: htmlUrl,
        ci_conclusion: conclusion ?? 'success',
        head_sha: headSha,
        started_at: now,
        completed_at: now,
        duration_ms: 0,
        source: 'check_suite',
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: now,
      schema_version: 1,
    })

    logger.info(
      { taskId: task.taskId, prNumber, conclusion, eventType },
      'github-webhook: check_suite completed emitted',
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True for conclusions that mean CI is failing (not passing). */
function isCIFailure(conclusion: string | null | undefined): boolean {
  return (
    conclusion === 'failure' ||
    conclusion === 'cancelled' ||
    conclusion === 'timed_out' ||
    conclusion === 'action_required'
  )
}

function computeDurationMs(startedAt: string, completedAt: string): number {
  try {
    const start = new Date(startedAt).getTime()
    const end = new Date(completedAt).getTime()
    return Math.max(0, end - start)
  } catch {
    return 0
  }
}
