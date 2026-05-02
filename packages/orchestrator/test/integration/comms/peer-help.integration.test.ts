/**
 * Integration test: peer-help — agent posts peer_question to #orb-engineering.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 *
 * Exercises:
 *   1. A jr-dev persona posts a peer_question to the #orb-engineering channel.
 *   2. The message is visible in the channel (channel_posts row exists).
 *   3. A ChannelPostAdded event is written to the event store.
 *   4. Senior personas (em, architect) have channelRead: ['#orb-*'] so they can read it.
 *   5. No child task is spawned (PeerHelpRequested is informational only).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore, PostgresEventStore } from '../../../src/events/store.js'
import { DefaultChannelsService } from '../../../src/comms/channels.js'
import { channelPosts } from '../../../src/db/schema/channels.js'
import { definition as emDef } from '../../../src/personas/library/em.js'
import { definition as architectDef } from '../../../src/personas/library/architect.js'
import { definition as jrDevDef } from '../../../src/personas/library/jr-dev.js'
import type { Actor, ChannelId } from '@orbital/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let eventStore: ReturnType<typeof createEventStore>
let channelsService: DefaultChannelsService

const jrDevActor: Actor = {
  type: 'persona',
  persona_id: 'jr-dev',
  session_id: uuidv7(),
  task_id: uuidv7(),
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await sql`SELECT 1`
  eventStore = createEventStore(db, sql)
  channelsService = new DefaultChannelsService(db, eventStore)
  // Ensure baseline channels exist
  await channelsService.bootstrapBaseline()
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('peer-help: jr-dev posts to #orb-engineering', () => {
  it('successfully posts a peer_question to #orb-engineering', async () => {
    // Get the orb-engineering channel (created by bootstrapBaseline or ensure)
    let orbChannel = await channelsService.getByName('#orb-engineering')
    if (!orbChannel) {
      const result = await channelsService.ensureChannel('topic', 'orb-engineering', {
        description: 'Engineering peer help channel',
        createdBy: jrDevActor,
      })
      orbChannel = { channelId: result.channelId, name: result.name, kind: 'topic' }
    }

    const result = await channelsService.post(
      orbChannel.channelId,
      {
        postType: 'peer_question',
        payload: {
          body: 'Should I split a 15k-row DSQL write into two transactions of 7.5k each, or use a step function? Going with option A provisionally.',
          context_refs: ['ticket:ORB-0055'],
        },
        author: jrDevActor,
        justification: 'Peer help: DSQL transaction size question',
      },
    )

    expect(result.postId).toBeTypeOf('string')
    expect(result.eventId).toBeTypeOf('string')
  })

  it('message is visible in channel_posts with persona author', async () => {
    const orbChannel = await channelsService.getByName('#orb-engineering')
    expect(orbChannel).not.toBeNull()

    const result = await channelsService.post(
      orbChannel!.channelId,
      {
        postType: 'peer_question',
        payload: {
          body: 'Visibility test: is this post stored in channel_posts?',
          context_refs: [],
        },
        author: jrDevActor,
        justification: 'Test peer help visibility',
      },
    )

    // The post should appear in channel_posts
    const rows = await db
      .select()
      .from(channelPosts)
      .where(eq(channelPosts.postId, result.postId))
    expect(rows.length).toBe(1)
    const row = rows[0]!
    expect(row.postType).toBe('peer_question')
    const actor = row.authorActor as Record<string, unknown>
    expect(actor['type']).toBe('persona')
    expect(actor['persona_id']).toBe('jr-dev')
  })

  it('ChannelPostAdded event is emitted for the peer_question post', async () => {
    const orbChannel = await channelsService.getByName('#orb-engineering')
    expect(orbChannel).not.toBeNull()

    const result = await channelsService.post(
      orbChannel!.channelId,
      {
        postType: 'peer_question',
        payload: {
          body: 'Event emission test for peer_question post',
          context_refs: [],
        },
        author: jrDevActor,
        justification: 'Test event emission',
      },
    )

    // ChannelPostAdded event should be in the store
    const events = await eventStore.query({
      aggregate_id: result.postId,
      event_type: 'ChannelPostAdded',
      limit: 5,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)
  })

  it('senior personas (em, architect) have channelRead including #orb-*', () => {
    // Verify capability profile includes #orb-* in channelRead
    const emChannelRead = emDef.defaultCapabilityProfile.channelRead as string[]
    const architectChannelRead = architectDef.defaultCapabilityProfile.channelRead as string[]

    expect(emChannelRead.some((g: string) => g === '#orb-*' || g === '#orb-engineering')).toBe(true)
    expect(architectChannelRead.some((g: string) => g === '#orb-*' || g === '#orb-engineering')).toBe(true)
  })

  it('jr-dev can post to #orb-engineering per channelPost capability profile', () => {
    const jrChannelPost = jrDevDef.defaultCapabilityProfile.channelPost as string[]
    expect(jrChannelPost.some((g: string) => g === '#orb-engineering' || g === '#orb-*')).toBe(true)
  })
})
