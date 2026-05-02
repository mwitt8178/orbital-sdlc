/**
 * demo-replay.ts — drive a synthetic event/post stream from a fixture.
 *
 * Reads sample-data/acme-replay.json which is an array of timed steps. For
 * each step at offset delayMs (scaled by speedMultiplier), the replayer
 * either appends an event via EventStore or inserts a channel post.
 *
 * Idempotency: the install.json.demoReplayId is checked at start. If non-null,
 * a fresh replay is allowed (it just appends more events tagged demo=true).
 * The replay is "best-effort" — drift on individual writes is logged and the
 * loop continues.
 *
 * Speed: speedMultiplier=1 means real-time (~3 minutes). Default 10× makes
 * it run in ~18s, which fits a wizard flow.
 *
 * The replay loop runs in the background; the start procedure returns
 * immediately with {replayId, totalSteps, estimatedDurationMs}.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { uuidv7 } from 'uuidv7'
import { like } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { Actor, AggregateType } from '@orbital/types'
import { channels, channelPosts } from '../db/schema/channels.js'
import { logger } from '../config/logger.js'

interface ReplayStep {
  delayMs: number
  action: 'event' | 'channel_post'
  aggregateType?: string
  eventType?: string
  channelName?: string
  postType?: string
  personaId?: string
  actor?: { type: 'user' | 'persona' | 'system'; personaId?: string }
  summary: string
}

interface ReplayFixture {
  version: number
  label: string
  totalDurationMs: number
  steps: ReplayStep[]
}

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'audit_service' }
const USER_ACTOR_FACTORY = (installId: string): Actor => ({
  type: 'user',
  user_id: 'demo-user',
  install_id: installId,
})
const DEMO_PREFIX = '[DEMO]'

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

let cachedFixture: ReplayFixture | null = null

async function loadReplayFixture(): Promise<ReplayFixture> {
  if (cachedFixture) return cachedFixture
  const here = path.dirname(fileURLToPath(import.meta.url))
  const fixturePath = path.join(here, 'sample-data', 'acme-replay.json')
  const raw = await fs.readFile(fixturePath, 'utf-8')
  cachedFixture = JSON.parse(raw) as ReplayFixture
  return cachedFixture
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface DemoReplayService {
  /**
   * Kick off a replay. Returns immediately. Returns the replayId, total step
   * count, and estimated wall-clock duration in ms.
   */
  start(opts: {
    installId: string
    speedMultiplier: number
  }): Promise<{ replayId: string; totalSteps: number; estimatedDurationMs: number }>

  /** Test helper — wait for an in-flight replay to drain. */
  waitForCompletion(replayId: string): Promise<void>
}

export function createDemoReplayService(db: DB, eventStore: EventStore): DemoReplayService {
  return new DefaultDemoReplayService(db, eventStore)
}

class DefaultDemoReplayService implements DemoReplayService {
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
  ) {}

  async start(opts: {
    installId: string
    speedMultiplier: number
  }): Promise<{ replayId: string; totalSteps: number; estimatedDurationMs: number }> {
    const fixture = await loadReplayFixture()
    const replayId = uuidv7()
    const speed = opts.speedMultiplier > 0 ? opts.speedMultiplier : 1
    const estimated = Math.ceil(fixture.totalDurationMs / speed)

    const promise = this.runReplay(replayId, fixture, opts.installId, speed).catch((err) => {
      logger.warn({ err, replayId }, 'demo-replay: loop failed')
    })
    this.inflight.set(replayId, promise)
    promise.finally(() => this.inflight.delete(replayId))

    return { replayId, totalSteps: fixture.steps.length, estimatedDurationMs: estimated }
  }

  async waitForCompletion(replayId: string): Promise<void> {
    const promise = this.inflight.get(replayId)
    if (promise) await promise
  }

  // ------------------------------------------------------------------------
  // Loop body
  // ------------------------------------------------------------------------

  private async runReplay(
    replayId: string,
    fixture: ReplayFixture,
    installId: string,
    speedMultiplier: number,
  ): Promise<void> {
    const traceId = `demo-replay-${replayId}`
    const startedWallMs = Date.now()
    let lastDelayMs = 0

    // Resolve channel ids by name once at start so post steps don't churn the DB.
    const channelRows = await this.db
      .select({ channelId: channels.channelId, name: channels.name })
      .from(channels)
      .where(like(channels.name, `${DEMO_PREFIX}%`))
    const channelByName = new Map(channelRows.map((r) => [r.name, r.channelId]))

    for (let i = 0; i < fixture.steps.length; i++) {
      const step = fixture.steps[i]!
      const sleepMs = Math.max(0, (step.delayMs - lastDelayMs) / speedMultiplier)
      lastDelayMs = step.delayMs
      if (sleepMs > 0) await sleep(sleepMs)

      try {
        await this.applyStep(step, installId, traceId, channelByName, replayId)
      } catch (err) {
        logger.warn({ err, replayId, stepIndex: i }, 'demo-replay: step failed; continuing')
      }
    }

    const wallMs = Date.now() - startedWallMs
    logger.info({ replayId, wallMs }, 'demo-replay: finished')

    // Final synthetic marker.
    try {
      await this.eventStore.append({
        aggregate_id: replayId,
        aggregate_type: 'install',
        event_type: 'DemoReplayCompleted',
        payload: { replay_id: replayId, wall_ms: wallMs, steps: fixture.steps.length },
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })
    } catch (err) {
      logger.warn({ err, replayId }, 'demo-replay: failed to write completion marker')
    }
  }

  private async applyStep(
    step: ReplayStep,
    installId: string,
    traceId: string,
    channelByName: Map<string, string>,
    replayId: string,
  ): Promise<void> {
    const actor = resolveActor(step, installId)

    if (step.action === 'event') {
      const aggregateType = (step.aggregateType ?? 'system') as AggregateType
      const eventType = step.eventType ?? 'DemoEvent'
      await this.eventStore.append({
        aggregate_id: uuidv7(),
        aggregate_type: aggregateType,
        event_type: eventType,
        payload: { summary: step.summary, replay_id: replayId, demo: true },
        actor,
        trace_id: traceId,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })
      return
    }

    if (step.action === 'channel_post') {
      const channelName = step.channelName
      const channelId = channelName ? channelByName.get(channelName) : null
      if (!channelId) {
        logger.debug({ channelName }, 'demo-replay: channel not found; skipping post')
        return
      }
      const postType = step.postType ?? 'status_update'
      const postId = uuidv7()
      const payload = buildPostPayload(postType, step.summary)
      await this.db.insert(channelPosts).values({
        postId,
        channelId,
        postType: postType as never,
        authorActor: actor as unknown as Record<string, unknown>,
        payload,
      })
      await this.eventStore.append({
        aggregate_id: postId,
        aggregate_type: 'channel_post',
        event_type: 'ChannelPostCreated',
        payload: {
          channel_id: channelId,
          channel_name: channelName,
          post_type: postType,
          summary: step.summary,
          replay_id: replayId,
          demo: true,
        },
        actor,
        trace_id: traceId,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveActor(step: ReplayStep, installId: string): Actor {
  const a = step.actor
  if (!a || a.type === 'system') return SYSTEM_ACTOR
  if (a.type === 'user') return USER_ACTOR_FACTORY(installId)
  if (a.type === 'persona') {
    const personaId = a.personaId ?? step.personaId ?? 'engineer-sr'
    return {
      type: 'persona',
      persona_id: personaId,
      session_id: `demo-session-${personaId}`,
    }
  }
  return SYSTEM_ACTOR
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
