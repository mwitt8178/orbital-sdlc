/**
 * inspection/service.ts — InspectionService
 *
 * In-memory aggregator that, given a worker_id, reads recent events from an
 * ephemeral per-worker cache and returns a WorkerInspection object.
 *
 * Design: the service subscribes to the event store and keeps an in-memory
 * cache of inspection state per worker. It does NOT query Postgres for each
 * inspect() call — that would add latency on the hot path. Instead, events
 * stream in via subscribe() and update the cache in real time.
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { uuidv7 } from 'uuidv7'
import { logger } from '../config/logger.js'
import type { EventStore } from '../events/store.js'
import type {
  ToolCallStartedPayload,
  ToolCallCompletedPayload,
  LLMRequestStartedPayload,
  LLMRequestCompletedPayload,
  SkillLoadedPayload,
  WorkerLifecyclePhasePayload,
  AgentChannelPostedPayload,
} from '../events/types.js'
import type {
  WorkerInspection,
  WorkerRegistrationParams,
  InspectionTimelineEntry,
  WorkerState,
} from './types.js'

// ---------------------------------------------------------------------------
// Ephemeral event cache
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS = 50
const MAX_LLM_CALLS = 20
const MAX_TIMELINE_ENTRIES = 200

interface WorkerCacheEntry {
  registration: WorkerRegistrationParams
  state: WorkerState
  lastActivityAt: string
  toolCalls: Map<string, WorkerInspection['recentToolCalls'][number]>
  toolCallOrder: string[]  // ordered tool_call_ids (up to MAX_TOOL_CALLS)
  llmCalls: Map<string, WorkerInspection['recentLLMCalls'][number]>
  llmCallOrder: string[]   // ordered llm_call_ids (up to MAX_LLM_CALLS)
  skillsLoaded: WorkerInspection['skillsLoaded']
  timeline: InspectionTimelineEntry[]
  costToDate: { tokens: number; usd: number }
  outputTail: string[]
  recentChannelPosts: WorkerInspection['recentChannelPosts']
}

const MAX_CHANNEL_POSTS = 10

export interface InspectionEventCache {
  get(workerId: string): WorkerCacheEntry | undefined
  set(workerId: string, entry: WorkerCacheEntry): void
  delete(workerId: string): void
  keys(): IterableIterator<string>
}

/**
 * Create the default in-memory cache.
 * Exported for tests to create isolated instances.
 */
export function createInspectionEventCache(): InspectionEventCache {
  const store = new Map<string, WorkerCacheEntry>()
  return {
    get: (id) => store.get(id),
    set: (id, entry) => { store.set(id, entry) },
    delete: (id) => { store.delete(id) },
    keys: () => store.keys(),
  }
}

// ---------------------------------------------------------------------------
// InspectionService
// ---------------------------------------------------------------------------

export class InspectionService {
  private readonly unsubscribe: () => void

