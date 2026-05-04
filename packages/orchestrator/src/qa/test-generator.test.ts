/**
 * test-generator.test.ts — unit tests for generateTests(), approveArtifact(),
 * rejectArtifact() with in-memory DB stubs.
 *
 * [Engineer-Sr · Sonnet · run-ac-test-generation]
 *
 * Verifies:
 *   - Tenant isolation: cross-tenant access throws NOT FOUND
 *   - No-ACs path: returns committed=false without hitting Claude
 *   - Missing story/project throws
 *   - approve/reject status transitions + guards
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use globalThis as a shared side-channel for captured eq() filter conditions.
// vi.mock() factories run in an isolated scope, but globalThis is shared
// between the mock factory and the test body.
if (!(globalThis as Record<string, unknown>)['__orb_eq_filters']) {
  ;(globalThis as Record<string, unknown>)['__orb_eq_filters'] = []
}
const capturedFilters = (globalThis as Record<string, unknown>)['__orb_eq_filters'] as Array<{ field: string; value: unknown }>

// ---------------------------------------------------------------------------
// ALL vi.mock() calls are hoisted before module imports.
// ---------------------------------------------------------------------------

// Smart @orbital/db mock: Proxy-based table objects let eq() capture field names.
vi.mock('@orbital/db', () => {
  function makeTable(tableName: string) {
    const base: Record<symbol | string, unknown> = {
      [Symbol.for('drizzle:Name')]: tableName,
    }
    return new Proxy(base, {
      get(target, prop) {
        if (typeof prop === 'symbol' || prop in target) {
          return target[prop as string | symbol]
        }
        return { __tableName: tableName, __field: prop as string }
      },
    })
  }

  return {
    stories: makeTable('stories'),
    storyAcceptanceCriteria: makeTable('story_acceptance_criteria'),
    projects: makeTable('projects'),
    storyTestArtifacts: makeTable('story_test_artifacts'),
    eq: (col: unknown, val: unknown) => {
      const c = col as { __field?: string }
      if (c.__field) {
        const filters = (globalThis as Record<string, unknown>)['__orb_eq_filters'] as Array<{ field: string; value: unknown }>
        if (filters) filters.push({ field: c.__field, value: val })
      }
      return 'EQ'
    },
    and: (..._args: unknown[]) => 'AND',
    desc: (_col: unknown) => 'DESC',
    getDb: vi.fn(),
    closeDb: vi.fn(),
    db: {},
    sql: {},
  }
})

vi.mock('../db/client.js', () => ({ db: {}, getDb: vi.fn(), closeDb: vi.fn(), sql: {} }))

// Mock drizzle-orm operators — test-generator imports eq/and directly from drizzle-orm.
vi.mock('drizzle-orm', () => ({
  and: (..._args: unknown[]) => 'AND',
  eq: (col: unknown, val: unknown) => {
    const c = col as { __field?: string }
    if (c.__field) {
      const filters = (globalThis as Record<string, unknown>)['__orb_eq_filters'] as Array<{ field: string; value: unknown }>
      if (filters) filters.push({ field: c.__field, value: val })
    }
    return 'EQ'
  },
  desc: (_col: unknown) => 'DESC',
  inArray: (_col: unknown, _vals: unknown) => 'IN',
  gte: (_col: unknown, _val: unknown) => 'GTE',
  lt: (_col: unknown, _val: unknown) => 'LT',
}))

vi.mock('../db/schema/backlog.js', async () => {
  const mod = await import('@orbital/db')
  return { stories: mod.stories, storyAcceptanceCriteria: mod.storyAcceptanceCriteria }
})
vi.mock('../db/schema/projects.js', async () => {
  const mod = await import('@orbital/db')
  return { projects: mod.projects }
})
vi.mock('../db/schema/story-test-artifacts.js', async () => {
  const mod = await import('@orbital/db')
  return { storyTestArtifacts: mod.storyTestArtifacts }
})

vi.mock('@anthropic-ai/sdk', () => {
  const messages = {
    create: vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            test_file: 'import { test, expect } from "vitest"\ntest("AC1 fails", () => expect(false).toBe(true))',
            test_path: 'src/__tests__/story-abc.test.ts',
            rationale: 'Tests AC1: widget renders correctly',
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 200 },
    }),
  }
  return { default: vi.fn().mockImplementation(() => ({ messages })) }
})

vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ ANTHROPIC_API_KEY: 'test-key', NODE_ENV: 'test', DATABASE_URL: 'postgres://test' }),
}))

vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('./framework-detector.js', () => ({
  detectFramework: vi.fn().mockResolvedValue({
    language: 'typescript',
    framework: 'vitest',
    testDir: 'src/__tests__',
    testFilePattern: 'src/__tests__/**/*.test.ts',
    testFileSuffix: '.test.ts',
  }),
}))

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}))

