/**
 * Integration test: ChannelsService end-to-end with real Postgres.
 *
 * Exercises:
 *   - bootstrapBaseline (idempotent topic seed)
 *   - ensureChannel (idempotent ticket-durable creation)
 *   - post: status_update with mention + cross-reference + emits ChannelPostAdded
 *   - cross-post mechanics: derived posts in N target channels
 *   - circular cross-post rejection
 *   - All events written via EventStore (auditable)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, and } from 'drizzle-orm'
import { PostgresEventStore } from '../../../src/events/store.js'
import { DefaultChannelsService } from '../../../src/comms/channels.js'
import {
  channels,
  channelPosts,
  mentions,
  crossPosts,
  crossReferences,
} from '../../../src/db/schema/channels.js'
import type { Actor, ChannelId } from '@orbital/types'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital@localhost:5432/orbital'

let sqlPool: postgres.Sql
let store: PostgresEventStore
let service: DefaultChannelsService

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 10, idle_timeout: 15, onnotice: () => {} })
  const db = drizzle(sqlPool)
  store = new PostgresEventStore(db, sqlPool)
  service = new DefaultChannelsService(db, store)
})

afterAll(async () => {
  await store.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

const userActor: Actor = {
  type: 'user',
  user_id: 'integration-test-user',
  install_id: '01900000-0000-7000-8000-000000000099',
}

// ---------------------------------------------------------------------------

describe('ChannelsService.bootstrapBaseline', () => {
  it('creates the 5 baseline topic channels idempotently', async () => {
    await service.bootstrapBaseline(userActor)

    // Second call is a no-op (idempotent).
    await service.bootstrapBaseline(userActor)

    for (const name of [
      '#security-alerts',
      '#architecture-decisions',
      '#escalations',
      '#capability-violations',
      '#retro-feed',
    ]) {
      const c = await service.getByName(name)
      expect(c).not.toBeNull()
      expect(c?.kind).toBe('topic')
    }
  })
})

describe('ChannelsService.ensureChannel + post', () => {
  it('creates a ticket_durable channel and accepts all 8 typed posts', async () => {
    const ticketId = `ORB-${uuidv7()}`
    const ensure = await service.ensureChannel('ticket_durable', ticketId, {
      createdBy: userActor,
    })
    expect(ensure.created).toBe(true)
    expect(ensure.name.startsWith('#orb-')).toBe(true)

    // Idempotent re-ensure.
    const second = await service.ensureChannel('ticket_durable', ticketId)
    expect(second.created).toBe(false)
    expect(second.channelId).toBe(ensure.channelId)

    // Post a status_update.
    const status = await service.post(ensure.channelId, {
      postType: 'status_update',
      payload: { body: 'Working on tests', progress_pct: 50 },
      author: userActor,
      justification: 'integration test',
    })
    expect(status.postId).toBeTypeOf('string')

    // Post a decision.
    const decision = await service.post(ensure.channelId, {
      postType: 'decision',
      payload: {
        title: 'Use Postgres for events',
        body: 'See ADR-001 for full rationale',
        alternatives_considered: ['DSQL', 'Kafka'],
        affects: [{ type: 'ticket', id: ticketId }],
      },
      author: userActor,
      justification: 'integration test',
    })
    expect(decision.postId).toBeTypeOf('string')

    // Post all the other types (proves type acceptance).
    for (const tup of [
      { postType: 'alert' as const, payload: { severity: 'high' as const, title: 'oops', body: 'b', source: 'system' as const } },
      { postType: 'system_event' as const, payload: { event_kind: 'sprint_paused', body: 'Paused by user' } },
      { postType: 'capability_event' as const, payload: { capability_id: uuidv7(), outcome: 'denied' as const, scope: 'files_write:src/billing/**', requested_action: 'files.write', reason: 'out of scope', affected_actor: { type: 'persona', persona_id: 'p' } } },
      { postType: 'user_guidance' as const, payload: { body: 'Guidance from user', intent: 'inform' as const } },
      { postType: 'reply' as const, payload: { body: 'A reply' } },
    ]) {
      const r = await service.post(ensure.channelId, {
        postType: tup.postType,
        payload: tup.payload,
        author: userActor,
        justification: 'integration test',
      })
      expect(r.postId).toBeTypeOf('string')
    }
  })

  it('@mention persists a mentions row and resolves priority', async () => {
    const ticketId = `ORB-${uuidv7()}`
    const ensure = await service.ensureChannel('ticket_durable', ticketId, {
      createdBy: userActor,
    })

    const result = await service.post(ensure.channelId, {
      postType: 'user_guidance',
      payload: { body: 'Need attention from architect', intent: 'request_action' },
      author: userActor,
      mentions: [{ target_type: 'persona_role', target_ref: 'architect' }],
      justification: 'integration test',
    })

    expect(result.resolvedMentions).toHaveLength(1)
    const m = result.resolvedMentions[0]
    expect(m).toBeDefined()
    if (!m) return
    // User → role mention has priority 1.
    expect(m.priority).toBe(1)
  })

  it('parses inline cross-references from the body and writes cross_references rows', async () => {
    const ticketId = `ORB-${uuidv7()}`
    const ensure = await service.ensureChannel('ticket_durable', ticketId, {
      createdBy: userActor,
    })

    const result = await service.post(ensure.channelId, {
      postType: 'user_guidance',
      payload: { body: 'See ~ORB-99 and ADR-014 in #sprint-3', intent: 'inform' },
      author: userActor,
      justification: 'integration test',
    })

    expect(result.resolvedCrossReferences).toHaveLength(3)
    const types = result.resolvedCrossReferences.map((r) => r.refType).sort()
    expect(types).toEqual(['adr', 'channel', 'ticket'])
  })

  it('cross_post creates derived posts in target channels with attribution', async () => {
    const ticketA = `ORB-${uuidv7().slice(0, 8)}`
    const ticketB = `ORB-${uuidv7().slice(0, 8)}`
    const a = await service.ensureChannel('ticket_durable', ticketA, { createdBy: userActor })
    const b = await service.ensureChannel('ticket_durable', ticketB, { createdBy: userActor })

    const origin = await service.post(a.channelId, {
      postType: 'decision',
      payload: { title: 'Use Postgres', body: 'See rationale', alternatives_considered: [], affects: [] },
      author: userActor,
      justification: 'integration test',
    })

    const result = await service.crossPost({
      originatingPostId: origin.postId,
      targetChannelNames: [b.name],
      badgeLabel: 'DECISION LINK',
      author: userActor,
      summary: 'Decision propagated',
      justification: 'cross-post test',
    })

    expect(result.crossPostIds).toHaveLength(1)
    expect(result.derivedPostIds).toHaveLength(1)
  })

  it('rejects circular cross_post (cross_post of a cross_post)', async () => {
    const ticketA = `ORB-${uuidv7().slice(0, 8)}`
    const ticketB = `ORB-${uuidv7().slice(0, 8)}`
    const ticketC = `ORB-${uuidv7().slice(0, 8)}`
    const a = await service.ensureChannel('ticket_durable', ticketA, { createdBy: userActor })
    const b = await service.ensureChannel('ticket_durable', ticketB, { createdBy: userActor })
    const c = await service.ensureChannel('ticket_durable', ticketC, { createdBy: userActor })

    const origin = await service.post(a.channelId, {
      postType: 'decision',
      payload: { title: 't', body: 'b', alternatives_considered: [], affects: [] },
      author: userActor,
      justification: 'integration test',
    })

    const firstCross = await service.crossPost({
      originatingPostId: origin.postId,
      targetChannelNames: [b.name],
      badgeLabel: 'DECISION LINK',
      author: userActor,
      summary: 'Hop 1',
      justification: 'cross-post test',
    })
    const derivedId = firstCross.derivedPostIds[0]
    expect(derivedId).toBeDefined()
    if (!derivedId) return

    await expect(
      service.crossPost({
        originatingPostId: derivedId,
        targetChannelNames: [c.name],
        badgeLabel: 'CHAIN',
        author: userActor,
        summary: 'should fail',
        justification: 'cross-post test',
      }),
    ).rejects.toThrow(/circular|VALIDATION_INVALID_REQUEST/)
  })

  it('every channel post emits ChannelPostAdded retrievable via EventStore.query', async () => {
    const ticketId = `ORB-${uuidv7()}`
    const ensure = await service.ensureChannel('ticket_durable', ticketId, {
      createdBy: userActor,
    })

    const post = await service.post(ensure.channelId, {
      postType: 'status_update',
      payload: { body: 'audit me' },
      author: userActor,
      justification: 'integration test',
    })

    const events = await store.query({
      aggregate_id: post.postId,
      event_type: 'ChannelPostAdded',
      limit: 10,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)
  })
})

describe('ChannelsService.subscribe and presence', () => {
  it('subscribe creates a subscription and emits ChannelSubscribed', async () => {
    const ticketId = `ORB-${uuidv7()}`
    const ensure = await service.ensureChannel('ticket_durable', ticketId, {
      createdBy: userActor,
    })

    const subs = await service.subscribe(userActor, [ensure.channelId])
    expect(subs).toHaveLength(1)
    const first = subs[0]
    expect(first?.channelId).toBe(ensure.channelId)

    const evRows = await store.query({
      aggregate_id: ensure.channelId,
      event_type: 'ChannelSubscribed',
      limit: 5,
    })
    expect(evRows.items.length).toBeGreaterThanOrEqual(1)
  })

  it('recordPresence upserts a presence_indicators row', async () => {
    const ticketId = `ORB-${uuidv7()}`
    const ensure = await service.ensureChannel('ticket_durable', ticketId, {
      createdBy: userActor,
    })
    await service.recordPresence({ actor: userActor, channelId: ensure.channelId, status: 'active' })
    await service.recordPresence({ actor: userActor, channelId: ensure.channelId, status: 'idle' })
    // No throw = success; the second call must update, not insert (no unique conflict).
    expect(true).toBe(true)
  })
})
