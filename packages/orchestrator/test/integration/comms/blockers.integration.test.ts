/**
 * Integration test: BlockerService end-to-end.
 *
 * Exercises:
 *   - raise: writes blocker row + post + emits BlockerRaised
 *   - routeToResolver: routes via DEFAULT_RESOLVER_CHAIN, emits BlockerRouted
 *   - critical urgency short-circuits to escalate
 *   - exhausted chain → escalation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { PostgresEventStore } from '../../../src/events/store.js'
import { DefaultChannelsService } from '../../../src/comms/channels.js'
import { DefaultBlockerService } from '../../../src/comms/blockers.js'
import { blockers } from '../../../src/db/schema/comms-workflow.js'
import type { Actor } from '@orbital/types'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital@localhost:5432/orbital'

let sqlPool: postgres.Sql
let store: PostgresEventStore
let channels: DefaultChannelsService
let blockerService: DefaultBlockerService
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 10, idle_timeout: 15, onnotice: () => {} })
  db = drizzle(sqlPool)
  store = new PostgresEventStore(db, sqlPool)
  channels = new DefaultChannelsService(db, store)
  await channels.bootstrapBaseline()
  blockerService = new DefaultBlockerService(db, store, channels)
})

afterAll(async () => {
  await store.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

const personaActor: Actor = {
  type: 'persona',
  persona_id: 'p-tester',
  session_id: 'sess-int-blocker',
}

describe('BlockerService.raise', () => {
  it('writes a blocker row + post + emits BlockerRaised', async () => {
    const taskId = uuidv7()
    const ticketId = `ORB-${uuidv7().slice(0, 8)}`

    const result = await blockerService.raise({
      raisingActor: personaActor,
      raisingTaskId: taskId,
      ticketId,
      question: 'Should we use postgres or DSQL?',
      context: 'See thread for context.',
      requestedResolverRole: 'architect',
      urgency: 'normal',
      justification: 'integration test',
    })

    expect(result.blockerId).toBeTypeOf('string')
    expect(result.originPostId).toBeTypeOf('string')

    const events = await store.query({
      aggregate_id: taskId,
      event_type: 'BlockerRaised',
      limit: 5,
    })
    expect(events.items).toHaveLength(1)
  })
})

describe('BlockerService.routeToResolver', () => {
  it('routes a normal-urgency blocker via DEFAULT_RESOLVER_CHAIN and emits BlockerRouted', async () => {
    const taskId = uuidv7()
    const ticketId = `ORB-${uuidv7().slice(0, 8)}`

    const r = await blockerService.raise({
      raisingActor: personaActor,
      raisingTaskId: taskId,
      ticketId,
      question: 'Where to draw module boundary?',
      context: 'Various modules involved',
      requestedResolverRole: 'architect',
      urgency: 'normal',
      justification: 'integration test',
    })

    const routeResults: Array<{ resolverRole: string }> = []
    const localBlockerService = new DefaultBlockerService(db, store, channels, {
      onRoute: (decision) => {
        routeResults.push({ resolverRole: decision.resolverRole })
      },
    })

    const route = await localBlockerService.routeToResolver(r.blockerId)
    expect(route).not.toBeNull()
    if (!route) return
    expect(route.routedToRole).toBe('architect')
    expect(routeResults).toHaveLength(1)

    const events = await store.query({
      aggregate_id: taskId,
      event_type: 'BlockerRouted',
      limit: 5,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)
    const routedPayload = events.items[0]?.payload as Record<string, unknown>
    expect(routedPayload['target_persona_id']).toBe('architect')
  })

  it('critical urgency short-circuits directly to escalation', async () => {
    const taskId = uuidv7()
    const ticketId = `ORB-${uuidv7().slice(0, 8)}`

    const r = await blockerService.raise({
      raisingActor: personaActor,
      raisingTaskId: taskId,
      ticketId,
      question: 'Production is on fire',
      context: 'all hands',
      requestedResolverRole: 'security_officer',
      urgency: 'critical',
      justification: 'integration test',
    })

    const route = await blockerService.routeToResolver(r.blockerId)
    expect(route).toBeNull() // Escalated, not routed.

    const events = await store.query({
      aggregate_id: taskId,
      event_type: 'BlockerEscalated',
      limit: 5,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)

    const dbRows = await db.select().from(blockers).where(eq(blockers.blockerId, r.blockerId))
    expect(dbRows[0]?.state).toBe('escalated')
  })

  it('exhausts the chain after maxRoutingAttempts and escalates', async () => {
    const taskId = uuidv7()
    const ticketId = `ORB-${uuidv7().slice(0, 8)}`

    const r = await blockerService.raise({
      raisingActor: personaActor,
      raisingTaskId: taskId,
      ticketId,
      question: 'Multi-step blocker',
      context: 'context',
      requestedResolverRole: 'architect',
      urgency: 'normal',
      justification: 'integration test',
    })

    // First route → architect.
    const r1 = await blockerService.routeToResolver(r.blockerId)
    expect(r1).not.toBeNull()
    expect(r1?.routingAttempt).toBe(1)

    // Second route → principal_engineer.
    const r2 = await blockerService.routeToResolver(r.blockerId)
    expect(r2).not.toBeNull()
    expect(r2?.routingAttempt).toBe(2)

    // Third route → exhausted, escalates.
    const r3 = await blockerService.routeToResolver(r.blockerId)
    expect(r3).toBeNull()

    const events = await store.query({
      aggregate_id: taskId,
      event_type: 'BlockerEscalated',
      limit: 5,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)
  })
})

describe('BlockerService.resolve', () => {
  it('resolves a routed blocker and emits BlockerResolved', async () => {
    const taskId = uuidv7()
    const ticketId = `ORB-${uuidv7().slice(0, 8)}`

    const r = await blockerService.raise({
      raisingActor: personaActor,
      raisingTaskId: taskId,
      ticketId,
      question: 'q',
      context: 'c',
      requestedResolverRole: 'architect',
      urgency: 'normal',
      justification: 'integration test',
    })
    await blockerService.routeToResolver(r.blockerId)

    const resolutionPostId = uuidv7()
    await blockerService.resolve({
      blockerId: r.blockerId,
      resolutionPostId,
      resolvedByRole: 'architect',
      actor: personaActor,
    })

    const events = await store.query({
      aggregate_id: taskId,
      event_type: 'BlockerResolved',
      limit: 5,
    })
    expect(events.items).toHaveLength(1)
    const dbRows = await db.select().from(blockers).where(eq(blockers.blockerId, r.blockerId))
    expect(dbRows[0]?.state).toBe('resolved')
  })
})