// Import after all vi.mock() declarations.
import { generateTests, approveArtifact, rejectArtifact } from './test-generator.js'

// ---------------------------------------------------------------------------
// In-memory DB stub
// ---------------------------------------------------------------------------

const TENANT_A = '00000000-0000-0000-0000-000000000001'
const TENANT_B = '00000000-0000-0000-0000-000000000002'
const STORY_ID = '11111111-1111-1111-1111-111111111111'
const PROJECT_ID = '22222222-2222-2222-2222-222222222222'

interface ArtifactRow {
  id: string
  tenantId: string
  projectId: string
  storyId: string
  testPath: string
  language: string
  framework: string
  branch: string | null
  status: string
  generatedAt: Date
  schemaVersion: number
}

interface RowMap {
  stories: Array<{ storyId: string; tenantId: string; title: string; description: string; status: string }>
  storyAcceptanceCriteria: Array<{ acId: string; storyId: string; tenantId: string; ordinal: number; text: string; verifierHint?: string | null }>
  projects: Array<{ projectId: string; tenantId: string; repoCloneUrl?: string | null; githubDefaultBranch?: string }>
  storyTestArtifacts: ArtifactRow[]
}

function buildMockDb(rows: Partial<RowMap> = {}) {
  const store: RowMap = {
    stories: rows.stories ?? [],
    storyAcceptanceCriteria: rows.storyAcceptanceCriteria ?? [],
    projects: rows.projects ?? [],
    storyTestArtifacts: rows.storyTestArtifacts ?? [],
  }

  function getTableName(tableObj: unknown): keyof RowMap {
    const sym = Symbol.for('drizzle:Name')
    const n = (tableObj as Record<symbol, unknown>)[sym]
    if (n === 'stories') return 'stories'
    if (n === 'story_acceptance_criteria') return 'storyAcceptanceCriteria'
    if (n === 'projects') return 'projects'
    if (n === 'story_test_artifacts') return 'storyTestArtifacts'
    return 'storyTestArtifacts'
  }

  function consumeAndFilter<T extends Record<string, unknown>>(allRows: T[]): T[] {
    // Consume all captured filter conditions.
    const conditions = capturedFilters.splice(0, capturedFilters.length)
    if (conditions.length === 0) return allRows
    return allRows.filter((row) =>
      conditions.every((c) => {
        if (row[c.field] === c.value) return true
        // camelCase conversion for Drizzle column descriptors (e.g. tenantId).
        const camel = c.field.replace(/_([a-z])/g, (_, l: string) => l.toUpperCase())
        return row[camel] === c.value
      }),
    )
  }

  const db = {
    _store: store,

    select: (_proj?: unknown) => ({
      from: (table: unknown) => {
        const tableName = getTableName(table)
        // We cannot know exactly when where() is called relative to eq() hoisting,
        // so we lazily evaluate the filter at the terminal call (.limit, .then, etc.)
        return {
          where(_cond: unknown) {
            return {
              orderBy(_col: unknown) {
                return {
                  limit: (n: number) => Promise.resolve(consumeAndFilter(store[tableName] as Record<string, unknown>[]).slice(0, n)),
                  then: (res: (v: unknown[]) => void) => res(consumeAndFilter(store[tableName] as Record<string, unknown>[])),
                }
              },
              limit: (n: number) => Promise.resolve(consumeAndFilter(store[tableName] as Record<string, unknown>[]).slice(0, n)),
              then: (res: (v: unknown[]) => void) => res(consumeAndFilter(store[tableName] as Record<string, unknown>[])),
            }
          },
          orderBy(_col: unknown) {
            return {
              limit: (n: number) => Promise.resolve(consumeAndFilter(store[tableName] as Record<string, unknown>[]).slice(0, n)),
            }
          },
          limit: (n: number) => Promise.resolve(consumeAndFilter(store[tableName] as Record<string, unknown>[]).slice(0, n)),
          then: (res: (v: unknown[]) => void) => res(consumeAndFilter(store[tableName] as Record<string, unknown>[])),
        }
      },
    }),

    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        const tableName = getTableName(table)
        ;(store[tableName] as unknown[]).push(row)
        return Promise.resolve()
      },
    }),

    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          const tableName = getTableName(table)
          const conditions = capturedFilters.splice(0, capturedFilters.length)
          const arr = store[tableName] as Array<Record<string, unknown>>
          for (const row of arr) {
            const matches =
              conditions.length === 0 ||
              conditions.every((c) => {
                const camel = c.field.replace(/_([a-z])/g, (_, l: string) => l.toUpperCase())
                return row[c.field] === c.value || row[camel] === c.value
              })
            if (matches) Object.assign(row, values)
          }
          return Promise.resolve()
        },
      }),
    }),

    delete: (table: unknown) => ({
      where: (_cond: unknown) => {
        const tableName = getTableName(table)
        const conditions = capturedFilters.splice(0, capturedFilters.length)
        const arr = store[tableName] as Array<Record<string, unknown>>
        for (let i = arr.length - 1; i >= 0; i--) {
          const row = arr[i]!
          const matches =
            conditions.length === 0 ||
            conditions.every((c) => {
              const camel = c.field.replace(/_([a-z])/g, (_, l: string) => l.toUpperCase())
              return row[c.field] === c.value || row[camel] === c.value
            })
          if (matches) arr.splice(i, 1)
        }
        return Promise.resolve()
      },
    }),
  }

  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateTests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedFilters.length = 0
  })

  it('throws when story is not found for the given tenantId (tenant isolation)', async () => {
    const db = buildMockDb({
      stories: [
        { storyId: STORY_ID, tenantId: TENANT_A, title: 'Test story', description: 'Desc', status: 'ready' },
      ],
    }) as unknown as Parameters<typeof generateTests>[1]

    await expect(
      generateTests({ tenantId: TENANT_B, projectId: PROJECT_ID, storyId: STORY_ID }, db),
    ).rejects.toThrow(/not found for tenant/)
  })

  it('returns committed=false when story has no ACs', async () => {
    const db = buildMockDb({
      stories: [
        { storyId: STORY_ID, tenantId: TENANT_A, title: 'No ACs story', description: 'Nothing yet', status: 'ready' },
      ],
      storyAcceptanceCriteria: [],
    }) as unknown as Parameters<typeof generateTests>[1]

    const result = await generateTests(
      { tenantId: TENANT_A, projectId: PROJECT_ID, storyId: STORY_ID },
      db,
    )

    expect(result.committed).toBe(false)
    expect(result.summary).toMatch(/No acceptance criteria/i)
    expect(result.artifactId).toBe('')
  })

  it('throws when project is not found for the given tenantId', async () => {
    const db = buildMockDb({
      stories: [
        { storyId: STORY_ID, tenantId: TENANT_A, title: 'Story', description: 'Desc', status: 'ready' },
      ],
      storyAcceptanceCriteria: [
        { acId: 'ac-1', storyId: STORY_ID, tenantId: TENANT_A, ordinal: 1, text: 'AC 1' },
      ],
      projects: [],
    }) as unknown as Parameters<typeof generateTests>[1]

    await expect(
      generateTests({ tenantId: TENANT_A, projectId: PROJECT_ID, storyId: STORY_ID }, db),
    ).rejects.toThrow(/not found for tenant/)
  })

  it('returns an artifact with committed=false when project has no clone URL', async () => {
    const db = buildMockDb({
      stories: [
        { storyId: STORY_ID, tenantId: TENANT_A, title: 'Feature story', description: 'Build the widget', status: 'ready' },
      ],
      storyAcceptanceCriteria: [
        { acId: 'ac-1', storyId: STORY_ID, tenantId: TENANT_A, ordinal: 1, text: 'Widget renders' },
        { acId: 'ac-2', storyId: STORY_ID, tenantId: TENANT_A, ordinal: 2, text: 'Widget handles empty state' },
      ],
      projects: [
        { projectId: PROJECT_ID, tenantId: TENANT_A, repoCloneUrl: null, githubDefaultBranch: 'main' },
      ],
      storyTestArtifacts: [],
    }) as unknown as Parameters<typeof generateTests>[1]

    const result = await generateTests(
      { tenantId: TENANT_A, projectId: PROJECT_ID, storyId: STORY_ID },
      db,
    )

    expect(result.artifactId).not.toBe('')
    expect(result.committed).toBe(false)
    expect(result.language).toBe('typescript')
    expect(result.framework).toBe('vitest')
    expect(result.testPath).toBe('src/__tests__/story-abc.test.ts')
  })
})

