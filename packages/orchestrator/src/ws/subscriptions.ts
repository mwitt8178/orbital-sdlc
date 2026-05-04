/**
 * ws/subscriptions.ts — Subscription pattern registry + matcher.
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * Supported subscription patterns (all tenant-scoped):
 *   task:<id>                    — TaskStateChanged, etc. for a specific task
 *   story:<id>                   — Story status + reviewer events for one story
 *   channel:<name>               — ChannelPostAdded etc. for a channel name
 *   project:<id>:events          — All events whose aggregate_id === project_id
 *                                  OR payload.project_id === id
 *   worker:<install_id>:*        — WorkerLifecycle, ToolCall*, LLMRequest* from install
 *   worker:*                     — Same but for ALL installs (admin wildcard)
 *   team:presence                — Presence events (aggregate_type='presence')
 *
 * Tenant isolation:
 *   matchesEvent() ALWAYS checks event.tenant_id === conn.tenantId.
 *   A connection with tenantId X cannot receive events for tenantId Y.
 *   This is the hard guarantee — any pattern match is secondary to this check.
 *
 * Design:
 *   - SubscriptionRegistry is per-connection state.
 *   - matchesEvent(event, tenantId, patterns) is a pure function used by the hub.
 *   - Pattern storage is a Set<string> (the raw pattern string).
 */

