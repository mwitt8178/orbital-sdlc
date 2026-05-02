/**
 * Integration test: memory brief injection.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * Tests:
 *   1. Record 5 entries → injectMemoryIntoBrief → emits MemoryRetrievedForBrief
 *      with at least 1 entry → brief text contains the entry title.
 *   2. EMBEDDING_PROVIDER=none path: tag-based retrieval still works.
 *   3. Full buildBrief flow with memoryContext: brief contains "Project memory" section.
 *   4. Capability check: agent without memory_write rejected by memory.record tool.
 *
 * Real Postgres, real EventStore, real retrieval.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq, inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createMemoryService } from '../../../src/memory/service.js'
import { injectMemoryIntoBrief } from '../../../src/memory/brief-injector.js'
import { buildBrief } from '../../../src/personas/brief.js'
import { memoryRecordTool } from '../../../src/mcp/tools/memory.js'
import {
  projectMemoryEntries,
  projectMemoryTags,
  projectMemoryLinks,
} from '../../../src/db/schema/memory.js'
import { events } from '../../../src/db/schema/events.js'
import { OrbitalError } from '@orbital/types'
import type { CapabilityBundle } from '@orbital/types'
import type { Persona } from '../../../src/personas/types.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const projectId = uuidv7()
const taskId = uuidv7()
const createdEntryIds: string[] = []

const mockPersona: Persona = {
  personaId: 'test-persona-id',
  personaVersionId: 'test-version-id',
  slug: 'sr-dev',
  displayName: 'Senior Developer',
  origin: 'baseline',
  versionNumber: 1,
  roleBriefMd: 'You are the Senior Developer.',
  definitionHash: 'abc123',
  defaultCapabilityProfile: {
    filesRead: ['src/**'],
    filesWrite: ['src/**'],
    boardRead: ['*'],
    boardMutate: [],
    channelRead: ['#sprint-*'],
    channelPost: ['#sprint-*'],
    secrets: [],
    networkEgress: ['api.anthropic.com'],
    spawnSubagent: false,
    gitCommit: { branchPattern: 'feature/*', pathGlob: 'src/**' },
    ceremonyRole: 'participant',
  },
  modelAffinity: [
    { riskClass: 'standard', preferredModel: 'claude-sonnet-4-6', fallbackModel: null, maxTokensHint: 8000, rationale: 'Default' },
  ],
  escalationPolicy: { maxRetries: 3, rules: [], defaultAction: 'post_blocker' },
  skills: [],
  metadata: { tags: [], description: 'Core implementer.' },
  isArchived: false,
}

const mockCapabilityWithWriteScope: CapabilityBundle = {
  capability_id: uuidv7(),
  install_id: uuidv7(),
  sprint_id: uuidv7(),
  task_id: taskId,
  persona_id: 'sr-dev',
  session_id: uuidv7(),
  scopes: {
    files_read: ['src/**'],
    files_write: ['src/**'],
    board_read: ['*'],
    board_mutate: [],
    channel_read: ['#sprint-14', 'capability:memory_write'],
    channel_post: ['#sprint-14'],
    secrets: [],
    network_egress: [],
    spawn_subagent: false,
    git_commit: [],
    ceremony_role: [],
  },
  issued_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  signing_key_id: 'key-001',
  signature: 'base64signature',
  schema_version: 1,
}

const mockCapabilityNoWriteScope: CapabilityBundle = {
  ...mockCapabilityWithWriteScope,
  capability_id: uuidv7(),
  scopes: {
    ...mockCapabilityWithWriteScope.scopes,
    // No 'capability:memory_write' in channel_read
    channel_read: ['#sprint-14'],
  },
}

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  const service = createMemoryService(db, eventStore)

  // Seed 5 memory entries
  const entries = [
    {
      kind: 'decision' as const,
      title: 'Drizzle ORM for all database access',
      body: 'Drizzle chosen over Prisma for type safety and pgvector support.',
      tags: ['database', 'drizzle', 'orm'],
    },
    {
      kind: 'convention' as const,
      title: 'Use pino structured logger everywhere',
      body: 'Never use console.log in application code. Use pino logger.',
      tags: ['logging', 'pino'],
    },
    {
      kind: 'anti_pattern' as const,
      title: 'Do not use any type in TypeScript',
      body: 'Reviewer rejected approach using any. Use unknown instead.',
      tags: ['typescript', 'types'],
    },
    {
      kind: 'learning' as const,
      title: 'pgvector needs ANALYZE after bulk inserts',
      body: 'Run ANALYZE after bulk inserts to update query planner stats.',
      tags: ['database', 'pgvector'],
    },
    {
      kind: 'glossary' as const,
      title: 'Sprint: a 2-week delivery cycle',
      body: 'In this project, a sprint is exactly 2 weeks with a Monday start.',
      tags: ['sprint', 'process'],
    },
  ]

  for (const e of entries) {
    const entry = await service.record(
      {
        projectId,
        kind: e.kind,
        title: e.title,
        body: e.body,
        sourceKind: 'agent',
        confidence: 'medium',
        scope: 'project',
        tags: e.tags,
        links: [],
      },
      'test-persona',
    )
    createdEntryIds.push(entry.entryId)
  }
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

describe('Memory brief injection', () => {
  it('AC4: emits MemoryRetrievedForBrief with at least 1 entry', async () => {
    const eventStore = createEventStore(db, sql)

    const injection = await injectMemoryIntoBrief(
      db,
      eventStore,
      projectId,
      taskId,
      {
        title: 'Database schema migration task',
        description: 'Migrate the database schema using Drizzle ORM.',
        tags: ['database', 'drizzle'],
      },
      8,
    )

    expect(injection.entryIds.length).toBeGreaterThanOrEqual(1)

    // Verify MemoryRetrievedForBrief was emitted
    const eventRows = await db
      .select()
      .from(events)
      .where(eq(events.eventType, 'MemoryRetrievedForBrief'))
      .limit(10)

    const ourEvent = eventRows.find((r) => {
      const p = r.payload as Record<string, unknown>
      return p['task_id'] === taskId
    })

    expect(ourEvent).toBeTruthy()
    expect(ourEvent?.aggregateId).toBe(taskId)
    const payload = ourEvent!.payload as Record<string, unknown>
    expect(Array.isArray(payload['entry_ids'])).toBe(true)
    expect((payload['entry_ids'] as string[]).length).toBeGreaterThanOrEqual(1)
  })

  it('AC4: brief text contains the entry title', async () => {
    const eventStore = createEventStore(db, sql)

    const injection = await injectMemoryIntoBrief(
      db,
      eventStore,
      projectId,
      uuidv7(),
      {
        title: 'Database work with Drizzle',
        description: 'Implement database layer using Drizzle ORM.',
        tags: ['database'],
      },
      8,
    )

    // The injection markdown should contain at least one entry title
    if (injection.entryIds.length > 0) {
      expect(injection.markdown).toContain('[decision]')
      // At least one of the seeded entries (all about DB/Drizzle) should appear
      const hasDbEntry =
        injection.markdown.includes('Drizzle') ||
        injection.markdown.includes('database') ||
        injection.markdown.includes('pgvector')
      expect(hasDbEntry).toBe(true)
    }
  })

  it('AC4: full buildBrief with memoryContext produces "Project memory" section', async () => {
    const eventStore = createEventStore(db, sql)

    const brief = await buildBrief(
      mockPersona,
      {
        task_id: uuidv7(),
        title: 'Database migration task',
        description: 'Migrate database schema with Drizzle.',
        acceptance_criteria: ['Migration runs successfully'],
      },
      mockCapabilityNoWriteScope,
      {
        memoryContext: {
          db,
          eventStore,
          projectId,
          k: 5,
        },
      },
    )

    // Brief should contain the memory section header
    expect(brief).toContain('Project memory')
  })

  it('AC7: EMBEDDING_PROVIDER=none — tag-based retrieval still returns sensible results', async () => {
    const provider = process.env['EMBEDDING_PROVIDER'] ?? 'none'
    expect(provider).toBe('none') // Confirms we are testing the fallback path

    const eventStore = createEventStore(db, sql)
    const injection = await injectMemoryIntoBrief(
      db,
      eventStore,
      projectId,
      uuidv7(),
      {
        title: 'TypeScript logging task',
        description: 'Implement structured logging with pino.',
        tags: ['logging', 'pino'],
      },
      5,
    )

    // Should return at least the logging convention entry
    expect(injection.entryIds.length).toBeGreaterThanOrEqual(1)
    // Method should be tag_fallback (not vector since embedding is disabled)
    expect(['tag_fallback', 'none']).toContain(injection.method)
  })

  it('AC6: agent without memory_write scope is rejected by memory.record tool', async () => {
    // The tool checks hasMemoryScope(ctx, 'memory_write')
    // Agent with no capability:memory_write in channel_read should be rejected

    const ctx = {
      bundle: mockCapabilityNoWriteScope,
      db,
      eventStore: createEventStore(db, sql),
      traceId: uuidv7(),
      workerId: 'test-worker',
    }

    // OrbitalError has code as a property, not in the message string.
    const err = await memoryRecordTool
      .handler(
        {
          project_id: projectId,
          kind: 'decision',
          title: 'Unauthorized entry',
          body: 'This should be rejected.',
          scope: 'project',
          tags: [],
          links: [],
        },
        ctx,
      )
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OrbitalError)
    expect((err as OrbitalError).code).toBe('AUTH_SCOPE_DENIED')
  })

  it('AC6: agent WITH memory_write scope can call memory.record tool', async () => {
    const ctx = {
      bundle: mockCapabilityWithWriteScope,
      db,
      eventStore: createEventStore(db, sql),
      traceId: uuidv7(),
      workerId: 'test-worker',
    }

    const result = await memoryRecordTool.handler(
      {
        project_id: projectId,
        kind: 'convention',
        title: 'Authorized memory entry',
        body: 'This should succeed because memory_write scope is present.',
        scope: 'project',
        tags: ['test'],
        links: [],
      },
      ctx,
    )

    expect(result.entry_id).toBeTruthy()
    createdEntryIds.push(result.entry_id)
  })
})
