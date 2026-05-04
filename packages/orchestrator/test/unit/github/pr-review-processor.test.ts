/**
 * Unit tests for github/pr-review-processor.ts
 *
 * [Engineer-Sr · Sonnet · run-pr-review-agent-001]
 *
 * Covers:
 *   1. PASS verdict when no error-severity findings present.
 *   2. BLOCK verdict when error-severity findings present.
 *   3. PR comment posted via submitPRReview.
 *   4. pr_reviews row inserted with correct tenant_id (isolation).
 *   5. stories.review_status updated to matching value.
 *   6. Malformed JSON from model → PASS with parse-error info finding.
 *   7. GitHub PR comment failure is non-fatal (no throw).
 *   8. Tenant isolation: row written with job.tenant_id, not a hardcoded value.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { PrReviewProcessor } from '../../../src/github/pr-review-processor.js'
import type { GithubClient } from '../../../src/github/client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000000'
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000000'

function makeJob(overrides: {
  tenant_id?: string
  story_id?: string | null
  project_id?: string | null
  pr_number?: number
  github_owner?: string
  github_repo?: string
} = {}) {
  // Use 'story_id' in overrides to distinguish explicit null from absent
  const storyId = 'story_id' in overrides ? overrides.story_id ?? null : 'story-uuid-1'
  return {
    kind: 'pr_review' as const,
    tenant_id: overrides.tenant_id ?? TENANT_A,
    project_id: overrides.project_id ?? 'proj-uuid-1',
    story_id: storyId,
    task_id: 'task-uuid-1',
    pr_number: overrides.pr_number ?? 42,
    pr_url: `https://github.com/${overrides.github_owner ?? 'org'}/${overrides.github_repo ?? 'repo'}/pull/${overrides.pr_number ?? 42}`,
    head_sha: 'abc123',
    github_owner: overrides.github_owner ?? 'org',
    github_repo: overrides.github_repo ?? 'repo',
  }
}

function makeAnthropicClient(responseText: string): Anthropic {
  const mock = {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    },
  }
  return mock as unknown as Anthropic
}

function makeGithubClient(opts: {
  rawRequestReturn?: unknown
  submitReviewReturn?: { id: number }
  failReview?: boolean
} = {}): GithubClient {
  const files = [
    {
      filename: 'src/foo.ts',
      status: 'modified',
      additions: 5,
      deletions: 2,
      patch: '@@ -1,3 +1,4 @@\n+const x = 1\n const y = 2',
    },
  ]
  return {
    rawRequest: vi.fn()
      .mockResolvedValueOnce(files), // first call: PR files
    submitPRReview: opts.failReview
      ? vi.fn().mockRejectedValue(new Error('GitHub API error'))
      : vi.fn().mockResolvedValue(opts.submitReviewReturn ?? { id: 999 }),
  } as unknown as GithubClient
}

function makeDb(opts: {
  insertSpy?: ReturnType<typeof vi.fn>
  executeSpy?: ReturnType<typeof vi.fn>
  selectReturn?: unknown[]
  tenantToCheck?: string
} = {}) {
  const insertSpy = opts.insertSpy ?? vi.fn()
  const executeSpy = opts.executeSpy ?? vi.fn().mockResolvedValue(undefined)

  const insertChain = {
    values: vi.fn().mockImplementation((row: Record<string, unknown>) => {
      insertSpy(row)
      return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }
    }),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  }

  // Channels select: return no existing channel (triggers insert path)
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(opts.selectReturn ?? []),
    orderBy: vi.fn().mockReturnThis(),
  }

  return {
    insert: vi.fn().mockReturnValue(insertChain),
    select: vi.fn().mockReturnValue(selectChain),
    execute: executeSpy,
    _insertSpy: insertSpy,
    _executeSpy: executeSpy,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PrReviewProcessor', () => {
  describe('PASS verdict', () => {
    it('returns PASS when opus produces no error findings', async () => {
      const passResponse = JSON.stringify({
        verdict: 'PASS',
        summary: 'Looks good.',
        findings: [
          { file: 'src/foo.ts', line: 3, severity: 'info', category: 'observability', message: 'Minor log suggestion.' },
        ],
      })
      const db = makeDb()
      const githubClient = makeGithubClient()
      const anthropic = makeAnthropicClient(passResponse)
      const processor = new PrReviewProcessor({ db: db as never, githubClient, anthropicClient: anthropic })

      const result = await processor.process(makeJob())

      expect(result.verdict).toBe('PASS')
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0]!.severity).toBe('info')
    })

    it('inserts pr_reviews row with correct tenant_id', async () => {
      const passResponse = JSON.stringify({ verdict: 'PASS', summary: 'ok', findings: [] })
      const db = makeDb()
      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient: makeGithubClient(),
        anthropicClient: makeAnthropicClient(passResponse),
      })

      await processor.process(makeJob({ tenant_id: TENANT_A }))

      expect(db.insert).toHaveBeenCalled()
      const insertCall = db._insertSpy.mock.calls[0]?.[0] as Record<string, unknown>
      expect(insertCall['tenantId']).toBe(TENANT_A)
    })

    it('updates stories.review_status to "pass"', async () => {
      const passResponse = JSON.stringify({ verdict: 'PASS', summary: 'ok', findings: [] })
      const db = makeDb()
      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient: makeGithubClient(),
        anthropicClient: makeAnthropicClient(passResponse),
      })

      await processor.process(makeJob({ story_id: 'story-abc' }))

      // execute should have been called with the UPDATE containing 'pass'
      const executeCalls = db._executeSpy.mock.calls
      const hasPassUpdate = executeCalls.some((call: unknown[]) => {
        const arg = call[0]
        const str = arg && typeof arg === 'object' && 'sql' in arg
          ? String((arg as { sql: string }).sql)
          : String(arg)
        return str.includes('pass') || JSON.stringify(arg).includes('pass')
      })
      expect(hasPassUpdate).toBe(true)
    })
  })

  describe('BLOCK verdict', () => {
    it('returns BLOCK when opus produces error-severity findings', async () => {
      const blockResponse = JSON.stringify({
        verdict: 'BLOCK',
        summary: 'Critical security issue found.',
        findings: [
          { file: 'src/auth.ts', line: 42, severity: 'error', category: 'security', message: 'Auth token logged in plaintext.' },
        ],
      })
      const db = makeDb()
      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient: makeGithubClient(),
        anthropicClient: makeAnthropicClient(blockResponse),
      })

      const result = await processor.process(makeJob())

      expect(result.verdict).toBe('BLOCK')
      expect(result.findings[0]!.severity).toBe('error')
      expect(result.findings[0]!.category).toBe('security')
    })

    it('updates stories.review_status to "block"', async () => {
      const blockResponse = JSON.stringify({
        verdict: 'BLOCK',
        summary: 'Bad.',
        findings: [{ file: 'x.ts', line: 1, severity: 'error', category: 'correctness', message: 'Bug.' }],
      })
      const db = makeDb()
      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient: makeGithubClient(),
        anthropicClient: makeAnthropicClient(blockResponse),
      })

      await processor.process(makeJob({ story_id: 'story-block-1' }))

      const executeCalls = db._executeSpy.mock.calls
      const hasBlockUpdate = executeCalls.some((call: unknown[]) => {
        const arg = call[0]
        return JSON.stringify(arg).includes('block')
      })
      expect(hasBlockUpdate).toBe(true)
    })

    it('submits CHANGES_REQUESTED GitHub review on BLOCK', async () => {
      const blockResponse = JSON.stringify({
        verdict: 'BLOCK',
        summary: 'Error.',
        findings: [{ file: 'f.ts', line: null, severity: 'error', category: 'multi-tenant', message: 'Missing tenant filter.' }],
      })
      const githubClient = makeGithubClient()
      const db = makeDb()
      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient,
        anthropicClient: makeAnthropicClient(blockResponse),
      })

      await processor.process(makeJob())

      expect(githubClient.submitPRReview).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'CHANGES_REQUESTED' }),
      )
    })

    it('submits APPROVED GitHub review on PASS', async () => {
      const passResponse = JSON.stringify({ verdict: 'PASS', summary: 'OK.', findings: [] })
      const githubClient = makeGithubClient()
      const db = makeDb()
      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient,
        anthropicClient: makeAnthropicClient(passResponse),
      })

      await processor.process(makeJob())

      expect(githubClient.submitPRReview).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'APPROVED' }),
      )
    })
  })

  describe('malformed JSON', () => {
    it('falls back to PASS with parse-error info finding on invalid JSON', async () => {
      const badResponse = 'I cannot review this PR because...' // not JSON
      const db = makeDb()
      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient: makeGithubClient(),
        anthropicClient: makeAnthropicClient(badResponse),
      })

      const result = await processor.process(makeJob())

      expect(result.verdict).toBe('PASS')
      expect(result.findings.some((f) => f.severity === 'info' && f.category === 'correctness')).toBe(true)
    })
  })

  describe('PR comment failure', () => {
    it('does not throw when GitHub review posting fails', async () => {
      const passResponse = JSON.stringify({ verdict: 'PASS', summary: 'ok', findings: [] })
      const db = makeDb()
      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient: makeGithubClient({ failReview: true }),
        anthropicClient: makeAnthropicClient(passResponse),
      })

      // Should resolve without throwing even though submitPRReview fails
      await expect(processor.process(makeJob())).resolves.toMatchObject({
        verdict: 'PASS',
        prCommentUrl: null,
      })
    })
  })

  describe('tenant isolation', () => {
    it('writes tenant_id from job payload, never a hardcoded value', async () => {
      const passResponse = JSON.stringify({ verdict: 'PASS', summary: 'ok', findings: [] })
      const db = makeDb()
      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient: makeGithubClient(),
        anthropicClient: makeAnthropicClient(passResponse),
      })

      await processor.process(makeJob({ tenant_id: TENANT_B }))

      const insertCall = db._insertSpy.mock.calls[0]?.[0] as Record<string, unknown>
      expect(insertCall['tenantId']).toBe(TENANT_B)
      expect(insertCall['tenantId']).not.toBe(TENANT_A)
    })

    it('does not update review_status when story_id is null', async () => {
      const passResponse = JSON.stringify({ verdict: 'PASS', summary: 'ok', findings: [] })
      // Use a db with a spy that records execute arguments as strings
      const executeSpy = vi.fn().mockResolvedValue(undefined)
      const db = makeDb({ executeSpy })

      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient: makeGithubClient(),
        anthropicClient: makeAnthropicClient(passResponse),
      })

      await processor.process(makeJob({ story_id: null }))

      // execute should not have been called at all — no story_id means no UPDATE
      expect(executeSpy).not.toHaveBeenCalled()
    })
  })

  describe('cost tracking', () => {
    it('returns a positive costUsd based on token usage', async () => {
      const passResponse = JSON.stringify({ verdict: 'PASS', summary: 'ok', findings: [] })
      const db = makeDb()
      const processor = new PrReviewProcessor({
        db: db as never,
        githubClient: makeGithubClient(),
        anthropicClient: makeAnthropicClient(passResponse),
      })

      const result = await processor.process(makeJob())

      expect(result.costUsd).toBeGreaterThan(0)
    })
  })
})