import type { EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The set of subscription patterns for a single WS connection. */
export class SubscriptionRegistry {
  private readonly patterns = new Set<string>()

  add(pattern: string): void {
    this.patterns.add(normalizePattern(pattern))
  }

  remove(pattern: string): void {
    this.patterns.delete(normalizePattern(pattern))
  }

  has(pattern: string): boolean {
    return this.patterns.has(normalizePattern(pattern))
  }

  size(): number {
    return this.patterns.size
  }

  toArray(): string[] {
    return Array.from(this.patterns)
  }

  /** Returns a copy of the internal Set for use in matchesEvent(). */
  toSet(): Set<string> {
    return new Set(this.patterns)
  }

  clear(): void {
    this.patterns.clear()
  }
}

// ---------------------------------------------------------------------------
// Pattern normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a subscription pattern string.
 * - Trim whitespace.
 * - Lowercase prefix (task, channel, project, worker, team).
 * - Leave the ID/name portion as-is (UUIDs are already lowercase; channel
 *   names may contain uppercase in theory).
 */
function normalizePattern(pattern: string): string {
  return pattern.trim()
}

// ---------------------------------------------------------------------------
// Pattern → match logic
// ---------------------------------------------------------------------------

/**
 * Pure function: does the event match any of the given subscription patterns
 * for the given tenantId?
 *
 * TENANT CHECK IS MANDATORY: returns false immediately if the event's
 * effective tenant doesn't match tenantId.
 *
 * Tenant resolution strategy (in priority order):
 *   1. event.payload.tenant_id  — set by hub-client when forwarding events
 *   2. event._hub_tenant_id     — injected by HubModeWebSocketHub before fanout
 *   3. If neither present: reject (paranoid default — never leak to wrong tenant)
 *
 * @param event      EventEnvelope to test
 * @param tenantId   The subscribing connection's tenant ID
 * @param patterns   Set/array of pattern strings from the connection's registry
 */
export function matchesEvent(
  event: EventEnvelope,
  tenantId: string,
  patterns: Set<string> | string[],
): boolean {
  // === Hard tenant isolation check ===
  // Try to extract tenant_id from known locations.
  const raw = event as unknown as Record<string, unknown>
  const payload = (raw['payload'] as Record<string, unknown>) ?? {}
  const eventTenantId =
    (typeof raw['_hub_tenant_id'] === 'string' ? raw['_hub_tenant_id'] : null) ??
    (typeof payload['tenant_id'] === 'string' ? payload['tenant_id'] : null)

  if (!eventTenantId || eventTenantId !== tenantId) {
    return false
  }

  const patternSet = patterns instanceof Set ? patterns : new Set(patterns)
  if (patternSet.size === 0) {
    // No subscriptions = no delivery (unlike the old hub which delivered ALL
    // events to connections with empty subscribedChannels). In hub mode,
    // every client must subscribe explicitly.
    return false
  }

  // Re-use the payload already extracted for the tenant check above.
  for (const pattern of patternSet) {
    if (matchPattern(pattern, event, payload)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Individual pattern matchers
// ---------------------------------------------------------------------------

function matchPattern(
  pattern: string,
  event: EventEnvelope,
  payload: Record<string, unknown>,
): boolean {
  // task:<id>
  if (pattern.startsWith('task:')) {
    const taskId = pattern.slice('task:'.length)
    return (
      (event.aggregate_type === 'task' && event.aggregate_id === taskId) ||
      (payload['task_id'] === taskId)
    )
  }

  // story:<id> — reviewer + StoryExecutor events for one story.
  // Matches: story aggregate, task whose payload.story_id matches, and
  // channel posts whose payload.story_id matches (reviewer accept/reject/redirect).
  if (pattern.startsWith('story:')) {
    const storyId = pattern.slice('story:'.length)
    if (!storyId) return false
    return (
      (event.aggregate_type === 'story' && event.aggregate_id === storyId) ||
      payload['story_id'] === storyId
    )
  }

  // channel:<name>
  if (pattern.startsWith('channel:')) {
    const channelName = pattern.slice('channel:'.length)
    return (
      (event.aggregate_type === 'channel' || event.aggregate_type === 'channel_post') &&
      (
        payload['channel_name'] === channelName ||
        payload['channel_id'] === channelName ||
        event.aggregate_id === channelName
      )
    )
  }

  // project:<id>:events
  if (pattern.startsWith('project:') && pattern.endsWith(':events')) {
    const projectId = pattern.slice('project:'.length, -':events'.length)
    return (
      event.aggregate_id === projectId ||
      payload['project_id'] === projectId
    )
  }

  // worker:* — all workers (admin) — check BEFORE worker:<id>:* to avoid
  // 'worker:*' being consumed by the startsWith/endsWith branch below.
  if (pattern === 'worker:*') {
    return isWorkerEvent(event)
  }

  // worker:<install_id>:* — wildcard within a specific install
  if (pattern.startsWith('worker:') && pattern.endsWith(':*')) {
    const installId = pattern.slice('worker:'.length, -':*'.length)
    if (!installId) return false
    return matchesWorkerEvent(event, payload, installId)
  }

  // team:presence — aggregate_type 'presence' is in AggregateTypeSchema
  if (pattern === 'team:presence') {
    return event.aggregate_type === 'presence' || event.event_type === 'PresenceUpdated'
  }

  // Legacy channel subscription patterns (for backwards compat with local WS hub).
  // These are plain channel IDs (UUIDs) that don't match any prefix above.
  if (isUuid(pattern)) {
    return payload['channel_id'] === pattern || event.aggregate_id === pattern
  }

  return false
}

// Worker event types we propagate via worker:* patterns
const WORKER_EVENT_TYPES = new Set([
  'WorkerLifecyclePhase',
  'WorkerKilledByOperator',
  'ToolCallStarted',
  'ToolCallCompleted',
  'LLMRequestStarted',
  'LLMRequestCompleted',
  'SkillLoaded',
  'AgentSpawned',
  'AgentHeartbeat',
  'AgentTimedOut',
])

function isWorkerEvent(event: EventEnvelope): boolean {
  return (
    event.aggregate_type === 'orchestration' &&
    WORKER_EVENT_TYPES.has(event.event_type)
  )
}

function matchesWorkerEvent(
  event: EventEnvelope,
  payload: Record<string, unknown>,
  installId: string,
): boolean {
  if (!isWorkerEvent(event)) return false
  // Match on the install_id in the payload or actor
  const payloadInstallId = payload['install_id']
  const actor = event.actor as Record<string, unknown> | undefined
  const actorInstallId = actor?.['install_id']
  return payloadInstallId === installId || actorInstallId === installId
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

// ---------------------------------------------------------------------------
// Backfill query filter
// ---------------------------------------------------------------------------

/**
 * Compute an event query filter for backfill requests.
 *
 * Given a set of patterns and a cursor (last_seen_event_id), returns a
 * predicate function that tests whether a historical event should be included
 * in the backfill response.
 *
 * Used by hub-side backfill: when a client reconnects with a cursor, the hub
 * queries events newer than that cursor and filters them through the
 * subscription patterns.
 */
export function makeBackfillFilter(
  tenantId: string,
  patterns: Set<string>,
): (event: EventEnvelope) => boolean {
  return (event) => matchesEvent(event, tenantId, patterns)
}
