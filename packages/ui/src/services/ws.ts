/**
 * services/ws.ts — UI WebSocket client.
 *
 * Connects to /ws on app mount; sends an initial `subscribe` frame on open.
 * Dispatches inbound `event` envelopes into Zustand stores keyed by
 * aggregate_type + event_type. The server is always source of truth — the
 * stores are a transient cache so views re-render without waiting for a full
 * tRPC re-fetch on every event.
 *
 * Reconnect: exponential backoff up to 30s.
 */

import { WSMessageSchema, type EventEnvelope } from '@orbital/types'
import { useConnectionStore } from '../store/connection.js'
import { useEventsStore } from '../store/events.js'
import {
  useWorkersStore,
  type WorkerView,
  type WorkerOutputLineView,
} from '../store/workers.js'
import { useChannelsStore, type ChannelPost } from '../store/channels.js'
import { useSprintsStore } from '../store/sprints.js'
import { useCeremoniesStore } from '../store/ceremonies.js'
import { useVisionStore, type VisionMessage } from '../store/vision.js'

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const BACKOFF_FACTOR = 2

function computeBackoff(attempt: number): number {
  const raw = MIN_BACKOFF_MS * Math.pow(BACKOFF_FACTOR, attempt)
  return Math.min(raw, MAX_BACKOFF_MS)
}

class WebSocketClient {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  connect(): void {
    if (this.destroyed) return
    this.clearReconnectTimer()
    this.doConnect()
  }

