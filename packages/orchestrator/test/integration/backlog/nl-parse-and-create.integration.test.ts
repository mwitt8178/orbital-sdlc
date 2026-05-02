/**
 * Integration test: backlog.parseAndCreate end-to-end.
 *
 * Real Postgres. Real BacklogService + EventStore. We exercise the tRPC
 * router factory directly (no HTTP roundtrip) and assert that:
 *
 *   1. parseAndCreate returns a Proposal grounded in the supplied vision
 *      context (existing epic titles + goal text influence the suggestion).
 *   2. The proposal can be passed verbatim into stories.create / epics.create
 *      and persists without further validation work.
 *   3. The flow emits StoryCreated / EpicCreated through the existing event
 *      path (no new event types).
 *   4. Bug-language pre-allocates a defect_id that survives the round trip.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultBacklogService } from '../../../src/backlog/service.js'
import { createBacklogRouter } from '../../../src/trpc/routers/backlog.js'
import { setNLParser } from '../../../src/backlog/nl-parser.js'
import {
  epics,
  stories,
  storyAcceptanceCriteria,
} from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'

const ownedEpicIds: string[] = []
const ownedStoryIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
})

afterAll(async () => {
  setNLParser(null)
  if (ownedStoryIds.length > 0) {
    await db
      .delete(storyAcceptanceCriteria)
      .where(inArray(storyAcceptanceCriteria.storyId, ownedStoryIds))
    await db.delete(stories).where(inArray(stories.storyId, ownedStoryIds))
  }
  if (ownedEpicIds.length > 0) {
    await db.delete(epics).where(inArray(epics.epicId, ownedEpicIds))
  }
  await closeDb().catch(() => undefined)
})

describe('backlog.parseAndCreate (integration)', () => {
  it('returns a Proposal grounded in the supplied vision context', async () => {
    const es = createEventStore(db, sql)
    const backlogService = new DefaultBacklogService(db, es)

    // Pre-create an epic so the parser has a candidate to suggest.
    const seedEpic = await backlogService.createEpic({
      vision_version_id: uuidv7(),
      title: 'Authentication',
      rationale: 'auth surface for the product',
      priority: 1,
    })
    ownedEpicIds.push(seedEpic.epicId)

    const router = createBacklogRouter({
      backlogService,
      // Static loader returns vision context with two top goals.
      loadVisionContext: async () => ({
        title: 'Self-serve identity',
        summary: 'Users sign in, recover passwords, and manage their profile.',
        topGoals: ['Frictionless signup', 'Recover lost passwords', 'SSO'],
        existingEpicTitles: [],
      }),
    })

    const caller = router.createCaller({})

    const proposal = await caller.parseAndCreate({
      prompt: 'I want password reset for authentication users',
      kind: 'auto',
      vision_document_id: uuidv7(),
    })

    expect(proposal.kind).toBe('story')
    expect(proposal.title).toMatch(/password reset/i)
    expect(proposal.ac_titles.length).toBeGreaterThanOrEqual(2)
    expect(proposal.ac_titles[0]).toMatch(/password reset link/i)
    // Existing-epic suggestion comes from the listEpics fallback inside the
    // procedure; "authentication" in the prompt overlaps with seed epic
    // "Authentication" (token-overlap heuristic).
    expect(proposal.suggested_epic_title).toBe('Authentication')
    expect(proposal.parser_engine).toBe('templated')
  })

  it('proposal can be passed straight into stories.create + emits StoryCreated', async () => {
    const es = createEventStore(db, sql)
    const backlogService = new DefaultBacklogService(db, es)
    const router = createBacklogRouter({
      backlogService,
      loadVisionContext: async () => null,
    })
    const caller = router.createCaller({})

    const epic = await backlogService.createEpic({
      vision_version_id: uuidv7(),
      title: 'Account management',
      rationale: 'r',
      priority: 1,
    })
    ownedEpicIds.push(epic.epicId)

    const proposal = await caller.parseAndCreate({
      prompt: 'I want password reset via email',
      kind: 'auto',
    })
    expect(proposal.kind).toBe('story')

    const created = await caller.stories.create({
      epic_id: epic.epicId,
      title: proposal.title,
      description: proposal.description,
      acceptance_criteria: proposal.ac_titles.map((t) => ({ text: t })),
      ...(proposal.persona_of_record ? { persona_of_record: proposal.persona_of_record } : {}),
    })
    ownedStoryIds.push(created.storyId)

    expect(created.title).toBe(proposal.title)
    expect(created.acceptanceCriteria.length).toBe(proposal.ac_titles.length)

    // Assert StoryCreated emitted.
    const eventRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, created.storyId))
    const types = eventRows.map((e) => e.eventType)
    expect(types).toContain('StoryCreated')
  })

  it('classifies bug language and persists the defect_id from the proposal', async () => {
    const es = createEventStore(db, sql)
    const backlogService = new DefaultBacklogService(db, es)
    const router = createBacklogRouter({ backlogService })
    const caller = router.createCaller({})

    const epic = await backlogService.createEpic({
      vision_version_id: uuidv7(),
      title: 'Quality',
      rationale: 'r',
      priority: 1,
    })
    ownedEpicIds.push(epic.epicId)

    const proposal = await caller.parseAndCreate({
      prompt: 'Login is broken on Safari 17',
      kind: 'auto',
    })
    expect(proposal.kind).toBe('bug')
    expect(proposal.bug?.defect_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(proposal.persona_of_record).toBe('qa')

    const created = await caller.stories.create({
      epic_id: epic.epicId,
      title: proposal.title,
      description: proposal.description,
      acceptance_criteria: proposal.ac_titles.map((t) => ({ text: t })),
      ...(proposal.persona_of_record ? { persona_of_record: proposal.persona_of_record } : {}),
      ...(proposal.bug ? { defect_id: proposal.bug.defect_id } : {}),
    })
    ownedStoryIds.push(created.storyId)

    expect(created.defectId).toBe(proposal.bug?.defect_id)
    expect(created.personaOfRecord).toBe('qa')
  })

  it('classifies epic language and round-trips through epics.create', async () => {
    const es = createEventStore(db, sql)
    const backlogService = new DefaultBacklogService(db, es)
    const router = createBacklogRouter({ backlogService })
    const caller = router.createCaller({})

    const proposal = await caller.parseAndCreate({
      prompt: 'Epic: notifications overhaul across web and mobile',
      kind: 'auto',
    })
    expect(proposal.kind).toBe('epic')
    expect(proposal.persona_of_record).toBe('pm')

    const epic = await caller.epics.create({
      vision_version_id: uuidv7(),
      title: proposal.title,
      rationale: proposal.description,
      priority: proposal.priority,
    })
    ownedEpicIds.push(epic.epicId)
    expect(epic.title).toBe(proposal.title)

    // Verify EpicCreated emitted via the existing path.
    const evs = await db.select().from(events).where(eq(events.aggregateId, epic.epicId))
    const types = evs.map((e) => e.eventType)
    expect(types).toContain('EpicCreated')
  })

  it('honours forceKind to override automatic classification', async () => {
    const es = createEventStore(db, sql)
    const backlogService = new DefaultBacklogService(db, es)
    const router = createBacklogRouter({ backlogService })
    const caller = router.createCaller({})

    // Story-language prompt forced to bug
    const proposal = await caller.parseAndCreate({
      prompt: 'I want a profile picture upload',
      kind: 'bug',
    })
    expect(proposal.kind).toBe('bug')
    expect(proposal.bug?.defect_id).toBeTruthy()
  })

  it('rejects an empty prompt', async () => {
    const es = createEventStore(db, sql)
    const backlogService = new DefaultBacklogService(db, es)
    const router = createBacklogRouter({ backlogService })
    const caller = router.createCaller({})

    await expect(
      caller.parseAndCreate({ prompt: '', kind: 'auto' }),
    ).rejects.toThrow()
  })
})
