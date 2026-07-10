/**
 * Tests for memory prompt assembly — verifies memory is actually injected
 * into the brief sent to Claude.
 *
 * [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
 *
 * Tests:
 *   1. buildBrief with memoryContext includes "## Project memory" section
 *   2. buildBrief without memoryContext has no memory section (backwards compat)
 *   3. Pinned entries always appear in the brief
 *   4. Persona-scoped entries are filtered correctly
 *   5. Tenant isolation: memory from tenant A is not returned for tenant B
 *   6. Ranking determinism: same seed data → same top-k order
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { inArray, eq, and } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createMemoryService } from '../../../src/memory/service.js'
import { buildBrief } from '../../../src/personas/brief.js'
import {
  projectMemoryEntries,
  projectMemoryTags,
  projectMemoryLinks,
} from '../../../src/db/schema/memory.js'
import type { Persona } from '../../../src/personas/types.js'
import type { CapabilityBundle } from '@orbital/types'

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const MOCK_PERSONA: Persona = {
  slug: 'sr-dev',
  displayName: 'Senior Developer',
  roleBriefMd: 'You are a senior developer. Write clean code.',
  defaultCapabilityProfile: {
    filesRead: ['**/*.ts'],
    filesWrite: ['src/**/*.ts'],
    boardRead: [],
    boardMutate: [],
    channelRead: [],
    channelPost: [],
    secrets: [],
    networkEgress: [],
    spawnSubagent: false,
    gitCommit: null,
    ceremonyRole: 'none',
  },
}

const MOCK_TASK = {
  task_id: uuidv7(),
  title: 'Add TypeScript strict null checks',
  description: 'Enable strict null checks in tsconfig and fix all resulting type errors.',
  acceptance_criteria: ['All files compile without TS errors', 'No ts-ignore suppressions added'],
  risk_class: 'standard' as const,
}

const MOCK_CAPABILITY: CapabilityBundle = {
  capability_id: uuidv7(),
  session_id: uuidv7(),
  install_id: uuidv7(),
  persona_id: 'sr-dev',
  task_id: MOCK_TASK.task_id,
  sprint_id: uuidv7(),
  scopes: {
    files_read: ['**/*.ts'],
    files_write: ['src/**/*.ts'],
    board_read: [],
    board_mutate: [],
    channel_read: [],
    channel_post: [],
    secrets: [],
    network_egress: [],
    spawn_subagent: false,
    git_commit: [],
    ceremony_role: [],
  },
  issued_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const TENANT_A = uuidv7()
const TENANT_B = uuidv7()
const PROJECT_ID = uuidv7()

const createdEntryIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  const service = createMemoryService(db, eventStore)

  // Seed entries for tenant A
  const e1 = await service.record(
    {
      projectId: PROJECT_ID,
      kind: 'decision',
      title: 'Use strict mode',
      body: 'Enable TypeScript strict mode for all new files to catch null pointer errors at compile time.',
      sourceKind: 'agent',
      confidence: 'high',
      scope: 'project',
      tags: ['typescript', 'strict-mode'],
      links: [],
    },
    'system',
    TENANT_A,
  )
  createdEntryIds.push(e1.entryId)

  const e2 = await service.record(
    {
      projectId: PROJECT_ID,
      kind: 'convention',
      title: 'Always use explicit return types',
      body: 'All exported functions must have explicit return type annotations.',
      sourceKind: 'operator',
      confidence: 'high',
      scope: 'project',
      tags: ['typescript', 'conventions'],
      links: [],
    },
    'system',
    TENANT_A,
  )
  createdEntryIds.push(e2.entryId)

  // Seed a pinned entry for tenant A
  const e3 = await service.record(
    {
      projectId: PROJECT_ID,
      kind: 'anti_pattern',
      title: 'Never use any type',
      body: 'Using the any type defeats the purpose of TypeScript. Always use unknown or a specific type.',
      sourceKind: 'operator',
      confidence: 'high',
      scope: 'project',
      tags: ['typescript', 'anti-pattern'],
      links: [],
    },
    'system',
    TENANT_A,
  )
  createdEntryIds.push(e3.entryId)
  // Pin this entry
  await service.update({ entryId: e3.entryId, pinned: true }, 'system', TENANT_A)

  // Seed a persona-scoped entry
  const e4 = await service.record(
    {
      projectId: PROJECT_ID,
      kind: 'learning',
      title: 'pm-only memory entry',
      body: 'This entry should only be visible to the pm persona.',
      sourceKind: 'operator',
      confidence: 'medium',
      scope: 'project',
      tags: ['pm-specific'],
      links: [],
    },
    'system',
    TENANT_A,
  )
  createdEntryIds.push(e4.entryId)
  // Scope to 'pm' persona
  await service.update({ entryId: e4.entryId, personaScope: 'pm' }, 'system', TENANT_A)

  // Seed entries for tenant B (should never appear in tenant A queries)
  const e5 = await service.record(
    {
      projectId: PROJECT_ID,
      kind: 'decision',
      title: 'Tenant B decision',
      body: 'This memory belongs to tenant B and should NEVER appear in tenant A prompt.',
      sourceKind: 'operator',
      confidence: 'high',
      scope: 'project',
      tags: ['typescript'],
      links: [],
    },
    'system',
    TENANT_B,
  )
  createdEntryIds.push(e5.entryId)
})

