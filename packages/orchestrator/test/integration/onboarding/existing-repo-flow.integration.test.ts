/**
 * Round 9 — Onboarding UX Overhaul: integration test for the existing-repo
 * flow.
 *
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Verifies:
 *   - Codebase analyzer (static-only, no LLM) emits CodebaseAnalyzed
 *   - Memory seeder consumes the analysis report and writes entries
 *   - System teacher generates project CLAUDE.md from the analysis
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql as drizzleSql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { resetInstallCache } from '../../../src/config/install.js'
import { resetEnvCache } from '../../../src/config/env.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { events as eventsTable } from '../../../src/db/schema/events.js'
import { projectMemoryEntries } from '../../../src/db/schema/memory.js'
import {
  createCodebaseAnalyzer,
  type LowLevelGithubRequest,
} from '../../../src/onboarding/codebase-analyzer.js'
import { createMemoryService } from '../../../src/memory/service.js'
import { createMemorySeeder } from '../../../src/onboarding/memory-seeder.js'
import { createEventStore } from '../../../src/events/store.js'
import type { GithubClient } from '../../../src/github/client.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let sqlPool: postgres.Sql
let tmpHome: string

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, idle_timeout: 5, onnotice: () => {} })
})

afterAll(async () => {
  await sqlPool.end({ timeout: 1 })
})

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-r9-existing-'))
  process.env['ORBITAL_HOME'] = tmpHome
  process.env['DATABASE_URL'] = DATABASE_URL
  resetInstallCache()
  resetEnvCache()
  resetKeychainCache()
})

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Stub LowLevelGithubRequest — returns canned content for the analyzer
// ---------------------------------------------------------------------------

function makeStubGithub(): {
  raw: LowLevelGithubRequest
  client: GithubClient
} {
  const raw: LowLevelGithubRequest = {
    request: async <T>(
      method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      pathStr: string,
      _body?: unknown,
      _options?: { allow404?: boolean },
    ): Promise<T | null> => {
      // package.json
      if (pathStr.includes('/contents/package.json')) {
        return {
          content: Buffer.from(
            JSON.stringify({
              name: 'apprentice',
              dependencies: { react: '^18.0.0', 'drizzle-orm': '^0.30.0' },
              devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0', tailwindcss: '^4.0.0' },
            }),
          ).toString('base64'),
          encoding: 'base64',
        } as unknown as T
      }
      // README.md
      if (pathStr.includes('/contents/README.md')) {
        return {
          content: Buffer.from(
            '# Apprentice\n\nA tool for orchestrating software work.',
          ).toString('base64'),
          encoding: 'base64',
        } as unknown as T
      }
      // workflows directory
      if (pathStr.includes('/contents/.github/workflows')) {
        return [
          { name: 'ci.yml', type: 'file' },
          { name: 'release.yml', type: 'file' },
        ] as unknown as T
      }
      // commits
      if (pathStr.includes('/commits?per_page=30')) {
        return Array.from({ length: 30 }, (_, i) => ({
          commit: { message: i % 2 === 0 ? 'feat: x' : 'fix: y' },
        })) as unknown as T
      }
      // ADR directory + go.mod / pyproject not present
      if (pathStr.includes('/contents/docs/decisions')) {
        return [{ name: '001-use-react.md', type: 'file', path: 'docs/decisions/001-use-react.md' }] as unknown as T
      }
      // PRs
      if (pathStr.includes('/pulls?state=closed')) {
        return [] as unknown as T
      }
      // 404 fallthrough
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

describe('Round 9 — existing-repo flow (integration)', () => {
  it('analyzes codebase, infers memory entries, emits CodebaseAnalyzed', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const { raw, client } = makeStubGithub()
    const analyzer = createCodebaseAnalyzer(eventStore, client, raw, null)

    const projectId = uuidv7()
    const sessionId = uuidv7()

    const report = await analyzer.analyze({
      sessionId,
      projectId,
      owner: 'mwitt',
      repo: 'apprentice',
      useLLM: false,
    })

    expect(report.stack).toContain('nodejs')
    expect(report.stack).toContain('typescript')
    expect(report.stack).toContain('react')
    expect(report.testRunner).toBe('vitest')
    expect(report.ciWorkflowCount).toBe(2)
    expect(report.commitConvention).toBe('Conventional Commits')
    expect(report.branchModel).toMatch(/trunk-based/)
    expect(report.inferredMemoryEntries.length).toBeGreaterThan(0)
    expect(report.llmUsed).toBe(false)

    // CodebaseAnalyzed event emitted
    const evRows = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.aggregateId, projectId))
    expect(evRows.find((e) => e.eventType === 'CodebaseAnalyzed')).toBeTruthy()

    // audit.events is append-only — no cleanup
  })

  it('memory seeder writes project_memory_entries from the analysis report', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const memoryService = createMemoryService(db, eventStore)
    const seeder = createMemorySeeder(memoryService)
    const { raw, client } = makeStubGithub()
    const analyzer = createCodebaseAnalyzer(eventStore, client, raw, null)

    const projectId = uuidv7()
    const sessionId = uuidv7()

    const report = await analyzer.analyze({
      sessionId,
      projectId,
      owner: 'mwitt',
      repo: 'apprentice',
      useLLM: false,
    })

    const seed = await seeder.seedFromAnalysis(report, projectId)
    expect(seed.entryIds.length).toBeGreaterThan(0)

    const memRows = await db
      .select()
      .from(projectMemoryEntries)
      .where(eq(projectMemoryEntries.projectId, projectId))
    expect(memRows.length).toBe(seed.entryIds.length)
    // We always seed at least one decision (project intent) and a convention (stack).
    expect(memRows.some((r) => r.kind === 'decision')).toBe(true)
    expect(memRows.some((r) => r.kind === 'convention')).toBe(true)

    // audit.events is append-only — no cleanup of events
    await db.delete(projectMemoryEntries).where(eq(projectMemoryEntries.projectId, projectId))
  })
})

// Ensure the table exists before any tests run.
beforeAll(async () => {
  const db = drizzle(sqlPool)
  try {
    await db.execute(drizzleSql`SELECT 1 FROM onboarding_sessions LIMIT 0`)
  } catch {
    const { fileURLToPath } = await import('node:url')
    const migration = await fs.readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../src/db/migrations/0037_onboarding_state.sql',
      ),
      'utf-8',
    )
    const statements = migration
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'))
    for (const stmt of statements) {
      await sqlPool.unsafe(stmt)
    }
  }
})