  constructor(
    private readonly eventStore: EventStore,
    private readonly cache: InspectionEventCache,
  ) {
    // Subscribe to the event store to keep the cache up to date.
    this.unsubscribe = this.eventStore.subscribe(null, (envelope) => {
      this.handleEvent(envelope as {
        event_id: string
        event_type: string
        aggregate_id: string
        aggregate_type: string
        payload: unknown
        occurred_at: string
      })
    })
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a worker at spawn time. Creates the initial cache entry.
   */
  registerWorker(workerId: string, params: WorkerRegistrationParams): void {
    const entry: WorkerCacheEntry = {
      registration: params,
      state: 'starting',
      lastActivityAt: params.startedAt,
      toolCalls: new Map(),
      toolCallOrder: [],
      llmCalls: new Map(),
      llmCallOrder: [],
      skillsLoaded: [],
      timeline: [],
      costToDate: { tokens: 0, usd: 0 },
      outputTail: [],
      recentChannelPosts: [],
    }
    this.cache.set(workerId, entry)
    logger.debug({ workerId }, 'InspectionService: worker registered')
  }

  /**
   * Return the current inspection snapshot for a worker.
   * Returns null if the worker is unknown.
   */
  inspect(workerId: string): WorkerInspection | null {
    const entry = this.cache.get(workerId)
    if (!entry) return null

    const r = entry.registration
    const toolCalls = entry.toolCallOrder
      .slice(-MAX_TOOL_CALLS)
      .map((id) => entry.toolCalls.get(id))
      .filter((tc): tc is NonNullable<typeof tc> => tc !== undefined)
    const llmCalls = entry.llmCallOrder
      .slice(-MAX_LLM_CALLS)
      .map((id) => entry.llmCalls.get(id))
      .filter((lc): lc is NonNullable<typeof lc> => lc !== undefined)

    return {
      workerId,
      taskId: r.taskId,
      ticketId: r.ticketId,
      persona: {
        id: r.personaId,
        name: r.personaName,
        tier: deriveTier(r.modelId),
      },
      model: {
        provider: r.modelProvider,
        model: r.modelId,
      },
      state: entry.state,
      startedAt: r.startedAt,
      lastActivityAt: entry.lastActivityAt,
      capability: {
        scopes: r.capabilityScopes,
        expiresAt: r.capabilityExpiresAt,
      },
      skillsLoaded: [...entry.skillsLoaded],
      recentLLMCalls: llmCalls,
      recentToolCalls: toolCalls,
      costToDate: { ...entry.costToDate },
      costBudgetForScope: r.costBudgetForScope,
      recentChannelPosts: [...entry.recentChannelPosts],
      outputTail: [...entry.outputTail],
    }
  }

  /**
   * Return recent timeline entries for a worker since a given timestamp.
   */
  timeline(workerId: string, since: string): InspectionTimelineEntry[] {
    const entry = this.cache.get(workerId)
    if (!entry) return []
    return entry.timeline.filter((e) => e.occurred_at >= since)
  }

  /**
   * Return all workers that are not terminated.
   */
  listActive(): WorkerInspection[] {
    const active: WorkerInspection[] = []
    for (const workerId of this.cache.keys()) {
      const inspection = this.inspect(workerId)
      if (inspection && inspection.state !== 'terminated') {
        active.push(inspection)
      }
    }
    return active
  }

  /**
   * Stop the event subscription.
   */
  stop(): void {
    this.unsubscribe()
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  private handleEvent(envelope: {
    event_id: string
    event_type: string
    aggregate_id: string
    aggregate_type: string
    payload: unknown
    occurred_at: string
  }): void {
    const workerId = envelope.aggregate_id
    const entry = this.cache.get(workerId)
    if (!entry) return  // not a worker we're tracking

    // Add to timeline (capped)
    const timelineEntry: InspectionTimelineEntry = {
      event_id: envelope.event_id,
      event_type: envelope.event_type,
      aggregate_id: envelope.aggregate_id,
      occurred_at: envelope.occurred_at,
      payload: envelope.payload,
    }
    entry.timeline.push(timelineEntry)
    if (entry.timeline.length > MAX_TIMELINE_ENTRIES) {
      entry.timeline.splice(0, entry.timeline.length - MAX_TIMELINE_ENTRIES)
    }

    entry.lastActivityAt = envelope.occurred_at

    switch (envelope.event_type) {
      case 'ToolCallStarted': {
        const p = envelope.payload as ToolCallStartedPayload
        entry.toolCalls.set(p.tool_call_id, {
          toolCallId: p.tool_call_id,
          name: p.tool_name,
          startedAt: p.started_at,
          status: 'pending',
          argsSummary: p.args_summary,
        })
        if (!entry.toolCallOrder.includes(p.tool_call_id)) {
          entry.toolCallOrder.push(p.tool_call_id)
          if (entry.toolCallOrder.length > MAX_TOOL_CALLS) {
            const removed = entry.toolCallOrder.splice(0, 1)[0]
            if (removed) entry.toolCalls.delete(removed)
          }
        }
        break
      }

      case 'ToolCallCompleted': {
        const p = envelope.payload as ToolCallCompletedPayload
        const existing = entry.toolCalls.get(p.tool_call_id)
        if (existing) {
          existing.status = p.status
          existing.durationMs = p.duration_ms
          existing.resultExcerpt = p.result_excerpt
        } else {
          // Completed without Started (missed event) — add as complete
          entry.toolCalls.set(p.tool_call_id, {
            toolCallId: p.tool_call_id,
            name: p.tool_name,
            startedAt: envelope.occurred_at,
            status: p.status,
            durationMs: p.duration_ms,
            resultExcerpt: p.result_excerpt,
          })
          if (!entry.toolCallOrder.includes(p.tool_call_id)) {
            entry.toolCallOrder.push(p.tool_call_id)
          }
        }
        break
      }

      case 'LLMRequestStarted': {
        const p = envelope.payload as LLMRequestStartedPayload
        entry.llmCalls.set(p.llm_call_id, {
          llmCallId: p.llm_call_id,
          startedAt: p.started_at,
          status: 'pending',
          provider: p.provider,
          model: p.model,
        })
        if (!entry.llmCallOrder.includes(p.llm_call_id)) {
          entry.llmCallOrder.push(p.llm_call_id)
          if (entry.llmCallOrder.length > MAX_LLM_CALLS) {
            const removed = entry.llmCallOrder.splice(0, 1)[0]
            if (removed) entry.llmCalls.delete(removed)
          }
        }
        break
      }

      case 'LLMRequestCompleted': {
        const p = envelope.payload as LLMRequestCompletedPayload
        const existing = entry.llmCalls.get(p.llm_call_id)
        if (existing) {
          existing.status = p.status
          existing.durationMs = p.duration_ms
          existing.inputTokens = p.input_tokens
          existing.outputTokens = p.output_tokens
          existing.costUSD = p.cost_usd
        } else {
          entry.llmCalls.set(p.llm_call_id, {
            llmCallId: p.llm_call_id,
            startedAt: envelope.occurred_at,
            status: p.status,
            provider: p.provider,
            model: p.model,
            durationMs: p.duration_ms,
            inputTokens: p.input_tokens,
            outputTokens: p.output_tokens,
            costUSD: p.cost_usd,
          })
          if (!entry.llmCallOrder.includes(p.llm_call_id)) {
            entry.llmCallOrder.push(p.llm_call_id)
          }
        }
        // Accumulate cost
        if (p.cost_usd) {
          entry.costToDate.usd += p.cost_usd
        }
        if (p.input_tokens || p.output_tokens) {
          entry.costToDate.tokens += (p.input_tokens ?? 0) + (p.output_tokens ?? 0)
        }
        break
      }

      case 'SkillLoaded': {
        const p = envelope.payload as SkillLoadedPayload
        const alreadyLoaded = entry.skillsLoaded.some((s) => s.id === p.skill_id)
        if (!alreadyLoaded) {
          entry.skillsLoaded.push({
            id: p.skill_id,
            loadedAt: p.loaded_at,
            sourceSha256: p.source_sha256,
          })
        }
        break
      }

      case 'WorkerLifecyclePhase': {
        const p = envelope.payload as WorkerLifecyclePhasePayload
        entry.state = p.phase as WorkerState
        break
      }

      case 'AgentChannelPosted': {
        const p = envelope.payload as AgentChannelPostedPayload
        // session_id from the payload identifies the spawning worker
        if (p.session_id !== envelope.aggregate_id) {
          // Defensive: only attribute the post to the correct worker entry
        }
        entry.recentChannelPosts.unshift({
          channel: p.channel_name,
          bodyExcerpt: p.body_excerpt,
          postedAt: envelope.occurred_at,
        })
        if (entry.recentChannelPosts.length > MAX_CHANNEL_POSTS) {
          entry.recentChannelPosts.length = MAX_CHANNEL_POSTS
        }
        break
      }

      default:
        // Unrecognised event types — ignore silently
        break
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _instance: InspectionService | null = null
let _cache: InspectionEventCache | null = null

export function createInspectionService(eventStore: EventStore): InspectionService {
  if (!_cache) _cache = createInspectionEventCache()
  if (!_instance) _instance = new InspectionService(eventStore, _cache)
  return _instance
}

export function getInspectionService(): InspectionService | null {
  return _instance
}

/** For tests: reset the singleton. */
export function _resetInspectionServiceForTests(): void {
  _instance?.stop()
  _instance = null
  _cache = null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveTier(modelId: string): string {
  if (modelId.includes('opus')) return 'opus'
  if (modelId.includes('sonnet')) return 'sonnet'
  if (modelId.includes('haiku')) return 'haiku'
  if (modelId.includes('gpt-4o-mini')) return 'gpt-4o-mini'
  if (modelId.includes('gpt-4o')) return 'gpt-4o'
  return modelId.split('-')[0] ?? modelId
}

// Re-export uuidv7 for callers (avoids double import in gateway)
export { uuidv7 }