afterAll(async () => {
  if (createdEntryIds.length > 0) {
    await db.delete(projectMemoryLinks).where(
      inArray(projectMemoryLinks.entryId, createdEntryIds),
    )
    await db.delete(projectMemoryTags).where(
      inArray(projectMemoryTags.entryId, createdEntryIds),
    )
    await db.delete(projectMemoryEntries).where(
      inArray(projectMemoryEntries.entryId, createdEntryIds),
    )
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('memory prompt assembly', () => {
  it('includes ## Project memory section when memoryContext is provided', async () => {
    const eventStore = createEventStore(db, sql)

    const brief = await buildBrief(MOCK_PERSONA, MOCK_TASK, MOCK_CAPABILITY, {
      memoryContext: {
        db,
        eventStore,
        projectId: PROJECT_ID,
        tenantId: TENANT_A,
        personaSlug: 'sr-dev',
      },
    })

    expect(brief).toContain('## Project memory')
    expect(brief).toContain('Use strict mode')
  })

  it('does NOT include memory section when memoryContext is absent', async () => {
    const brief = await buildBrief(MOCK_PERSONA, MOCK_TASK, MOCK_CAPABILITY)

    expect(brief).not.toContain('## Project memory')
  })

  it('always includes pinned entries regardless of query relevance', async () => {
    const eventStore = createEventStore(db, sql)

    const brief = await buildBrief(MOCK_PERSONA, MOCK_TASK, MOCK_CAPABILITY, {
      memoryContext: {
        db,
        eventStore,
        projectId: PROJECT_ID,
        tenantId: TENANT_A,
        personaSlug: 'sr-dev',
        k: 1, // Only 1 ranked slot, but pinned should always appear
      },
    })

    // Pinned entry must appear
    expect(brief).toContain('Never use any type')
    expect(brief).toContain('[pinned]')
  })

  it('excludes persona-scoped entries not matching the current persona', async () => {
    const eventStore = createEventStore(db, sql)

    const brief = await buildBrief(MOCK_PERSONA, MOCK_TASK, MOCK_CAPABILITY, {
      memoryContext: {
        db,
        eventStore,
        projectId: PROJECT_ID,
        tenantId: TENANT_A,
        personaSlug: 'sr-dev', // pm-only entry should NOT appear
      },
    })

    // pm-specific entry must NOT appear for sr-dev persona
    expect(brief).not.toContain('pm-only memory entry')
  })

  it('includes persona-scoped entries when persona matches', async () => {
    const eventStore = createEventStore(db, sql)

    const brief = await buildBrief(
      { ...MOCK_PERSONA, slug: 'pm', displayName: 'Product Manager' },
      MOCK_TASK,
      MOCK_CAPABILITY,
      {
        memoryContext: {
          db,
          eventStore,
          projectId: PROJECT_ID,
          tenantId: TENANT_A,
          personaSlug: 'pm', // pm entry SHOULD appear
        },
      },
    )

    expect(brief).toContain('pm-only memory entry')
  })

  it('enforces tenant isolation — tenant B memory never appears in tenant A brief', async () => {
    const eventStore = createEventStore(db, sql)

    const brief = await buildBrief(MOCK_PERSONA, MOCK_TASK, MOCK_CAPABILITY, {
      memoryContext: {
        db,
        eventStore,
        projectId: PROJECT_ID,
        tenantId: TENANT_A,
      },
    })

    // Tenant B entry must NEVER appear
    expect(brief).not.toContain('Tenant B decision')
    expect(brief).not.toContain('This memory belongs to tenant B')
  })

  it('enforces tenant isolation — tenant A memory never appears in tenant B brief', async () => {
    const eventStore = createEventStore(db, sql)

    const brief = await buildBrief(MOCK_PERSONA, MOCK_TASK, MOCK_CAPABILITY, {
      memoryContext: {
        db,
        eventStore,
        projectId: PROJECT_ID,
        tenantId: TENANT_B,
      },
    })

    // Tenant A entries must NEVER appear in tenant B brief
    expect(brief).not.toContain('Use strict mode')
    expect(brief).not.toContain('Never use any type')
  })

  it('produces deterministic ranking for the same seed data', async () => {
    const eventStore = createEventStore(db, sql)
    const params = {
      memoryContext: {
        db,
        eventStore,
        projectId: PROJECT_ID,
        tenantId: TENANT_A,
        personaSlug: 'sr-dev',
        k: 3,
      },
    }

    const brief1 = await buildBrief(MOCK_PERSONA, MOCK_TASK, MOCK_CAPABILITY, params)
    const brief2 = await buildBrief(MOCK_PERSONA, MOCK_TASK, MOCK_CAPABILITY, params)

    // Section content should be identical across calls
    const extractMemorySection = (brief: string) => {
      const start = brief.indexOf('## Project memory')
      if (start === -1) return ''
      const end = brief.indexOf('\n---\n', start)
      return end === -1 ? brief.slice(start) : brief.slice(start, end)
    }

    expect(extractMemorySection(brief1)).toBe(extractMemorySection(brief2))
  })
})
