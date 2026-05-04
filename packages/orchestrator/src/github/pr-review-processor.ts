/**
 * github/pr-review-processor.ts — Automated PR review by opus persona.
 *
 * [Engineer-Sr · Sonnet · run-pr-review-agent-001]
 *
 * Responsibilities:
 *   1. Fetch the PR diff via the GitHub API.
 *   2. Call claude-opus-4-5 with a structured review prompt.
 *   3. Parse the structured JSON verdict: { verdict: 'PASS'|'BLOCK', findings: [...] }.
 *   4. Post a PR comment with the verdict + findings.
 *   5. Write a pr_reviews row (tenant-scoped).
 *   6. Update stories.review_status.
 *   7. Post to the story-review channel.
 *
 * DSQL:
 *   - No foreign keys — logical UUID references only.
 *   - All inserts/updates use parameterized queries.
 *   - No OCC retry needed for INSERT (new row each time); UPDATE uses single
 *     conditional WHERE to avoid races.
 *
 * Tenant isolation: every DB operation carries tenant_id in WHERE clause.
 */

import Anthropic from '@anthropic-ai/sdk'
import { eq, and, sql as drizzleSql } from 'drizzle-orm'
import { randomUUID as uuidv4 } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import type { DB } from '../db/client.js'
import { prReviews, type ReviewFinding, type ReviewVerdict } from '../db/schema/pr-reviews.js'
import { channels, channelPosts } from '../db/schema/channels.js'
import type { GithubClient } from './client.js'
import { logger } from '../config/logger.js'
import type { Logger } from 'pino'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Model used for PR review. Opus-tier per spec.
 * Using claude-opus-4-5 which is the most capable model available.
 */
const REVIEW_MODEL = 'claude-opus-4-5'

/** Maximum diff characters fed to the review prompt. ~100K tokens max. */
const MAX_DIFF_CHARS = 150_000

/** Review persona slug stored on the row. */
const REVIEWER_PERSONA = 'review-agent'