  private doConnect(): void {
    const { setStatus, cursor, reconnectAttempts } = useConnectionStore.getState()

    const url = buildWsUrl(cursor)
    if (url === null) {
      // No WS endpoint configured for this build (e.g. CloudFront-only deploy
      // before VITE_WS_URL is wired). Stop quietly rather than error-looping.
      setStatus('disconnected')
      return
    }

    setStatus(reconnectAttempts === 0 ? 'connecting' : 'reconnecting')

    try {
      this.ws = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.addEventListener('open', () => {
      const conn = useConnectionStore.getState()
      conn.setStatus('connected')
      conn.resetReconnectAttempts()

      // Send subscribe frame: empty channel_ids = receive all (admin/all).
      // The hub already filters by aggregate_type to relevant aggregates.
      this.send({
        type: 'subscribe',
        channel_ids: [],
        cursor: conn.cursor ?? undefined,
      })
    })

    this.ws.addEventListener('message', (ev: MessageEvent) => {
      this.handleMessage(ev.data)
    })

    this.ws.addEventListener('close', (ev: CloseEvent) => {
      if (!this.destroyed) {
        console.warn('[ws] connection closed', { code: ev.code, reason: ev.reason, url })
        this.scheduleReconnect()
      }
    })

    this.ws.addEventListener('error', (ev: Event) => {
      console.warn('[ws] connection error', ev)
      // close fires immediately after error; scheduleReconnect is called there.
      useConnectionStore.getState().setStatus('reconnecting')
    })
  }

  private handleMessage(raw: unknown): void {
    let data: unknown
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      return
    }

    const parsed = WSMessageSchema.safeParse(data)
    if (!parsed.success) return

    const msg = parsed.data

    if (msg.ws_type === 'event') {
      const payload = msg.payload as Record<string, unknown>
      // Hub fan-out wraps the EventEnvelope inside payload (ws/hub.ts §fanOut).
      const envelope: EventEnvelope = {
        event_id: String(payload['event_id'] ?? ''),
        aggregate_id: String(payload['aggregate_id'] ?? ''),
        aggregate_type: payload['aggregate_type'] as EventEnvelope['aggregate_type'],
        event_type: String(payload['event_type'] ?? ''),
        payload: (payload['payload'] as Record<string, unknown>) ?? {},
        actor: payload['actor'] as EventEnvelope['actor'],
        trace_id: String(payload['trace_id'] ?? ''),
        occurred_at: String(payload['occurred_at'] ?? new Date().toISOString()),
        ingested_at: String(payload['ingested_at'] ?? new Date().toISOString()),
        schema_version: Number(payload['schema_version'] ?? 1),
      }

      // 1. Append to the global event ring (Activity Stream).
      useEventsStore.getState().appendEvent(envelope)
      // 2. Dispatch to feature stores.
      dispatchEnvelope(envelope)
      // 3. Move cursor forward.
      if (msg.cursor) {
        useConnectionStore.getState().setCursor(msg.cursor)
      }
    }

    if (msg.ws_type === 'snapshot' && msg.cursor) {
      useConnectionStore.getState().setCursor(msg.cursor)
    }

    if (msg.ws_type === 'ping') {
      this.send({
        ws_message_id: crypto.randomUUID(),
        ws_type: 'pong',
        payload: {},
        trace_id: msg.trace_id,
      })
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return
    useConnectionStore.getState().setStatus('reconnecting')
    useConnectionStore.getState().incrementReconnectAttempts()
    // Read attempts AFTER the increment so the backoff uses the correct value.
    const attempts = useConnectionStore.getState().reconnectAttempts
    const delay = computeBackoff(attempts)
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) this.doConnect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  destroy(): void {
    this.destroyed = true
    this.clearReconnectTimer()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    useConnectionStore.getState().setStatus('disconnected')
  }
}

// ---------------------------------------------------------------------------
// Aggregate-aware dispatch
// ---------------------------------------------------------------------------

function dispatchEnvelope(env: EventEnvelope): void {
  const p = env.payload as Record<string, unknown>

  switch (env.aggregate_type) {
    case 'orchestration':
    case 'task':
      dispatchAgentEvent(env, p)
      break
    case 'sprint':
      dispatchSprintEvent(env, p)
      break
    case 'channel_post':
      dispatchChannelPostEvent(env, p)
      break
    case 'ceremony':
      dispatchCeremonyEvent(env, p)
      break
    case 'vision_document':
      dispatchVisionEvent(env, p)
      break
    default:
      // No store-side dispatch needed; events store has it.
      break
  }
}

function dispatchAgentEvent(env: EventEnvelope, p: Record<string, unknown>): void {
  const workerId = String(p['worker_id'] ?? '')
  if (!workerId) return

  const workers = useWorkersStore.getState()

  if (env.event_type === 'WorkerOutputLine') {
    const stream = p['stream']
    const lineText = p['line']
    const lineSeq = Number(p['line_seq'] ?? 0)
    if (
      (stream === 'stdout' || stream === 'stderr') &&
      typeof lineText === 'string' &&
      Number.isFinite(lineSeq)
    ) {
      const line: WorkerOutputLineView = {
        lineSeq,
        stream,
        line: lineText,
        occurredAt: env.occurred_at,
      }
      workers.appendOutputLine(workerId, line)
    }
    return
  }

  if (env.event_type === 'AgentSpawned' || env.event_type === 'AgentHeartbeat') {
    const view: WorkerView = {
      workerId,
      taskId: (p['task_id'] as string | undefined) ?? null,
      personaRole: (p['persona_role'] as string | undefined) ?? null,
      model: (p['model'] as string | undefined) ?? null,
      status: (p['status'] as WorkerView['status']) ?? 'active',
      startedAt: (p['started_at'] as string | undefined) ?? env.occurred_at,
      lastHeartbeatAt:
        env.event_type === 'AgentHeartbeat' ? env.occurred_at : null,
      currentFile: (p['current_file'] as string | undefined) ?? null,
    }
    workers.upsertWorker(view)
    return
  }
  if (
    env.event_type === 'AgentCompleted' ||
    env.event_type === 'AgentTimedOut' ||
    env.event_type === 'AgentFailed' ||
    env.event_type === 'AgentTerminated'
  ) {
    workers.removeWorker(workerId)
  }
}

function dispatchSprintEvent(env: EventEnvelope, p: Record<string, unknown>): void {
  const sprintId = String(p['sprint_id'] ?? env.aggregate_id)
  if (!sprintId) return

  const sprints = useSprintsStore.getState()
  const name = (p['name'] as string | undefined) ?? 'Sprint'

  if (env.event_type === 'SprintStarted') {
    sprints.upsertSprint({
      id: sprintId,
      name,
      status: 'active',
      startedAt: (p['started_at'] as string | undefined) ?? env.occurred_at,
      completedAt: null,
    })
    return
  }
  if (env.event_type === 'SprintCompleted') {
    sprints.upsertSprint({
      id: sprintId,
      name,
      status: 'completed',
      startedAt: null,
      completedAt: (p['completed_at'] as string | undefined) ?? env.occurred_at,
    })
    return
  }
  if (env.event_type === 'SprintPaused' || env.event_type === 'SprintResumed') {
    sprints.upsertSprint({
      id: sprintId,
      name,
      status: env.event_type === 'SprintResumed' ? 'active' : 'completing',
      startedAt: null,
      completedAt: null,
    })
  }
}

function dispatchChannelPostEvent(env: EventEnvelope, p: Record<string, unknown>): void {
  if (env.event_type !== 'ChannelPosted') return

  const channelId = String(p['channel_id'] ?? '')
  const postId = String(p['post_id'] ?? env.aggregate_id)
  if (!channelId || !postId) return

  const author =
    (env.actor as { type?: string; persona_role?: string; user_id?: string }) ?? {}
  const authorKind: ChannelPost['authorKind'] =
    author.type === 'persona'
      ? 'persona'
      : author.type === 'user'
        ? 'user'
        : author.type === 'hook'
          ? 'hook'
          : 'system'
  const authorName = author.persona_role ?? author.user_id ?? 'system'

  const post: ChannelPost = {
    id: postId,
    channelId,
    authorName,
    authorKind,
    postType: (p['post_type'] as ChannelPost['postType']) ?? 'system_event',
    body: extractPostBody(p),
    occurredAt: env.occurred_at,
  }

  useChannelsStore.getState().appendPost(channelId, post)
}

function extractPostBody(p: Record<string, unknown>): string {
  const payload = p['payload']
  if (payload && typeof payload === 'object') {
    const body = (payload as Record<string, unknown>)['body']
    if (typeof body === 'string') return body
  }
  if (typeof p['body'] === 'string') return p['body'] as string
  return ''
}

function dispatchCeremonyEvent(env: EventEnvelope, p: Record<string, unknown>): void {
  const ceremonies = useCeremoniesStore.getState()
  const ceremonyId = String(p['ceremony_id'] ?? env.aggregate_id)
  if (!ceremonyId) return

  if (env.event_type === 'CeremonyOpened') {
    ceremonies.setActive({
      ceremonyId,
      kind: String(p['kind'] ?? 'unknown'),
      title: String(p['title'] ?? 'Ceremony'),
      startedAt: env.occurred_at,
      participants: ((p['participants'] as Array<Record<string, unknown>>) ?? []).map((part) => ({
        personaRole: String(part['persona_role'] ?? ''),
        tokensConsumed: Number(part['tokens_consumed'] ?? 0),
        tokensRemaining: Number(part['tokens_remaining'] ?? 0),
        isCurrentTurn: Boolean(part['is_current_turn'] ?? false),
      })),
      statements: [],
      output: null,
      closedAt: null,
    })
    return
  }
  if (env.event_type === 'CeremonyTurnTaken') {
    ceremonies.appendStatement({
      statementId: String(p['statement_id'] ?? env.event_id),
      personaRole: String(p['persona_role'] ?? ''),
      body: String(p['body'] ?? ''),
      occurredAt: env.occurred_at,
    })
    return
  }
  if (env.event_type === 'CeremonyClosed') {
    const current = ceremonies.active
    if (current && current.ceremonyId === ceremonyId) {
      ceremonies.setActive({
        ...current,
        closedAt: env.occurred_at,
        output: (p['output'] as Record<string, unknown> | undefined) ?? null,
      })
    }
  }
}

function dispatchVisionEvent(env: EventEnvelope, p: Record<string, unknown>): void {
  const vision = useVisionStore.getState()
  // Handle VisionMessageSent (the event type actually emitted by the orchestrator).
  // Previously this checked for 'VisionMessagePosted' which was never emitted.
  if (env.event_type === 'VisionMessageSent') {
    const authorType = String(p['author_type'] ?? '')
    const sessionId = String(p['vision_session_id'] ?? '')

    // Only append to the store if this message belongs to the active session.
    const currentSessionId = vision.currentSessionId
    if (currentSessionId && sessionId !== currentSessionId) return

    const msg: VisionMessage = {
      visionMessageId: String(p['vision_message_id'] ?? env.event_id),
      // Use payload author_type directly — actor.type is always 'persona' for PM
      // stub replies but the payload field distinguishes 'user' vs 'pm_persona'.
      authorRole: authorType === 'user' ? 'user' : 'pm_persona',
      body: String(p['body'] ?? ''),
      postedAt: env.occurred_at,
    }
    // De-duplicate: don't append if already present (e.g. user's own optimistic msg).
    const existing = vision.messages.find((m) => m.visionMessageId === msg.visionMessageId)
    if (!existing) {
      vision.appendMessage(msg)
    }
  }
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/**
 * Build the WS URL for this build. Resolution order:
 *   1. VITE_WS_URL — explicit absolute URL (e.g. wss://abc.execute-api...)
 *      The build pipeline injects this for AWS deployments.
 *   2. Same-origin /ws — local-first deploys where the orchestrator serves
 *      the UI and a same-origin WebSocket on the same port.
 *
 * Returns null when there is neither a configured URL nor a usable origin
 * (e.g. SSR or test). Callers must treat null as "WS disabled for this build".
 */
function buildWsUrl(cursor: string | null): string | null {
  const env = (import.meta as ImportMeta & {
    env?: Record<string, string | undefined>
  }).env

  const fromEnv = env?.['VITE_WS_URL']
  const cursorParam = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''

  if (fromEnv && fromEnv.length > 0) {
    const base = fromEnv.replace(/\/$/, '')
    // Allow either an exact endpoint (wss://host/ws) or a host root (wss://host).
    const withPath = base.endsWith('/ws') ? base : `${base}/ws`
    return `${withPath}${cursorParam}`
  }

  if (typeof window === 'undefined' || !window.location?.host) return null
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws${cursorParam}`
}

// ---------------------------------------------------------------------------
// Public lifecycle
// ---------------------------------------------------------------------------

let globalClient: WebSocketClient | null = null

/** Call once on app mount. Returns a cleanup function. */
export function initWebSocket(): () => void {
  if (globalClient) globalClient.destroy()
  globalClient = new WebSocketClient()
  globalClient.connect()
  return () => {
    globalClient?.destroy()
    globalClient = null
  }
}
