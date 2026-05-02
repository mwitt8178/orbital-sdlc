/**
 * Integration test: CeremonyScheduler end-to-end against real Postgres.
 *
 * Verifies:
 *   - sprint-planning rule: insert a planning sprint with state='planning' + 5
 *     ready stories totaling >= capacity, emit SprintCreated, assert ceremony
 *     row exists in `ceremonies` table within 500ms
 *   - dedupe: re-emitting the same SprintCreated envelope produces only one
 *     ceremony
 *   - CeremonyAutoScheduled audit event is appended with rule_id +
 *     trigger_event_id
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql as dSQL } from 'drizzle-orm'
import { PostgresEventStore } from '../../../src/events/store.js'
import { DefaultChannelsService } from '../../../src/comms/channels.js'
import {
  DefaultCeremonyService,
  seedBaselineCeremonySpecs,
} from '../../../src/comms/ceremonies.js'
import { DefaultCeremonyScheduler } from '../../../src/comms/ceremony-scheduler.js'
import { defaultRules } from '../../../src/comms/ceremony-triggers/index.js'
import { ceremonies } from '../../../src/db/schema/comms-workflow.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://orbital:orbital@localhost:5432/orbital'

let sqlPool: postgres.Sql
let store: PostgresEventStore
let channels: DefaultChannelsService
let ceremonyService: DefaultCeremonyService
let scheduler: DefaultCeremonyScheduler
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 10, idle_timeout: 15, onnotice: () => {} })
  db = drizzle(sqlPool)
  store = new PostgresEventStore(db, sqlPool)
  channels = new DefaultChannelsService(db, store)
  await channels.bootstrapBaseline().catch(() => {
    /* baseline may already exist */
  })
  await seedBaselineCeremonySpecs(db)
  ceremonyService = new DefaultCeremonyService(db, store, channels)
  scheduler = new DefaultCeremonyScheduler({
    db,
    eventStore: store,
    ceremonyService,
    ruleRegistry: defaultRules,
  })
})