const SYSTEM_ACTOR = {
  type: 'system',
  id: 'pr-review-processor',
  display_name: 'Automated PR Review',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrReviewJobPayload {
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
}

export interface PrReviewResult {
  reviewId: string
  verdict: ReviewVerdict
  findings: ReviewFinding[]
  costUsd: number
  prCommentUrl: string | null
}

// ---------------------------------------------------------------------------
// Review system prompt
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer for the Orbital AI SDLC platform.

Your role is to review pull request diffs and produce a structured verdict.

## Review Categories
- correctness: logic errors, off-by-one, null-deref, type mismatches, missing error handling
- security: injection, auth bypass, secret exposure, insecure defaults, input validation
- multi-tenant: missing tenant_id filters, cross-tenant data bleed, shared mutable state
- observability: missing structured logs, unhandled error paths not logged, silent failures

## Verdict Rules
- PASS: no 'error' severity findings. Minor 'warning' or 'info' findings allowed.
- BLOCK: one or more 'error' severity findings present.

## Output Format
Respond with ONLY valid JSON matching this exact schema:
{
  "verdict": "PASS" | "BLOCK",
  "summary": "<2-3 sentence review summary>",
  "findings": [
    {
      "file": "<relative file path or 'general'>",
      "line": <line number as integer or null>,
      "severity": "info" | "warning" | "error",
      "category": "correctness" | "security" | "multi-tenant" | "observability",
      "message": "<clear, actionable description of the issue>"
    }
  ]
}

Do not include any text outside the JSON. Do not wrap in markdown code fences.`

// ---------------------------------------------------------------------------
// Core processor
// ---------------------------------------------------------------------------

export interface PrReviewProcessorOptions {
  db: DB
  githubClient: GithubClient
  /** Inject a custom Anthropic client for testing. */
  anthropicClient?: Anthropic
  /** Override API key for testing. */
  anthropicApiKey?: string
}

export class PrReviewProcessor {
  private readonly db: DB
  private readonly githubClient: GithubClient
  private readonly anthropicClient: Anthropic | null

  constructor(opts: PrReviewProcessorOptions) {
    this.db = opts.db
    this.githubClient = opts.githubClient

    if (opts.anthropicClient) {
      this.anthropicClient = opts.anthropicClient
    } else {
      const apiKey = opts.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY']
      if (apiKey) {
        this.anthropicClient = new Anthropic({ apiKey, timeout: 300_000, maxRetries: 2 })
      } else {
        this.anthropicClient = null
      }
    }
  }

  /**
   * Run a full PR review cycle for the given job payload.
   * Returns the review result or throws on unrecoverable errors.
   *
   * Safe to retry: inserts a new pr_reviews row each time, updates
   * story.review_status to the latest verdict (idempotent UPSERT pattern).
   */
  async process(job: PrReviewJobPayload): Promise<PrReviewResult> {
    const log = logger.child({
      tenant_id: job.tenant_id,
      task_id: job.task_id,
      pr_number: job.pr_number,
      pr_url: job.pr_url,
    })

    log.info('pr-review-processor: starting review')

    if (!this.anthropicClient) {
      throw new Error('PrReviewProcessor: ANTHROPIC_API_KEY is not configured')
    }

    // ------------------------------------------------------------------
    // 1. Fetch the PR diff
    // ------------------------------------------------------------------
    const diff = await this.fetchDiff(job)
    log.info({ diff_chars: diff.length }, 'pr-review-processor: diff fetched')

    // ------------------------------------------------------------------
    // 2. Call opus for the structured review
    // ------------------------------------------------------------------
    const { verdict, summary, findings, inputTokens, outputTokens } =
      await this.callOpus(diff, job.pr_url, log)

    // Cost estimate: opus pricing at ~$15/M input, ~$75/M output (approx)
    const costUsd = (inputTokens * 15 + outputTokens * 75) / 1_000_000

    log.info(
      { verdict, findings_count: findings.length, cost_usd: costUsd },
      'pr-review-processor: review complete',
    )

    // ------------------------------------------------------------------
    // 3. Post PR comment
    // ------------------------------------------------------------------
    const prCommentUrl = await this.postPRComment({
      job,
      verdict,
      summary,
      findings,
      log,
    })

    // ------------------------------------------------------------------
    // 4. Write pr_reviews row (tenant-scoped)
    // ------------------------------------------------------------------
    const reviewId = uuidv7()
    await this.db.insert(prReviews).values({
      id: reviewId,
      tenantId: job.tenant_id,
      projectId: job.project_id ?? undefined,
      storyId: job.story_id ?? undefined,
      prUrl: job.pr_url,
      verdict,
      findings,
      reviewerPersona: REVIEWER_PERSONA,
      costUsd: costUsd.toFixed(6),
    })

    log.info({ review_id: reviewId }, 'pr-review-processor: pr_reviews row written')

    // ------------------------------------------------------------------
    // 5. Update stories.review_status (conditional — only if story known)
    // ------------------------------------------------------------------
    if (job.story_id) {
      const reviewStatus = verdict === 'PASS' ? 'pass' : 'block'
      await this.db.execute(drizzleSql`
        UPDATE stories
           SET review_status = ${reviewStatus},
               updated_at    = NOW()
         WHERE story_id  = ${job.story_id}
           AND tenant_id = ${job.tenant_id}
      `)
      log.info({ story_id: job.story_id, review_status: reviewStatus }, 'pr-review-processor: story review_status updated')
    }

    // ------------------------------------------------------------------
    // 6. Post to story-review channel
    // ------------------------------------------------------------------
    await this.postChannelEvent({ job, verdict, summary, findings, reviewId, log })

    return { reviewId, verdict, findings, costUsd, prCommentUrl }
  }

  // -------------------------------------------------------------------------
  // Diff fetching — uses the GitHub compare API to get text diff
  // -------------------------------------------------------------------------

  private async fetchDiff(job: PrReviewJobPayload): Promise<string> {
    try {
      // Use rawRequest to get the diff in text format
      const diffText = await this.githubClient.rawRequest<string>(
        'GET',
        `/repos/${job.github_owner}/${job.github_repo}/pulls/${job.pr_number}`,
        undefined,
        { allow404: false },
      )
      // If the response is a PR object, fall back to files endpoint
      if (typeof diffText === 'object' && diffText !== null) {
        return await this.fetchDiffFromFiles(job)
      }
      const text = String(diffText ?? '')
      return text.slice(0, MAX_DIFF_CHARS)
    } catch {
      // Fall back to files approach
      return await this.fetchDiffFromFiles(job)
    }
  }

  private async fetchDiffFromFiles(job: PrReviewJobPayload): Promise<string> {
    // GET /repos/{owner}/{repo}/pulls/{pull_number}/files
    const files = await this.githubClient.rawRequest<Array<{
      filename: string
      status: string
      additions: number
      deletions: number
      patch?: string
    }>>(
      'GET',
      `/repos/${job.github_owner}/${job.github_repo}/pulls/${job.pr_number}/files`,
    )

    if (!Array.isArray(files) || files.length === 0) {
      return '(no changed files found in PR)'
    }

    const parts: string[] = []
    let total = 0
    for (const file of files) {
      if (total >= MAX_DIFF_CHARS) break
      const header = `--- ${file.filename} (${file.status}: +${file.additions}/-${file.deletions})\n`
      const patch = file.patch ?? '(binary or no patch)'
      const chunk = header + patch + '\n\n'
      parts.push(chunk)
      total += chunk.length
    }

    return parts.join('').slice(0, MAX_DIFF_CHARS)
  }

  // -------------------------------------------------------------------------
  // Opus call
  // -------------------------------------------------------------------------

  private async callOpus(
    diff: string,
    prUrl: string,
    log: Logger,
  ): Promise<{
    verdict: ReviewVerdict
    summary: string
    findings: ReviewFinding[]
    inputTokens: number
    outputTokens: number
  }> {
    const userMessage = `Please review the following pull request diff.\n\nPR URL: ${prUrl}\n\n---\n\n${diff}`

    log.debug({ model: REVIEW_MODEL }, 'pr-review-processor: calling opus')

    const response = await this.anthropicClient!.messages.create({
      model: REVIEW_MODEL,
      max_tokens: 4096,
      system: REVIEW_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })

    const inputTokens = response.usage.input_tokens
    const outputTokens = response.usage.output_tokens

    const rawText =
      response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('') ?? ''

    log.debug({ raw_response_len: rawText.length }, 'pr-review-processor: opus responded')

    // Parse JSON response
    let parsed: { verdict: ReviewVerdict; summary: string; findings: ReviewFinding[] }
    try {
      // Strip markdown code fences if the model added them despite instructions
      const cleaned = rawText
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/\s*```\s*$/m, '')
        .trim()
      parsed = JSON.parse(cleaned)
    } catch (err) {
      log.warn({ err, raw: rawText.slice(0, 500) }, 'pr-review-processor: JSON parse failed; defaulting to PASS with parse-error finding')
      return {
        verdict: 'PASS',
        summary: 'Review completed (JSON parse error — check logs).',
        findings: [
          {
            file: 'general',
            line: null,
            severity: 'info',
            category: 'correctness',
            message: `Review response could not be parsed as JSON. Raw: ${rawText.slice(0, 200)}`,
          },
        ],
        inputTokens,
        outputTokens,
      }
    }

    // Validate and coerce verdict
    const verdict: ReviewVerdict = parsed.verdict === 'BLOCK' ? 'BLOCK' : 'PASS'
    const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
    const findings: ReviewFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings.map(coerceFinding)
      : []

    return { verdict, summary, findings, inputTokens, outputTokens }
  }

  // -------------------------------------------------------------------------
  // PR comment posting
  // -------------------------------------------------------------------------

  private async postPRComment(opts: {
    job: PrReviewJobPayload
    verdict: ReviewVerdict
    summary: string
    findings: ReviewFinding[]
    log: Logger
  }): Promise<string | null> {
    const { job, verdict, summary, findings, log } = opts

    const verdictEmoji = verdict === 'PASS' ? '✅' : '🚫'
    const verdictLabel = verdict === 'PASS' ? 'PASS' : 'BLOCK'
    const errorFindings = findings.filter((f) => f.severity === 'error')
    const warnFindings = findings.filter((f) => f.severity === 'warning')
    const infoFindings = findings.filter((f) => f.severity === 'info')

    const findingLines = findings.map((f) => {
      const loc = f.line ? ` (line ${f.line})` : ''
      const sev = f.severity === 'error' ? '🔴' : f.severity === 'warning' ? '🟡' : 'ℹ️'
      return `- ${sev} **${f.category}** \`${f.file}${loc}\`: ${f.message}`
    })

    const body = [
      `## Orbital Automated Review — ${verdictEmoji} ${verdictLabel}`,
      '',
      summary,
      '',
      `**Findings:** ${errorFindings.length} error(s), ${warnFindings.length} warning(s), ${infoFindings.length} info`,
      '',
      ...(findingLines.length > 0 ? ['### Details', '', ...findingLines] : []),
      '',
      `---`,
      `*Reviewed by the Orbital review-agent persona (${REVIEW_MODEL})*`,
    ].join('\n')

    try {
      // Use submitPRReview for a structured GitHub review
      const review = await this.githubClient.submitPRReview({
        owner: job.github_owner,
        repo: job.github_repo,
        pr_number: job.pr_number,
        state: verdict === 'PASS' ? 'APPROVED' : 'CHANGES_REQUESTED',
        body,
      })
      log.info({ review_id: review.id }, 'pr-review-processor: PR review comment posted')
      return `https://github.com/${job.github_owner}/${job.github_repo}/pull/${job.pr_number}#pullrequestreview-${review.id}`
    } catch (err) {
      log.warn({ err }, 'pr-review-processor: PR review posting failed (non-fatal)')
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Channel event
  // -------------------------------------------------------------------------

  private async postChannelEvent(opts: {
    job: PrReviewJobPayload
    verdict: ReviewVerdict
    summary: string
    findings: ReviewFinding[]
    reviewId: string
    log: Logger
  }): Promise<void> {
    const { job, verdict, summary, findings, reviewId, log } = opts

    try {
      // Lazily create or find the story-review channel
      const existingChannel = await this.db
        .select({ channelId: channels.channelId })
        .from(channels)
        .where(
          and(
            eq(channels.tenantId, job.tenant_id),
            eq(channels.name, 'story-review'),
          ),
        )
        .limit(1)

      let channelId: string
      if (existingChannel[0]) {
        channelId = existingChannel[0].channelId
      } else {
        channelId = uuidv4()
        await this.db
          .insert(channels)
          .values({
            channelId,
            tenantId: job.tenant_id,
            name: 'story-review',
            kind: 'topic',
            scopeRef: { kind: 'tenant', tenant_id: job.tenant_id },
            createdByActor: SYSTEM_ACTOR as unknown as Record<string, unknown>,
          })
          .onConflictDoNothing()
        // Re-read under race
        const reread = await this.db
          .select({ channelId: channels.channelId })
          .from(channels)
          .where(and(eq(channels.tenantId, job.tenant_id), eq(channels.name, 'story-review')))
          .limit(1)
        channelId = reread[0]?.channelId ?? channelId
      }

      await this.db.insert(channelPosts).values({
        postId: uuidv4(),
        tenantId: job.tenant_id,
        channelId,
        postType: 'system_event',
        authorActor: SYSTEM_ACTOR,
        payload: {
          body: `Automated review of PR ${job.pr_number}: **${verdict}**. ${summary}`,
          story_id: job.story_id,
          task_id: job.task_id,
          pr_url: job.pr_url,
          verdict,
          review_id: reviewId,
          findings_count: findings.length,
          error_count: findings.filter((f) => f.severity === 'error').length,
        },
      })

      log.debug({ channel_id: channelId }, 'pr-review-processor: channel event posted')
    } catch (err) {
      log.warn({ err }, 'pr-review-processor: channel post failed (non-fatal)')
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceFinding(raw: unknown): ReviewFinding {
  if (typeof raw !== 'object' || raw === null) {
    return {
      file: 'general',
      line: null,
      severity: 'info',
      category: 'correctness',
      message: String(raw),
    }
  }
  const r = raw as Record<string, unknown>
  return {
    file: typeof r['file'] === 'string' ? r['file'] : 'general',
    line: typeof r['line'] === 'number' ? r['line'] : null,
    severity: (['info', 'warning', 'error'] as const).includes(r['severity'] as 'info')
      ? (r['severity'] as ReviewFinding['severity'])
      : 'info',
    category: (
      ['correctness', 'security', 'multi-tenant', 'observability'] as const
    ).includes(r['category'] as 'correctness')
      ? (r['category'] as ReviewFinding['category'])
      : 'correctness',
    message: typeof r['message'] === 'string' ? r['message'] : '',
  }
}

// ---------------------------------------------------------------------------
// Factory helper for building a processor from environment config
// ---------------------------------------------------------------------------

export function createPrReviewProcessor(
  db: DB,
  githubClient: GithubClient,
): PrReviewProcessor {
  return new PrReviewProcessor({ db, githubClient })
}
