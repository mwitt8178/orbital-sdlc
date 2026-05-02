/**
 * sample-loader.ts — load the Acme sample dataset into the running install.
 *
 * Strategy:
 *  - Idempotent. Uses install.demoReplayId as a marker; if already loaded,
 *    returns alreadyLoaded=true and does nothing.
 *  - Writes directly to existing tables (sprints, epics, stories, channels,
 *    channel_posts) using the [DEMO] name prefix so reset can scan-and-clean.
 *  - For each insert, also emits a corresponding event via EventStore.append.
 *  - No capability checks — sample data is not user-actionable; the system
 *    actor (component='audit_service') is the author for audit purposes.
 *
 * The fixture lives at sample-data/acme.json and is bundled with the package.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { uuidv7 } from 'uuidv7'
import { eq, sql as dSQL, like } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { Actor } from '@orbital/types'
import { sprints, epics, stories } from '../db/schema/backlog.js'
import { channels, channelPosts } from '../db/schema/channels.js'
import {
  readInstallState,
  setDemoReplayId,
} from './install-state.js'

// ---------------------------------------------------------------------------
// Fixture types — mirror sample-data/acme.json
// ---------------------------------------------------------------------------

interface AcmeFixture {
  version: number
  label: string
  description: string
  namePrefix: string
  vision: { title: string; summary: string }
  epics: Array<{ key: string; title: string; rationale: string }>
  stories: Array<{ key: string; epicKey: string; title: string; points: number }>
  sprints: Array<{
    key: string
    name: string
    sequence: number
    status: 'planning' | 'ready' | 'active' | 'completing' | 'completed' | 'paused'
    storyPointCapacity: number
    budgetUsdCents: number
    startedAtOffsetMs: number | null
    completedAtOffsetMs: number | null
    taskKeys: string[]
  }>
  channels: Array<{ name: string; kind: string; description: string }>
  channelPosts: Array<{
    channelName: string
    postType: string
    personaId: string
    summary: string
    offsetMs: number
  }>
  retro: {
    key: string
    summary: string
    proposals: Array<{ key: string; title: string; rationale: string; status: string }>
  }
}

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'audit_service' }
const DEMO_PREFIX = '[DEMO]'

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

let cachedFixture: AcmeFixture | null = null

export async function loadFixture(): Promise<AcmeFixture> {
  if (cachedFixture) return cachedFixture
  const here = path.dirname(fileURLToPath(import.meta.url))
  const fixturePath = path.join(here, 'sample-data', 'acme.json')
  const raw = await fs.readFile(fixturePath, 'utf-8')
  cachedFixture = JSON.parse(raw) as AcmeFixture
  return cachedFixture
}

// ---------------------------------------------------------------------------
// Loader result
// ---------------------------------------------------------------------------

export interface SampleLoadResult {
  loaded: boolean
  alreadyLoaded: boolean
  visionDocumentId: string | null
  sprintIds: string[]
  channelIds: string[]
  retroReportId: string | null
  eventCount: number
}

// ---------------------------------------------------------------------------
// Sample loader
// ---------------------------------------------------------------------------

export interface SampleLoader {
  load(): Promise<SampleLoadResult>
  reset(): Promise<{ removedSprints: number; removedChannels: number }>
  isLoaded(): Promise<boolean>
}

export function createSampleLoader(db: DB, eventStore: EventStore): SampleLoader {
  return new DefaultSampleLoader(db, eventStore)
}

class DefaultSampleLoader implements SampleLoader {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
  ) {}

  async isLoaded(): Promise<boolean> {
    const state = await readInstallState()
    if (state.demoReplayId !== null) return true
    // Also check by name prefix in case install.json was reset out-of-band.
    const present = await this.db
      .select({ count: dSQL<number>`COUNT(*)::int` })
      .from(sprints)
      .where(like(sprints.name, `${DEMO_PREFIX}%`))
    return (present[0]?.count ?? 0) > 0
  }

  async load(): Promise<SampleLoadResult> {
    const state = await readInstallState()
    if (state.demoReplayId !== null) {
      return {
        loaded: false,
        alreadyLoaded: true,
        visionDocumentId: null,
        sprintIds: [],
        channelIds: [],
        retroReportId: null,
        eventCount: 0,
      }
    }

    const fixture = await loadFixture()
    const replayId = uuidv7()
    const traceId = `demo-load-${replayId}`
    const now = Date.now()
    let eventCount = 0

    // 1. Insert epics
    const epicKeyToId = new Map<string, string>()
    const visionVersionId = uuidv7() // placeholder; we don't write a real vision_version row
    for (const e of fixture.epics) {
      const epicId = uuidv7()
      epicKeyToId.set(e.key, epicId)
      await this.db.insert(epics).values({
        epicId,
        visionVersionId,
        title: `${DEMO_PREFIX} ${e.title}`,
        rationale: e.rationale,
        priority: 50,
        status: 'active',
      })
      await this.eventStore.append({
        aggregate_id: epicId,
        aggregate_type: 'epic',
        event_type: 'EpicCreated',
        payload: { title: e.title, demo: true },
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: new Date(now - 7 * 86_400_000).toISOString(),
        schema_version: 1,
      })
      eventCount++
    }

    // 2. Insert stories
    const storyKeyToId = new Map<string, string>()
    for (const s of fixture.stories) {
      const epicId = epicKeyToId.get(s.epicKey)
      if (!epicId) continue
      const storyId = uuidv7()
      storyKeyToId.set(s.key, storyId)
      await this.db.insert(stories).values({
        storyId,
        epicId,
        title: `${DEMO_PREFIX} ${s.key} ${s.title}`,
        description: s.title,
        status: 'ready',
        storyPoints: s.points,
        priority: 50,
      })
      await this.eventStore.append({
        aggregate_id: storyId,
        aggregate_type: 'story',
        event_type: 'StoryCreated',
        payload: { story_key: s.key, points: s.points, demo: true },
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: new Date(now - 5 * 86_400_000).toISOString(),
        schema_version: 1,
      })
      eventCount++
    }

    // 3. Insert sprints
    const sprintIds: string[] = []
    for (const sp of fixture.sprints) {
      const sprintId = uuidv7()
      sprintIds.push(sprintId)
      const startedAt = sp.startedAtOffsetMs !== null ? new Date(now + sp.startedAtOffsetMs) : null
      const completedAt =
        sp.completedAtOffsetMs !== null ? new Date(now + sp.completedAtOffsetMs) : null
      await this.db.insert(sprints).values({
        sprintId,
        name: sp.name,
        sequence: sp.sequence,
        status: sp.status,
        storyPointCapacity: sp.storyPointCapacity,
        budgetUsdCents: sp.budgetUsdCents,
        concurrencyShare: 100,
        priorityClass: 'standard',
        startedAt,
        completedAt,
      })
      const eventType = sp.status === 'completed' ? 'SprintCompleted' : 'SprintStarted'
      await this.eventStore.append({
        aggregate_id: sprintId,
        aggregate_type: 'sprint',
        event_type: eventType,
        payload: { sprint_name: sp.name, demo: true },
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: (startedAt ?? new Date(now)).toISOString(),
        schema_version: 1,
      })
      eventCount++
    }

    // 4. Insert channels
    const channelNameToId = new Map<string, string>()
    const channelIds: string[] = []
    for (const c of fixture.channels) {
      const channelId = uuidv7()
      channelNameToId.set(c.name, channelId)
      channelIds.push(channelId)
      await this.db.insert(channels).values({
        channelId,
        name: c.name,
        kind: c.kind as never,
        scopeRef: { demo: 'true' },
        description: c.description,
        createdByActor: SYSTEM_ACTOR as unknown as Record<string, unknown>,
      })
      await this.eventStore.append({
        aggregate_id: channelId,
        aggregate_type: 'channel',
        event_type: 'ChannelCreated',
        payload: { name: c.name, kind: c.kind, demo: true },
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: new Date(now - 3 * 86_400_000).toISOString(),
        schema_version: 1,
      })
      eventCount++
    }

    // 5. Insert channel posts
    for (const post of fixture.channelPosts) {
      const channelId = channelNameToId.get(post.channelName)
      if (!channelId) continue
      const postId = uuidv7()
      const personaActor: Actor = {
        type: 'persona',
        persona_id: post.personaId,
        session_id: `demo-session-${post.personaId}`,
      }
      const payload = buildPostPayload(post.postType, post.summary)
      await this.db.insert(channelPosts).values({
        postId,
        channelId,
        postType: post.postType as never,
        authorActor: personaActor as unknown as Record<string, unknown>,
        payload,
      })
      await this.eventStore.append({
        aggregate_id: postId,
        aggregate_type: 'channel_post',
        event_type: 'ChannelPostCreated',
        payload: {
          channel_id: channelId,
          channel_name: post.channelName,
          post_type: post.postType,
          summary: post.summary,
          demo: true,
        },
        actor: personaActor,
        trace_id: traceId,
        occurred_at: new Date(now + post.offsetMs).toISOString(),
        schema_version: 1,
      })
      eventCount++
    }

    // 6. Mark loaded — store replay_id in install.json.
    await setDemoReplayId(replayId)

    // 7. Synthetic SampleDatasetLoaded marker event.
    await this.eventStore.append({
      aggregate_id: replayId,
      aggregate_type: 'install',
      event_type: 'SampleDatasetLoaded',
      payload: {
        replay_id: replayId,
        sprints: sprintIds.length,
        channels: channelIds.length,
        events: eventCount,
        label: fixture.label,
      },
      actor: SYSTEM_ACTOR,
      trace_id: traceId,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })
    eventCount++

    return {
      loaded: true,
      alreadyLoaded: false,
      visionDocumentId: null,
      sprintIds,
      channelIds,
      retroReportId: null,
      eventCount,
    }
  }

  async reset(): Promise<{ removedSprints: number; removedChannels: number }> {
    // Delete child rows first to respect FK ordering.
    // Channel posts → channels; stories → epics; tasks/sprint linkage we leave
    // (no tasks were created by the loader). Use name-prefix filtering.

    // 1. Find demo channels.
    const demoChannels = await this.db
      .select({ channelId: channels.channelId })
      .from(channels)
      .where(like(channels.name, `${DEMO_PREFIX}%`))
    const demoChannelIds = demoChannels.map((c) => c.channelId)

    // 2. Delete channel posts in those channels.
    let removedChannels = 0
    if (demoChannelIds.length > 0) {
      // Drizzle's IN is awkward when we want DELETE with sub-IN; fall back to one-by-one.
      for (const id of demoChannelIds) {
        await this.db.delete(channelPosts).where(eq(channelPosts.channelId, id))
      }
      // Delete channels themselves.
      const cdel = await this.db
        .delete(channels)
        .where(like(channels.name, `${DEMO_PREFIX}%`))
        .returning({ channelId: channels.channelId })
      removedChannels = cdel.length
    }

    // 3. Delete stories under demo epics, then demo epics.
    const demoEpics = await this.db
      .select({ epicId: epics.epicId })
      .from(epics)
      .where(like(epics.title, `${DEMO_PREFIX}%`))
    for (const e of demoEpics) {
      await this.db.delete(stories).where(eq(stories.epicId, e.epicId))
    }
    await this.db.delete(epics).where(like(epics.title, `${DEMO_PREFIX}%`))

    // 4. Delete demo sprints.
    const sdel = await this.db
      .delete(sprints)
      .where(like(sprints.name, `${DEMO_PREFIX}%`))
      .returning({ sprintId: sprints.sprintId })
    const removedSprints = sdel.length

    // 5. Clear replay marker.
    await setDemoReplayId(null)

    return { removedSprints, removedChannels }
  }
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function buildPostPayload(postType: string, summary: string): Record<string, unknown> {
  switch (postType) {
    case 'status_update':
      return { body: summary }
    case 'decision':
      return {
        title: summary.slice(0, 60),
        body: summary,
        alternatives_considered: [],
        affects: [],
      }
    case 'alert':
      return {
        severity: 'medium',
        title: summary.slice(0, 60),
        body: summary,
        source: 'system',
      }
    case 'system_event':
      return { event_kind: 'demo_event', body: summary }
    default:
      return { body: summary }
  }
}
