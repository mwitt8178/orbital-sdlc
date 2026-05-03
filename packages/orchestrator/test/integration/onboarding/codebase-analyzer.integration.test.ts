/**
 * Round 9 — codebase analyzer integration test.
 *
 * Uses a stub GitHub adapter and a stub LLM driver that returns a canned
 * JSON-shaped response, so the LLM path is exercised end-to-end without
 * spending real Anthropic credits.
 *
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { events as eventsTable } from '../../../src/db/schema/events.js'
import {
  createCodebaseAnalyzer,
  type LowLevelGithubRequest,
} from '../../../src/onboarding/codebase-analyzer.js'
import { createEventStore } from '../../../src/events/store.js'
import type { GithubClient } from '../../../src/github/client.js'
import type { LLMDriver, LLMRequest, LLMResponse, ProviderHealth } from '../../../src/drivers/types.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let sqlPool: postgres.Sql

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, idle_timeout: 5, onnotice: () => {} })
})

afterAll(async () => {
  await sqlPool.end({ timeout: 1 })
})

class FixtureLLM implements LLMDriver {
  readonly providerId = 'fixture'
  readonly availableModels = ['fixture-sonnet']
  callCount = 0
  async send(_req: LLMRequest): Promise<LLMResponse> {
    this.callCount += 1
    const text = JSON.stringify({
      readmeSummary: 'Fixture summary of the project intent.',
      entries: [
        {
          kind: 'decision',
          title: 'Use TypeScript',
          body: 'Decided to use TypeScript per ADR.',
          tags: ['typescript', 'language'],
          source: { kind: 'adr', ref: 'docs/decisions/001-typescript.md' },
        },
        {
          kind: 'convention',
          title: 'Vitest',
          body: 'All tests use Vitest with co-located test files.',
          tags: ['testing'],
        },
        {
          kind: 'glossary',
          title: 'AC',
          body: 'Acceptance Criterion.',
          tags: ['glossary'],
        },
      ],
    })
    return {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1500, output_tokens: 800 },
      raw: { fixture: true },
    }
  }
  async health(): Promise<ProviderHealth> {
    return {
      healthy: true,
      providerId: this.providerId,
      lastCheckedAt: new Date().toISOString(),
    }
  }
}

function makeStubGithub(): { raw: LowLevelGithubRequest; client: GithubClient } {
  const raw: LowLevelGithubRequest = {
    request: async <T>(_method, pathStr): Promise<T | null> => {
      if (pathStr.includes('/contents/package.json')) {
        return {
          content: Buffer.from(
            JSON.stringify({
              dependencies: { typescript: '^5', react: '^18', vitest: '^1' },
            }),
          ).toString('base64'),
          encoding: 'base64',
        } as unknown as T
      }
      if (pathStr.includes('/contents/README.md')) {
        return {
          content: Buffer.from('# Fixture').toString('base64'),
          encoding: 'base64',
        } as unknown as T
      }
      if (pathStr.includes('/contents/.github/workflows')) {
        return [{ name: 'ci.yml', type: 'file' }] as unknown as T
      }
      if (pathStr.includes('/contents/docs/decisions')) {
        return [
          {
            name: '001-typescript.md',
            type: 'file',
            path: 'docs/decisions/001-typescript.md',
          },
        ] as unknown as T
      }
      if (pathStr.includes('/contents/docs/decisions/001-typescript.md')) {
        return {
          content: Buffer.from('# Use TypeScript\n\nThe team chose TS.').toString('base64'),
          encoding: 'base64',
        } as unknown as T
      }
      if (pathStr.includes('/commits?per_page=30')) {
        return Array.from({ length: 30 }, () => ({
          commit: { message: 'feat: x' },
        })) as unknown as T
      }
      if (pathStr.includes('/pulls?state=closed')) {
        return [] as unknown as T
      }
      return null
    },
  }
  const client: GithubClient = {
    getAuthenticatedUser: async () => ({ login: 'mwitt' }),
    getRepo: async () => null,
    createRepo: async () => {
      throw new Error('not used')
    },
    listBranches: async () => [
      { name: 'main', commitSha: 'a', protected: true },
      { name: 'feat/x', commitSha: 'b', protected: false },
    ],
    getBranch: async () => null,
    createBranch: async () => ({ name: 'x', commitSha: 'y', protected: false }),
    createPullRequest: async () => ({ pr_number: 1, html_url: 'https://x' }),
    addLabels: async () => undefined,
    mergePullRequest: async () => ({ sha: 'd' }),
    listOpenPullRequestsByLabel: async () => [],
    getPullRequest: async () => null,
    listCheckRuns: async () => [],
    rerunCheckRun: async () => undefined,
    createReviewComment: async () => ({ id: 1 }),
    submitPRReview: async () => ({ id: 1 }),
    rawRequest: async <T>(method, pathStr, body, options) =>
      raw.request<T>(method, pathStr, body, options),
  }
  return { raw, client }
}

describe('Round 9 — codebase analyzer LLM path', () => {
  it('returns LLM-derived entries when useLLM=true and an LLM driver is wired', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const { raw, client } = makeStubGithub()
    const llm = new FixtureLLM()
    const analyzer = createCodebaseAnalyzer(eventStore, client, raw, llm, 'fixture-sonnet')

    const projectId = uuidv7()
    const report = await analyzer.analyze({
      sessionId: uuidv7(),
      projectId,
      owner: 'mwitt',
      repo: 'apprentice',
      useLLM: true,
    })

    expect(report.llmUsed).toBe(true)
    expect(llm.callCount).toBe(1)
    expect(report.inferredMemoryEntries.length).toBe(3)
    expect(report.inferredMemoryEntries.some((e) => e.kind === 'decision' && e.title.includes('TypeScript'))).toBe(true)
    expect(report.readmeSummary).toContain('Fixture')
    expect(report.llmCostUsd).toBeGreaterThan(0)

    // audit.events append-only — no cleanup
    void projectId
  })

  it('estimate() returns a positive cost', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const { raw, client } = makeStubGithub()
    const llm = new FixtureLLM()
    const analyzer = createCodebaseAnalyzer(eventStore, client, raw, llm)

    const est = await analyzer.estimate({ owner: 'mwitt', repo: 'apprentice' })
    expect(est.costUsd).toBeGreaterThan(0)
    expect(est.plan).toContain('apprentice')
  })
})
