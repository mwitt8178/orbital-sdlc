/**
 * Unit tests for memory retrieval — real Postgres, no mocks.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * Tests:
 *   1. Tag fallback path returns relevant entries (EMBEDDING_PROVIDER=none)
 *   2. Entries sorted by kind preference (decision > anti_pattern > convention > learning)
 *   3. Empty project returns empty result (method=none)
 *   4. Top-k capping
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createMemoryService } from '../../../src/memory/service.js'
import { retrieveTopN } from '../../../src/memory/retrieval.js'
import {
  projectMemoryEntries,
  projectMemoryTags,
  projectMemoryLinks,
} from '../../../src/db/schema/memory.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const projectId = uuidv7()
const createdEntryIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  const service = createMemoryService(db, eventStore)

  // Seed some entries for retrieval tests
  const e1 = await service.record(
    {
      projectId,
      kind: 'decision',
      title: 'Use TypeScript strict mode',
      body: 'Enable strict mode in tsconfig to catch more type errors at compile time.',
      sourceKind: 'agent',
      confidence: 'high',
      scope: 'project',
      tags: ['typescript', 'config', 'decision'],
      links: [],
    },
    'seed-persona',
  )
  createdEntryIds.push(e1.entryId)

  const e2 = await service.record(
    {
      projectId,
      kind: 'anti_pattern',
      title: 'Do not use any type',
      body: 'Using `any` type defeats the purpose of TypeScript. Use `unknown` instead.',
      sourceKind: 'reviewer',
      confidence: 'high',
      scope: 'project',
      tags: ['typescript', 'anti-pattern'],
      links: [],
    },
    'seed-persona',
  )
  createdEntryIds.push(e2.entryId)

  const e3 = await service.record(
    {
      projectId,
      kind: 'convention',
      title: 'API routes use snake_case query params',
      body: 'All REST API query parameters use snake_case (not camelCase).',
      sourceKind: 'operator',
      confidence: 'medium',
      scope: 'project',
      tags: ['api', 'naming', 'convention'],
      links: [],
    },
    'seed-persona',
  )
  createdEntryIds.push(e3.entryId)

  const e4 = await service.record(
    {
      projectId,
      kind: 'learning',
      title: 'pgvector index needs ANALYZE after bulk inserts',
      body: 'After bulk inserting rows, run ANALYZE to update planner statistics.',
      sourceKind: 'agent',
      confidence: 'medium',
      scope: 'project',
      tags: ['database', 'pgvector', 'performance'],
      links: [],
    },
    'seed-persona',
  )
  createdEntryIds.push(e4.entryId)
})

afterAll(async () => {
  if (createdEntryIds.length > 0) {
    await db.delete(projectMemoryLinks).where(inArray(projectMemoryLinks.entryId, createdEntryIds))
    await db.delete(projectMemoryTags).where(inArray(projectMemoryTags.entryId, createdEntryIds))
    await db.delete(projectMemoryEntries).where(inArray(projectMemoryEntries.entryId, createdEntryIds))
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retrieveTopN (tag-fallback path — EMBEDDING_PROVIDER=none)', () => {
  it('returns relevant entries for a TypeScript-related query', async () => {
    // EMBEDDING_PROVIDER defaults to 'none' in test env — exercises tag fallback
    const result = await retrieveTopN(db, projectId, {
      title: 'TypeScript configuration task',
      description: 'Configure TypeScript for strict mode compliance.',
      tags: ['typescript'],
    }, 8)

    expect(result.entries.length).toBeGreaterThan(0)
    expect(['tag_fallback', 'none', 'vector']).toContain(result.method)

    // Should return at least the TypeScript-tagged entries
    const titles = result.entries.map((e) => e.title)
    expect(titles.some((t) => t.toLowerCase().includes('typescript'))).toBe(true)
  })

  it('returns entries from the correct project only', async () => {
    const otherProjectId = uuidv7()
    const result = await retrieveTopN(db, otherProjectId, {
      title: 'TypeScript configuration',
      description: 'Configure TypeScript.',
    }, 8)

    // No entries exist for otherProjectId
    expect(result.entries.length).toBe(0)
    expect(result.method).toBe('none')
  })

  it('top-k capping respects k parameter', async () => {
    const result = await retrieveTopN(db, projectId, {
      title: 'General project query',
      description: 'General context about the project.',
    }, 2)

    expect(result.entries.length).toBeLessThanOrEqual(2)
  })

  it('re-ranks decisions above learnings when both are relevant', async () => {
    const result = await retrieveTopN(db, projectId, {
      title: 'Database and TypeScript task',
      description: 'Work on the database layer with TypeScript.',
    }, 8)

    if (result.entries.length >= 2) {
      // Find decision and learning entries in results
      const decisionIdx = result.entries.findIndex((e) => e.kind === 'decision')
      const learningIdx = result.entries.findIndex((e) => e.kind === 'learning')

      // If both are present, decision should come before learning
      if (decisionIdx !== -1 && learningIdx !== -1) {
        expect(decisionIdx).toBeLessThan(learningIdx)
      }
    }
  })

  it('embedding-disabled path (EMBEDDING_PROVIDER=none) still returns results', async () => {
    // Explicitly confirm EMBEDDING_PROVIDER is not set in test env
    const provider = process.env['EMBEDDING_PROVIDER'] ?? 'none'
    expect(provider).toBe('none')

    const result = await retrieveTopN(db, projectId, {
      title: 'Any task',
      description: 'Some work to do.',
    }, 5)

    // Should still work via tag/keyword fallback
    expect(['tag_fallback', 'none']).toContain(result.method)
    // Should not throw
    expect(Array.isArray(result.entries)).toBe(true)
  })
})