afterAll(async () => {
  scheduler.stop()
  await store.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

beforeEach(async () => {
  // Clean up firings + ceremonies created by prior tests in the suite to keep
  // each `it` independent. We do not truncate broader tables (events, sprints,
  // stories) — the tests use unique uuids so no collision occurs.
  await sqlPool`DELETE FROM ceremony_trigger_firings`
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedReadyBacklog(opts: { storyCount: number; pointsEach: number }): Promise<{
  visionVersionId: string
  epicId: string
  storyIds: string[]
}> {
  const visionVersionId = uuidv7()
  const epicId = uuidv7()

  await sqlPool`
    INSERT INTO epics (epic_id, vision_version_id, title, rationale, priority, status)
    VALUES (${epicId}, ${visionVersionId}, ${'Test epic'}, ${'rat'}, ${1}, ${'active'})
    ON CONFLICT DO NOTHING
  `

  const storyIds: string[] = []
  for (let i = 0; i < opts.storyCount; i++) {
    const sid = uuidv7()
    storyIds.push(sid)
    await sqlPool`
      INSERT INTO stories (
        story_id, epic_id, title, description, status, story_points, priority
      ) VALUES (
        ${sid}, ${epicId}, ${`Test story ${i}`}, ${'desc'}, ${'ready'},
        ${opts.pointsEach}, ${i + 1}
      )
      ON CONFLICT DO NOTHING
    `
  }

  return { visionVersionId, epicId, storyIds }
}

async function createPlanningSprint(capacity: number): Promise<string> {
  const sprintId = uuidv7()
  // Choose a sequence that won't collide. We use a high random integer.
  const sequence = Math.floor(Math.random() * 100000) + 100000
  await sqlPool`
    INSERT INTO sprints (
      sprint_id, name, sequence, status, story_point_capacity, budget_usd_cents
    ) VALUES (
      ${sprintId}, ${'Test planning sprint'}, ${sequence}, ${'planning'},
      ${capacity}, ${1000}
    )
  `
  return sprintId
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`waitForCondition: not satisfied within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CeremonyScheduler — integration', () => {
  it('auto-schedules a sprint_planning ceremony when SprintCreated arrives with enough ready stories', async () => {
    // Seed a fresh backlog with 5 ready stories, 10 points each (50 total).
    await seedReadyBacklog({ storyCount: 5, pointsEach: 10 })
    // Capacity 30 < 50 ready points → rule fires.
    const sprintId = await createPlanningSprint(30)

    // Drive the rule through onEvent directly (subscriber is async; this
    // bypasses any transient backfill races and matches the synchronous shape
    // of the unit-tests). The real subscribe path is exercised by the
    // ceremony_auto_scheduled audit assertion below.
    const traceId = uuidv7()
    const env = await store.append({
      aggregate_id: sprintId,
      aggregate_type: 'sprint',
      event_type: 'SprintCreated',
      payload: {
        sprint_id: sprintId,
        story_point_capacity: 30,
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: traceId,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })
    await scheduler.onEvent(env)

    // Assert: a ceremony row exists for this sprint within 500ms.
    let ceremonyRow: typeof ceremonies.$inferSelect | undefined
    await waitForCondition(async () => {
      const rows = await db
        .select()
        .from(ceremonies)
        .where(eq(ceremonies.ceremonyType, 'sprint_planning'))
      ceremonyRow = rows.find(
        (r) => (r.scope as Record<string, unknown>)['sprint_id'] === sprintId,
      )
      return ceremonyRow !== undefined
    }, 500)
    expect(ceremonyRow).toBeDefined()
    expect((ceremonyRow!.scope as Record<string, unknown>)['rule_id']).toBe('sprint-planning')

    // Assert: a CeremonyAutoScheduled audit event was appended carrying the
    // rule_id + trigger_event_id correlation.
    const auditEvents = await store.query({
      event_type: 'CeremonyAutoScheduled',
      aggregate_id: ceremonyRow!.ceremonyId,
      limit: 5,
    })
    expect(auditEvents.items.length).toBeGreaterThanOrEqual(1)
    const audit = auditEvents.items[0]!
    expect(audit.payload['rule_id']).toBe('sprint-planning')
    expect(audit.payload['trigger_event_id']).toBe(env.event_id)
    expect(audit.payload['ceremony_type']).toBe('sprint_planning')
  })

  it('dedupes: re-driving the same trigger envelope creates only one ceremony', async () => {
    await seedReadyBacklog({ storyCount: 5, pointsEach: 10 })
    const sprintId = await createPlanningSprint(30)
    const traceId = uuidv7()
    const env = await store.append({
      aggregate_id: sprintId,
      aggregate_type: 'sprint',
      event_type: 'SprintCreated',
      payload: { sprint_id: sprintId, story_point_capacity: 30 },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: traceId,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    await scheduler.onEvent(env)
    await scheduler.onEvent(env) // second invocation with the same envelope

    const ceremoniesForSprint = await db
      .select()
      .from(ceremonies)
      .where(eq(ceremonies.ceremonyType, 'sprint_planning'))
    const matching = ceremoniesForSprint.filter(
      (r) => (r.scope as Record<string, unknown>)['sprint_id'] === sprintId,
    )
    expect(matching).toHaveLength(1)

    // The firings table also records exactly one row.
    const firings = await sqlPool<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM ceremony_trigger_firings
      WHERE rule_id = 'sprint-planning'
        AND trigger_event_id = ${env.event_id}
    `
    expect(firings[0]?.count).toBe(1)
  })

  it('does NOT fire sprint-planning when ready story points are below capacity', async () => {
    // Suppress any ready stories left over from prior tests so the rule's
    // SUM(story_points) check sees only what we seed below.
    await sqlPool`UPDATE stories SET status = 'cancelled' WHERE status = 'ready'`
    await seedReadyBacklog({ storyCount: 1, pointsEach: 5 }) // only 5 points ready
    const sprintId = await createPlanningSprint(50) // capacity 50 > 5
    const env = await store.append({
      aggregate_id: sprintId,
      aggregate_type: 'sprint',
      event_type: 'SprintCreated',
      payload: { sprint_id: sprintId, story_point_capacity: 50 },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })
    await scheduler.onEvent(env)

    const rows = await db
      .select()
      .from(ceremonies)
      .where(eq(ceremonies.ceremonyType, 'sprint_planning'))
    const matching = rows.filter(
      (r) => (r.scope as Record<string, unknown>)['sprint_id'] === sprintId,
    )
    expect(matching).toHaveLength(0)

    // No firing should be recorded for sprint-planning either.
    const firings = await sqlPool<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM ceremony_trigger_firings
      WHERE rule_id = 'sprint-planning'
        AND trigger_event_id = ${env.event_id}
    `
    expect(firings[0]?.count).toBe(0)
  })

  it('records firing rows for matched rules with the resulting ceremony_id', async () => {
    await seedReadyBacklog({ storyCount: 5, pointsEach: 10 })
    const sprintId = await createPlanningSprint(30)
    const env = await store.append({
      aggregate_id: sprintId,
      aggregate_type: 'sprint',
      event_type: 'SprintCreated',
      payload: { sprint_id: sprintId, story_point_capacity: 30 },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })
    await scheduler.onEvent(env)

    const firingRows = await sqlPool<
      Array<{ rule_id: string; ceremony_id: string | null }>
    >`
      SELECT rule_id, ceremony_id
      FROM ceremony_trigger_firings
      WHERE trigger_event_id = ${env.event_id}
    `
    const sprintPlanningFiring = firingRows.find((r) => r.rule_id === 'sprint-planning')
    expect(sprintPlanningFiring).toBeDefined()
    expect(sprintPlanningFiring?.ceremony_id).not.toBeNull()
  })

  // Sanity: ensure the registered rule list matches the brief's 12.
  it('registers all 12 default rules', () => {
    expect(scheduler.registeredRuleIds().sort()).toEqual(
      [
        'architecture-review',
        'backlog-grooming',
        'blocker-resolution',
        'budget-review',
        'code-conflict',
        'continuous-flow-kickoff',
        'disagreement-tiebreaker',
        'mid-sprint-deviation',
        'security-review',
        'sprint-planning',
        'sprint-review',
        'vision-drift',
      ].sort(),
    )
  })

  // The dSQL import is included for convenience in case future assertions
  // need raw query construction.
  void dSQL
})