describe('approveArtifact', () => {
  beforeEach(() => { capturedFilters.length = 0 })

  it('marks artifact status=merged', async () => {
    const artifact: ArtifactRow = {
      id: 'artifact-1',
      tenantId: TENANT_A,
      projectId: PROJECT_ID,
      storyId: STORY_ID,
      testPath: 'src/__tests__/foo.test.ts',
      language: 'typescript',
      framework: 'vitest',
      branch: 'orbital/tests-abc',
      status: 'pending',
      generatedAt: new Date(),
      schemaVersion: 1,
    }
    const db = buildMockDb({ storyTestArtifacts: [artifact] }) as unknown as Parameters<typeof approveArtifact>[3]

    await approveArtifact('artifact-1', TENANT_A, 'feat/my-branch', db)

    expect(artifact.status).toBe('merged')
  })

  it('throws NOT FOUND when artifact does not belong to tenant (tenant isolation)', async () => {
    const artifact: ArtifactRow = {
      id: 'artifact-1',
      tenantId: TENANT_A,
      projectId: PROJECT_ID,
      storyId: STORY_ID,
      testPath: 'src/__tests__/foo.test.ts',
      language: 'typescript',
      framework: 'vitest',
      branch: null,
      status: 'pending',
      generatedAt: new Date(),
      schemaVersion: 1,
    }
    const db = buildMockDb({ storyTestArtifacts: [artifact] }) as unknown as Parameters<typeof approveArtifact>[3]

    await expect(approveArtifact('artifact-1', TENANT_B, 'main', db)).rejects.toThrow(/not found/)
  })

  it('throws when artifact is not in pending status', async () => {
    const artifact: ArtifactRow = {
      id: 'artifact-1',
      tenantId: TENANT_A,
      projectId: PROJECT_ID,
      storyId: STORY_ID,
      testPath: 'src/__tests__/foo.test.ts',
      language: 'typescript',
      framework: 'vitest',
      branch: null,
      status: 'merged',
      generatedAt: new Date(),
      schemaVersion: 1,
    }
    const db = buildMockDb({ storyTestArtifacts: [artifact] }) as unknown as Parameters<typeof approveArtifact>[3]

    await expect(approveArtifact('artifact-1', TENANT_A, 'main', db)).rejects.toThrow(/expected pending/)
  })
})

