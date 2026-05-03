/**
 * Round 9 — Onboarding UX Overhaul: integration test for the new-project flow.
 *
 * Real Postgres + real EventStore. Monday + GitHub clients are stubbed
 * in-process (the brief permits stub HTTP at the Monday/GitHub boundaries
 * for fast, deterministic tests; the surrounding orchestration is real).
 *
 * Verifies:
 *   - Session persistence in onboarding_sessions
 *   - Monday board provisioning emits MondayBoardProvisioned + writes
 *     board_mappings row
 *   - GitHub repo provisioning emits GitRepoProvisioned
 *   - System teach generates project CLAUDE.md + skill bundle
 *   - Memory seed writes project_memory_entries rows
 *   - completeSession emits OnboardingCompleted
 *
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
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
import { onboardingSessions } from '../../../src/db/schema/onboarding.js'
import { boardMappings } from '../../../src/db/schema/board-mapping.js'
import { projectMemoryEntries } from '../../../src/db/schema/memory.js'
import {
  createOnboardingFlowService,
} from '../../../src/onboarding/flows.js'
import {
  createMondayProvisioner,
  CANONICAL_COLUMNS,
} from '../../../src/onboarding/monday-provisioner.js'
import {
  createGithubProvisioner,
  type LowLevelGithubRequest,
} from '../../../src/onboarding/github-provisioner.js'
import { createSystemTeacher } from '../../../src/onboarding/system-teacher.js'
import { createMemorySeeder } from '../../../src/onboarding/memory-seeder.js'
import { createMemoryService } from '../../../src/memory/service.js'
import { createEventStore } from '../../../src/events/store.js'
import type { MondayClient } from '../../../src/backlog/monday-client.js'
import type { GithubClient } from '../../../src/github/client.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let sqlPool: postgres.Sql
let tmpHome: string
let originalHome: string | undefined
let originalDb: string | undefined

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, idle_timeout: 5, onnotice: () => {} })
  const db = drizzle(sqlPool)
  // Apply migration 0037 inline if the table is absent — tests should run on
  // a fresh DB or one missing this round.
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
    // Drizzle migrator splits on `--> statement-breakpoint`; the postgres-js
    // pool here doesn't, so we split ourselves.
    const statements = migration
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'))
    for (const stmt of statements) {
      await sqlPool.unsafe(stmt)
    }
  }
})

afterAll(async () => {
  await sqlPool.end({ timeout: 1 })
})

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-r9-int-'))
  originalHome = process.env['ORBITAL_HOME']
  originalDb = process.env['DATABASE_URL']
  process.env['ORBITAL_HOME'] = tmpHome
  process.env['DATABASE_URL'] = DATABASE_URL
  resetInstallCache()
  resetEnvCache()
  resetKeychainCache()
})

afterEach(async () => {
  if (originalHome !== undefined) process.env['ORBITAL_HOME'] = originalHome
  else delete process.env['ORBITAL_HOME']
  if (originalDb !== undefined) process.env['DATABASE_URL'] = originalDb
  else delete process.env['DATABASE_URL']
  resetInstallCache()
  resetEnvCache()
  resetKeychainCache()
  await fs.rm(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Stub Monday client — captures graphql() invocations
// ---------------------------------------------------------------------------

interface RecordedCall {
  query: string
  variables: Record<string, unknown>
}

function makeStubMondayClient(opts: { boardId: string; columnIdSeed: string }): {
  client: MondayClient
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  let columnSeq = 0
  const client: MondayClient = {
    createSubitem: async () => ({ id: '1' }),
    getItem: async () => null,
    getBoardItems: async () => [],
    updateColumnValue: async () => ({ id: '1' }),
    graphql: async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ query, variables })
      if (query.includes('create_board')) {
        return {
          create_board: {
            id: opts.boardId,
            name: variables['name'],
            url: `https://view.monday.com/boards/${opts.boardId}`,
            workspace: { id: '12345' },
          },
        } as unknown as T
      }
      if (query.includes('create_column')) {
        columnSeq += 1
        return {
          create_column: {
            id: `${opts.columnIdSeed}-${columnSeq}`,
            title: variables['title'],
            type: variables['type'],
          },
        } as unknown as T
      }
      throw new Error(`stub Monday client received unexpected query: ${query.slice(0, 80)}`)
    },
  }
  return { client, calls }
}

// ---------------------------------------------------------------------------
// Stub LowLevelGithubRequest — records every API call and returns canned
// responses appropriate for create_repo / contents PUT / labels / hooks.
// ---------------------------------------------------------------------------

function makeStubGithubClient(): {
  raw: LowLevelGithubRequest
  client: GithubClient
  calls: Array<{ method: string; path: string; body: unknown }>
} {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const raw: LowLevelGithubRequest = {
    request: async <T>(
      method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      pathStr: string,
      body?: unknown,
      _options?: { allow404?: boolean },
    ): Promise<T | null> => {
      calls.push({ method, path: pathStr, body })
      if (method === 'POST' && pathStr.endsWith('/user/repos')) {
        return {
          id: 1,
          name: (body as { name: string }).name,
          full_name: `mwitt/${(body as { name: string }).name}`,
          owner: { login: 'mwitt' },
          private: (body as { private: boolean }).private,
          default_branch: 'main',
          html_url: `https://github.com/mwitt/${(body as { name: string }).name}`,
        } as unknown as T
      }
      if (method === 'GET' && pathStr.includes('/contents/')) {
        // Return null/404 — file doesn't exist yet, so PUT will create.
        return null
      }
      if (method === 'PUT' && pathStr.includes('/contents/')) {
        return {
          content: { sha: 'mocked-sha-' + calls.length },
        } as unknown as T
      }
      // Labels POST + Hooks POST + everything else → 200 with empty body.
      return null
    },
  }
  const client: GithubClient = {
    getAuthenticatedUser: async () => ({ login: 'mwitt' }),
    getRepo: async () => null,
    createRepo: async () => {
      throw new Error('stub: createRepo not used; provisioner uses raw request')
    },
    listBranches: async () => [],
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
  return { raw, client, calls }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Round 9 — new-project flow (integration)', () => {
  it('creates session, provisions Monday board, persists mapping, emits MondayBoardProvisioned', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const flow = createOnboardingFlowService(db, eventStore)
    const { client: mondayClient, calls: mondayCalls } = makeStubMondayClient({
      boardId: 'board-' + Date.now(),
      columnIdSeed: 'col',
    })
    const provisioner = createMondayProvisioner(db, eventStore, mondayClient)

    const installId = uuidv7()
    const session = await flow.start({ installId, flow: 'new_project' })
    expect(session.flow).toBe('new_project')
    expect(session.currentStep).toBe('project_basics')

    const projectId = uuidv7()
    const result = await provisioner.provision({
      sessionId: session.sessionId,
      projectId,
      projectName: 'TestProj',
      isPrivate: true,
    })

    expect(result.boardId).toMatch(/^board-/)
    expect(result.columnsAdded).toBe(CANONICAL_COLUMNS.length)
    expect(Object.keys(result.columnIdsByCanonical)).toContain('workflow_status')
    expect(Object.keys(result.columnIdsByCanonical)).toContain('risk_tier')

    // Monday calls captured (1 create_board + N create_column)
    expect(mondayCalls.length).toBe(1 + CANONICAL_COLUMNS.length)

    // board_mappings row was written
    const mappingRows = await db
      .select()
      .from(boardMappings)
      .where(eq(boardMappings.projectId, projectId))
    expect(mappingRows.length).toBe(1)
    const mappingRow = mappingRows[0]!
    expect(mappingRow.confirmedAt).not.toBeNull()
    expect((mappingRow.mappingJson as { columns: Record<string, string> }).columns['workflow_status']).toBeTruthy()

    // MondayBoardProvisioned event emitted
    const evRows = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.aggregateId, projectId))
    expect(evRows.find((e) => e.eventType === 'MondayBoardProvisioned')).toBeTruthy()

    // Cleanup (audit.events is append-only — only tables we own get cleared)
    await db.delete(boardMappings).where(eq(boardMappings.projectId, projectId))
    await db.delete(onboardingSessions).where(eq(onboardingSessions.sessionId, session.sessionId))
  })

  it('provisions GitHub repo, commits initial files, emits GitRepoProvisioned', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const { raw, client: githubClient, calls } = makeStubGithubClient()
    const provisioner = createGithubProvisioner(db, eventStore, githubClient, raw)

    const projectId = uuidv7()
    const installId = uuidv7()
    const sessionId = uuidv7()

    const result = await provisioner.provision({
      sessionId,
      projectId,
      name: 'apprentice',
      description: 'Test repo',
      isPrivate: true,
      stack: 'nodejs',
      license: 'mit',
    })

    expect(result.owner).toBe('mwitt')
    expect(result.repo).toBe('apprentice')
    expect(result.ciWorkflowCommitted).toBe(true)
    expect(result.labelsCreated.length).toBeGreaterThan(0)

    // The provisioner POSTed create_repo, then PUT README + .gitignore +
    // LICENSE + CI workflow + 8 labels.
    const repoCreates = calls.filter((c) => c.method === 'POST' && c.path === '/user/repos')
    expect(repoCreates.length).toBe(1)
    const fileCommits = calls.filter((c) => c.method === 'PUT' && c.path.includes('/contents/'))
    expect(fileCommits.length).toBeGreaterThanOrEqual(4)

    // GitRepoProvisioned event emitted
    const evRows = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.aggregateId, projectId))
    expect(evRows.find((e) => e.eventType === 'GitRepoProvisioned')).toBeTruthy()

    void installId
    void onboardingSessions
  })

  it('seeds memory from vision and configures system → emits ProjectSDLCConfigured', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const memoryService = createMemoryService(db, eventStore)
    const seeder = createMemorySeeder(memoryService)
    const teacher = createSystemTeacher(eventStore, null)

    const projectId = uuidv7()
    const sessionId = uuidv7()

    const seed = await seeder.seedFromVision({
      projectId,
      intent: 'A test project to demonstrate the new-project flow.',
      stack: ['nodejs', 'typescript', 'react'],
      conventions: [{ title: 'Conventional Commits', body: 'feat:/fix:/chore:/docs:' }],
      glossary: [{ term: 'AC', definition: 'Acceptance Criterion.' }],
    })

    expect(seed.entryIds.length).toBeGreaterThanOrEqual(3)

    const memRows = await db
      .select()
      .from(projectMemoryEntries)
      .where(eq(projectMemoryEntries.projectId, projectId))
    expect(memRows.length).toBe(seed.entryIds.length)

    const cfg = await teacher.teach({
      sessionId,
      projectId,
      projectName: 'TestProj',
      vision: { intent: 'Test', stack: ['nodejs'] },
      memoryEntryIds: seed.entryIds,
    })

    expect(cfg.skillsEnabled.length).toBeGreaterThan(0)
    expect(cfg.skillsConfigPath).toMatch(/skills\.json$/)

    const skillsJson = JSON.parse(await fs.readFile(cfg.skillsConfigPath, 'utf-8'))
    expect(skillsJson.projectId).toBe(projectId)
    expect(Array.isArray(skillsJson.skills)).toBe(true)

    // Local CLAUDE.md present
    const claudeMdPath = path.join(path.dirname(cfg.skillsConfigPath), 'CLAUDE.md')
    const claudeMdContent = await fs.readFile(claudeMdPath, 'utf-8')
    expect(claudeMdContent).toContain('TestProj')

    // ProjectSDLCConfigured event emitted
    const evRows = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.aggregateId, projectId))
    expect(evRows.find((e) => e.eventType === 'ProjectSDLCConfigured')).toBeTruthy()

    // Cleanup (audit.events append-only)
    await db.delete(projectMemoryEntries).where(eq(projectMemoryEntries.projectId, projectId))
  })

  it('completeSession emits OnboardingCompleted with step durations', async () => {
    const db = drizzle(sqlPool)
    const eventStore = createEventStore(db, sqlPool)
    const flow = createOnboardingFlowService(db, eventStore)

    const installId = uuidv7()
    const session = await flow.start({ installId, flow: 'new_project' })
    await flow.update({ sessionId: session.sessionId, step: 'connect_tools' })
    await flow.update({ sessionId: session.sessionId, step: 'vision_intake' })

    const completed = await flow.complete(session.sessionId, null)
    expect(completed.status).toBe('completed')

    const evRows = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.aggregateId, installId))
    const completedEv = evRows.find((e) => e.eventType === 'OnboardingCompleted')
    expect(completedEv).toBeTruthy()
    const payload = completedEv!.payload as { step_durations: Record<string, number> }
    expect(typeof payload.step_durations).toBe('object')

    // Cleanup (audit.events append-only)
    await db.delete(onboardingSessions).where(eq(onboardingSessions.sessionId, session.sessionId))
  })
})