describe('rejectArtifact', () => {
  beforeEach(() => { capturedFilters.length = 0 })

  it('deletes a pending artifact row', async () => {
    const artifact: ArtifactRow = {
      id: 'artifact-1',
      tenantId: TENANT_A,
      projectId: PROJECT_ID,
      storyId: STORY_ID,
      testPath: 'src/__tests__/foo.test.ts',
      language: 'typescript',
      framework: 'vitest',
      branch: null,
      status: 'pending',
      generatedAt: new Date(),
      schemaVersion: 1,
    }
    const db = buildMockDb({ storyTestArtifacts: [artifact] }) as unknown as Parameters<typeof rejectArtifact>[2]

    await rejectArtifact('artifact-1', TENANT_A, db)

    expect(db._store.storyTestArtifacts).toHaveLength(0)
  })

  it('throws NOT FOUND for cross-tenant access (tenant isolation)', async () => {
    const artifact: ArtifactRow = {
      id: 'artifact-1',
      tenantId: TENANT_A,
      projectId: PROJECT_ID,
      storyId: STORY_ID,
      testPath: 'src/__tests__/foo.test.ts',
      language: 'typescript',
      framework: 'vitest',
      branch: null,
      status: 'pending',
      generatedAt: new Date(),
      schemaVersion: 1,
    }
    const db = buildMockDb({ storyTestArtifacts: [artifact] }) as unknown as Parameters<typeof rejectArtifact>[2]

    await expect(rejectArtifact('artifact-1', TENANT_B, db)).rejects.toThrow(/not found/)
  })

  it('throws when artifact is not in pending status', async () => {
    const artifact: ArtifactRow = {
      id: 'artifact-1',
      tenantId: TENANT_A,
      projectId: PROJECT_ID,
      storyId: STORY_ID,
      testPath: 'src/__tests__/foo.test.ts',
      language: 'typescript',
      framework: 'vitest',
      branch: null,
      status: 'merged',
      generatedAt: new Date(),
      schemaVersion: 1,
    }
    const db = buildMockDb({ storyTestArtifacts: [artifact] }) as unknown as Parameters<typeof rejectArtifact>[2]

    await expect(rejectArtifact('artifact-1', TENANT_A, db)).rejects.toThrow(/expected pending/)
  })
})
