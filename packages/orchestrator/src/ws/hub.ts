/**
 * ws/hub.ts — WebSocketHub (local mode) + HubModeWebSocketHub (hub mode).
 *
 * Per TRD-05 §6.1.3 (channel.posts.subscribe), Primitives §11 (WSMessage
 * envelope).
 *
 * Architecture (local mode — WebSocketHub):
 *   - Single hub per process; multiple UI WS clients connected.
 *   - Hub registers ONE handler with EventStore.subscribe(cursor, handler).
 *   - On every event, hub filters by aggregate_type ∈ {channel, channel_post,
 *     ceremony, disagreement, adr, task} and per-connection subscribed
 *     channelIds set.
 *   - Sends WSMessage envelopes with ws_type='event'.
 *   - Per-connection backpressure buffer cap = 1000 envelopes (TRD-05 §6.1.3).
 *     On overflow, send ws_type='error' with code='BUFFER_TRUNCATED' and drop.
 *
 * Architecture (hub mode — HubModeWebSocketHub):
 *   Round 7-04 — Real-Time Push From Hub To Clients
 *   [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 *   - Accept WS connections from AUTHENTICATED clients (envelope auth via
 *     query-string on upgrade — see ws/auth.ts).
 *   - Each connection carries {installId, tenantId} injected at handshake.
 *   - Per-connection SubscriptionRegistry (ws/subscriptions.ts) holds the
 *     set of patterns the client subscribed to.
 *   - On every appended event, fan out to all connections whose
 *     (a) tenantId matches AND (b) at least one pattern matches.
 *   - On reconnect with cursor param, backfill missed events via EventStore.query.
 *
 * // Round 7-04 fanout — section for ws/hub.ts post-append hook
 * The HubModeWebSocketHub.fanOut() is called AFTER the local EventStore commit
 * and AFTER the 7-05 sanitize layer (run order: store.append → sanitize →
 * fanOut). The 7-05 pre-emit sanitize guard runs first; we only see events that
 * have already been cleared for hub emission.
 *
 * The hub does NOT depend on Fastify directly. The Fastify @fastify/websocket
 * plugin (server.ts) calls hub.handleConnection(socket, identity) for each
 * authenticated client.
 */

import { uuidv7 } from 'uuidv7'
import type { WebSocket } from 'ws'
import type { EventStore } from '../events/store.js'
import type { EventEnvelope, WSMessage } from '@orbital/types'
import { logger } from '../config/logger.js'
import { SubscriptionRegistry, matchesEvent } from './subscriptions.js'
import type { InstallIdentity } from '../hub/auth/known-installs.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HubOptions {
  /** Per-connection outbound queue cap. Default 1000. */
  perConnQueueCap?: number
  /** Initial cursor for the hub's underlying EventStore.subscribe. */
  cursor?: string | null
}

export interface WSHub {
  start(): Promise<void>
  stop(): Promise<void>
  handleConnection(socket: WebSocket): void
  /** Test-only: number of connected clients. */
  connectedCount(): number
}

interface ConnectionState {
  id: string
  socket: WebSocket
  subscribedChannels: Set<string>
  /**
   * Round 6 #10 — inspection subscriptions.
   * The client sends a subscribe message with channel_ids containing:
   *   'inspection:active'             — gets all inspection events (grid refresh)
   *   'inspection:worker:<worker_id>' — gets events for a specific worker (drawer)
   * [Engineer-Sr · Sonnet · run-round6-10-inspection]
   */
  subscribedInspection: Set<string>
  /** Outbound queue. Drained by writeLoop. */
  outbound: WSMessage[]
  cursor: string | null
  truncated: boolean
  /** Earliest event time the conn cares about (events older than this are ignored). */
  openedAtMs: number
}

// Aggregate types we propagate.
const PROPAGATED_AGGREGATE_TYPES = new Set<string>([
  'channel',
  'channel_post',
  'ceremony',
  'disagreement',
  'adr',
  'task',
  'vision_document',
  // Round5B — agent worker lifecycle and live output stream so the dashboard
  // sees AgentSpawned, AgentHeartbeat, WorkerOutputLine, AgentTimedOut, etc.
  // The UI ws.ts already routes these via dispatchAgentEvent.
  'orchestration',
])

// Round 6 #10 — inspection event types that the WS hub fans out to subscribed
// clients. These arrive as aggregate_type='orchestration' events above, but we
// also maintain an explicit set for documentation and future filtering.
// The client subscribes to 'inspection:active' or 'inspection:worker:<id>'
// to receive these.
//
// Event types propagated:
//   ToolCallStarted, ToolCallCompleted
//   LLMRequestStarted, LLMRequestCompleted
//   SkillLoaded
//   WorkerLifecyclePhase
//   WorkerKilledByOperator
//
// All are aggregate_type='orchestration' so they flow through the existing
// PROPAGATED_AGGREGATE_TYPES set without needing an additional allowlist.
// [Engineer-Sr · Sonnet · run-round6-10-inspection]
const INSPECTION_EVENT_TYPES = new Set<string>([
  'ToolCallStarted',
  'ToolCallCompleted',
  'LLMRequestStarted',
  'LLMRequestCompleted',
  'SkillLoaded',
  'WorkerLifecyclePhase',
  'WorkerKilledByOperator',
])

const DEFAULT_PER_CONN_QUEUE_CAP = 1000

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class WebSocketHub implements WSHub {
  private readonly perConnCap: number
  private readonly initialCursor: string | null
  private connections = new Map<string, ConnectionState>()
  private storeUnsubscribe: (() => void) | null = null

  constructor(
    private readonly eventStore: EventStore,
    options: HubOptions = {},
  ) {
    this.perConnCap = options.perConnQueueCap ?? DEFAULT_PER_CONN_QUEUE_CAP
    this.initialCursor = options.cursor ?? null
  }

  async start(): Promise<void> {
    if (this.storeUnsubscribe) return
    this.storeUnsubscribe = this.eventStore.subscribe(this.initialCursor, (event) => {
      this.fanOut(event)
    })
    logger.info('WebSocketHub: started')
  }

  async stop(): Promise<void> {
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe()
      this.storeUnsubscribe = null
    }
    for (const conn of this.connections.values()) {
      try {
        conn.socket.close()
      } catch {
        // ignore
      }
    }
    this.connections.clear()
    logger.info('WebSocketHub: stopped')
  }

  connectedCount(): number {
    return this.connections.size
  }

  // -------------------------------------------------------------------------
  // handleConnection — called by Fastify ws plugin on upgrade
  // -------------------------------------------------------------------------

  handleConnection(socket: WebSocket): void {
    const id = uuidv7()
    const state: ConnectionState = {
      id,
      socket,
      subscribedChannels: new Set(),
      subscribedInspection: new Set(),
      outbound: [],
      cursor: null,
      truncated: false,
      openedAtMs: Date.now(),
    }

    this.connections.set(id, state)

    // Send hello/ack as soon as we can. We use a setImmediate (next event-loop
    // tick) so the upgrade handshake has fully settled and the client's
    // 'open' event fires before our first frame arrives.
    setImmediate(() => {
      try {
        socket.send(
          JSON.stringify({
            ws_message_id: uuidv7(),
            ws_type: 'ack',
            payload: { connected: true, conn_id: id },
            trace_id: uuidv7(),
          }),
        )
      } catch {
        // ignore send failure; connection will close shortly
      }
    })

    logger.debug({ connId: id }, 'WebSocketHub: connection opened')

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        this.handleClientMessage(state, msg)
      } catch (err) {
        logger.warn({ err, connId: id }, 'WebSocketHub: malformed message')
        this.sendError(state, 'INVALID_REQUEST', 'malformed message', uuidv7())
      }
    })

    socket.on('close', () => {
      this.connections.delete(id)
      logger.debug({ connId: id }, 'WebSocketHub: connection closed')
    })

    socket.on('error', (err) => {
      logger.warn({ err, connId: id }, 'WebSocketHub: socket error')
    })

  }

  // -------------------------------------------------------------------------
  // Per-connection handlers
  // -------------------------------------------------------------------------

  private handleClientMessage(state: ConnectionState, msg: Record<string, unknown>): void {
    const type = msg['type'] ?? msg['ws_type']

    if (type === 'subscribe') {
      const channelIds = msg['channel_ids']
      if (!Array.isArray(channelIds)) {
        this.sendError(state, 'VALIDATION_INVALID_REQUEST', 'channel_ids required', uuidv7())
        return
      }
      for (const c of channelIds) {
        if (typeof c === 'string') {
          // Round 6 #10: inspection subscriptions are prefixed with 'inspection:'
          if (c.startsWith('inspection:')) {
            state.subscribedInspection.add(c)
          } else {
            state.subscribedChannels.add(c)
          }
        }
      }
      const cursor = msg['cursor']
      if (typeof cursor === 'string') state.cursor = cursor
      this.send(state, {
        ws_message_id: uuidv7(),
        ws_type: 'ack',
        payload: {
          subscribed: Array.from(state.subscribedChannels),
          subscribed_inspection: Array.from(state.subscribedInspection),
        },
        trace_id: uuidv7(),
      })
      return
    }

    if (type === 'unsubscribe') {
      const channelIds = msg['channel_ids']
      if (!Array.isArray(channelIds)) {
        this.sendError(state, 'VALIDATION_INVALID_REQUEST', 'channel_ids required', uuidv7())
        return
      }
      for (const c of channelIds) {
        if (typeof c === 'string') {
          if (c.startsWith('inspection:')) {
            state.subscribedInspection.delete(c)
          } else {
            state.subscribedChannels.delete(c)
          }
        }
      }
      this.send(state, {
        ws_message_id: uuidv7(),
        ws_type: 'ack',
        payload: { unsubscribed: channelIds },
        trace_id: uuidv7(),
      })
      return
    }

    if (type === 'ping') {
      this.send(state, {
        ws_message_id: uuidv7(),
        ws_type: 'pong',
        payload: { server_time: new Date().toISOString() },
        trace_id: uuidv7(),
      })
      return
    }

    this.sendError(state, 'METHOD_NOT_FOUND', `unknown ws message type '${type}'`, uuidv7())
  }

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  private fanOut(event: EventEnvelope): void {
    if (!PROPAGATED_AGGREGATE_TYPES.has(event.aggregate_type)) return

    // Determine the channel id (if applicable) for filter matching.
    const channelId = inferChannelId(event)
    const eventMs = Date.parse(event.occurred_at)

    // Round 6 #10: determine if this is an inspection event.
    // Inspection events are aggregate_type='orchestration' with a recognised
    // event_type. They may be routed to both channel subscriptions AND
    // inspection subscriptions.
    const isInspectionEvent = INSPECTION_EVENT_TYPES.has(event.event_type)
    const inspectionWorkerId = isInspectionEvent
      ? ((event.payload as Record<string, unknown>)['worker_id'] as string | undefined)
      : undefined

    for (const conn of this.connections.values()) {
      // Skip events that occurred before this connection opened (unless the
      // client explicitly set a cursor).
      if (!conn.cursor && Number.isFinite(eventMs) && eventMs < conn.openedAtMs) {
        continue
      }

      // Build envelope (shared across channel + inspection paths).
      const envelope: WSMessage = {
        ws_message_id: uuidv7(),
        ws_type: 'event',
        cursor: event.event_id,
        payload: {
          event_id: event.event_id,
          event_type: event.event_type,
          aggregate_type: event.aggregate_type,
          aggregate_id: event.aggregate_id,
          payload: event.payload,
          actor: event.actor as unknown as Record<string, unknown>,
          occurred_at: event.occurred_at,
        },
        trace_id: event.trace_id,
      }

      // --- Round 6 #10: inspection subscription routing ---
      // If the event is an inspection event AND the connection has subscribed
      // to inspection:active or inspection:worker:<workerId>, send it.
      if (isInspectionEvent && conn.subscribedInspection.size > 0) {
        const wantsActive = conn.subscribedInspection.has('inspection:active')
        const wantsWorker = inspectionWorkerId
          ? conn.subscribedInspection.has(`inspection:worker:${inspectionWorkerId}`)
          : false
        if (wantsActive || wantsWorker) {
          this.send(conn, envelope)
          continue  // don't double-send via the channel path below
        }
      }

      // --- Standard channel subscription routing ---
      // Subscription filter: if the conn has subscribed channels, the event
      // must be relevant to one. Connections with empty subscribedChannels
      // see ALL events — useful for admin dashboards but optional.
      if (conn.subscribedChannels.size > 0) {
        if (!channelId || !conn.subscribedChannels.has(channelId)) continue
      }

      this.send(conn, envelope)
    }
  }

  // -------------------------------------------------------------------------
  // Outbound write helpers
  // -------------------------------------------------------------------------

  private send(state: ConnectionState, msg: WSMessage): void {
    if (state.socket.readyState !== state.socket.OPEN) return

    if (state.outbound.length >= this.perConnCap) {
      // Drop and emit a single BUFFER_TRUNCATED.
      if (!state.truncated) {
        state.truncated = true
        const err: WSMessage = {
          ws_message_id: uuidv7(),
          ws_type: 'error',
          payload: {
            code: 'BUFFER_TRUNCATED',
            message: 'WS outbound buffer overflow; client must resync via channel.posts.read',
          },
          trace_id: uuidv7(),
        }
        try {
          state.socket.send(JSON.stringify(err))
        } catch {
          // ignore
        }
      }
      return
    }

    try {
      state.socket.send(JSON.stringify(msg))
      // After a successful send, clear the truncated flag if the queue is
      // re-drained.
      if (state.truncated && state.outbound.length === 0) {
        state.truncated = false
      }
    } catch (err) {
      logger.warn({ err, connId: state.id }, 'WebSocketHub: send failed')
    }
  }

  private sendError(
    state: ConnectionState,
    code: string,
    message: string,
    traceId: string,
  ): void {
    this.send(state, {
      ws_message_id: uuidv7(),
      ws_type: 'error',
      payload: { code, message },
      trace_id: traceId,
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferChannelId(event: EventEnvelope): string | null {
  // For channel/channel_post events, the payload usually carries channel_id.
  const payload = event.payload as Record<string, unknown>
  const direct = payload['channel_id']
  if (typeof direct === 'string') return direct

  // For ceremony events, aggregate_id is the ceremony_id; we don't know the
  // channel without a join. UIs typically subscribe by channel id, so unless
  // the ceremony channel id is included in the event payload we fall through.
  return null
}

// ===========================================================================
// Round 7-04 — Hub-Mode WebSocket Hub
// [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
//
// HubModeWebSocketHub: accepts authenticated WS connections from local
// Orbital installs and from the browser UI (via ws-client.ts). Each
// connection must present a signed envelope on the WS upgrade; the identity
// is injected by registerHubModeWsRoutes before handleAuthenticatedConnection
// is called.
//
// Fan-out section (// Round 7-04 fanout):
//   After store.append(), the EventStore.subscribe() handler calls fanOut().
//   fanOut() iterates all hub-mode connections and delivers events where
//   (a) event.tenant_id === conn.tenantId and (b) a subscription pattern
//   matches. The 7-05 sanitize layer runs BEFORE this file sees the event
//   (store.append → [7-05 sanitize pre-emit] → [7-04 fanOut]).
// ===========================================================================

/** Per-connection state for the hub-mode hub. */
interface HubConnectionState {
  id: string
  socket: WebSocket
  /** From the WS handshake — injected by the Fastify route. */
  installId: string
  tenantId: string
  role: string
  /** Subscription patterns set. */
  subscriptions: SubscriptionRegistry
  /** Cursor for backfill — last event_id the client has seen. */
  cursor: string | null
  /** Opening timestamp for age-gating live events. */
  openedAtMs: number
  /** Outbound queue (mirrors local hub for backpressure). */
  outbound: WSMessage[]
  truncated: boolean
}

const HUB_DEFAULT_PER_CONN_CAP = 1000

export interface HubModeWSHub {
  start(): Promise<void>
  stop(): Promise<void>
  /** Called by the Fastify route after successful auth. */
  handleAuthenticatedConnection(socket: WebSocket, identity: InstallIdentity, cursor?: string): void
  connectedCount(): number
}

export class HubModeWebSocketHub implements HubModeWSHub {
  private readonly perConnCap: number
  private connections = new Map<string, HubConnectionState>()
  private storeUnsubscribe: (() => void) | null = null

  constructor(
    private readonly eventStore: EventStore,
    opts: { perConnQueueCap?: number } = {},
  ) {
    this.perConnCap = opts.perConnQueueCap ?? HUB_DEFAULT_PER_CONN_CAP
  }

  async start(): Promise<void> {
    if (this.storeUnsubscribe) return
    this.storeUnsubscribe = this.eventStore.subscribe(null, (event) => {
      // Round 7-04 fanout — runs after local commit and after 7-05 sanitize.
      this.fanOut(event)
    })
    logger.info('HubModeWebSocketHub: started')
  }

  async stop(): Promise<void> {
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe()
      this.storeUnsubscribe = null
    }
    for (const conn of this.connections.values()) {
      try { conn.socket.close() } catch { /* ignore */ }
    }
    this.connections.clear()
    logger.info('HubModeWebSocketHub: stopped')
  }

  connectedCount(): number {
    return this.connections.size
  }

  // -------------------------------------------------------------------------
  // handleAuthenticatedConnection — called by Fastify route after auth
  // -------------------------------------------------------------------------

  handleAuthenticatedConnection(
    socket: WebSocket,
    identity: InstallIdentity,
    cursor?: string,
  ): void {
    const id = uuidv7()
    const state: HubConnectionState = {
      id,
      socket,
      installId: identity.installId,
      tenantId: identity.tenantId,
      role: identity.role,
      subscriptions: new SubscriptionRegistry(),
      cursor: cursor ?? null,
      openedAtMs: Date.now(),
      outbound: [],
      truncated: false,
    }

    this.connections.set(id, state)

    // Note: backfill is intentionally NOT triggered here on cursor, because
    // the client has no subscription patterns yet. Backfill runs when the
    // client sends a subscribe message that includes a cursor field, at which
    // point patterns have been registered and the filter is meaningful.
    // This also prevents duplicate delivery (once on connect, once on subscribe).

    // Send hello ack on next tick.
    setImmediate(() => {
      try {
        socket.send(JSON.stringify({
          ws_message_id: uuidv7(),
          ws_type: 'ack',
          payload: { connected: true, conn_id: id, install_id: identity.installId, tenant_id: identity.tenantId },
          trace_id: uuidv7(),
        }))
      } catch { /* ignore */ }
    })

    logger.debug({ connId: id, installId: identity.installId, tenantId: identity.tenantId }, 'HubModeWebSocketHub: connection opened')

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        this.handleClientMessage(state, msg)
      } catch (err) {
        logger.warn({ err, connId: id }, 'HubModeWebSocketHub: malformed message')
        this.sendError(state, 'INVALID_REQUEST', 'malformed message', uuidv7())
      }
    })

    socket.on('close', () => {
      this.connections.delete(id)
      logger.debug({ connId: id }, 'HubModeWebSocketHub: connection closed')
    })

    socket.on('error', (err) => {
      logger.warn({ err, connId: id }, 'HubModeWebSocketHub: socket error')
    })
  }

  // -------------------------------------------------------------------------
  // Per-connection message handler
  // -------------------------------------------------------------------------

  private handleClientMessage(state: HubConnectionState, msg: Record<string, unknown>): void {
    const type = msg['type'] ?? msg['ws_type']

    if (type === 'subscribe') {
      const patterns = msg['patterns']
      if (!Array.isArray(patterns)) {
        this.sendError(state, 'VALIDATION_INVALID_REQUEST', 'patterns[] required', uuidv7())
        return
      }
      const cursor = msg['cursor']
      if (typeof cursor === 'string') state.cursor = cursor

      for (const p of patterns) {
        if (typeof p === 'string') state.subscriptions.add(p)
      }

      // If a cursor was supplied in the subscribe message, backfill.
      if (typeof cursor === 'string') {
        void this.backfill(state, cursor).catch((err) => {
          logger.warn({ err, connId: state.id }, 'HubModeWebSocketHub: subscribe backfill failed')
        })
      }

      this.sendMsg(state, {
        ws_message_id: uuidv7(),
        ws_type: 'ack',
        payload: { subscribed: state.subscriptions.toArray() },
        trace_id: uuidv7(),
      })
      return
    }

    if (type === 'unsubscribe') {
      const patterns = msg['patterns']
      if (!Array.isArray(patterns)) {
        this.sendError(state, 'VALIDATION_INVALID_REQUEST', 'patterns[] required', uuidv7())
        return
      }
      for (const p of patterns) {
        if (typeof p === 'string') state.subscriptions.remove(p)
      }
      this.sendMsg(state, {
        ws_message_id: uuidv7(),
        ws_type: 'ack',
        payload: { unsubscribed: patterns },
        trace_id: uuidv7(),
      })
      return
    }

    if (type === 'ping') {
      this.sendMsg(state, {
        ws_message_id: uuidv7(),
        ws_type: 'pong',
        payload: { server_time: new Date().toISOString() },
        trace_id: uuidv7(),
      })
      return
    }

    this.sendError(state, 'METHOD_NOT_FOUND', `unknown message type '${String(type)}'`, uuidv7())
  }

  // -------------------------------------------------------------------------
  // Round 7-04 fanout — called after store.append (post-sanitize)
  // -------------------------------------------------------------------------

  private fanOut(event: EventEnvelope): void {
    for (const conn of this.connections.values()) {
      // Skip events older than connection open time (unless cursor set)
      const eventMs = Date.parse(event.occurred_at)
      if (!conn.cursor && Number.isFinite(eventMs) && eventMs < conn.openedAtMs) continue

      // Tenant isolation + pattern matching (matchesEvent checks payload.tenant_id first)
      if (!matchesEvent(event, conn.tenantId, conn.subscriptions.toSet())) continue

      const envelope: WSMessage = {
        ws_message_id: uuidv7(),
        ws_type: 'event',
        cursor: event.event_id,
        payload: {
          event_id: event.event_id,
          event_type: event.event_type,
          aggregate_type: event.aggregate_type,
          aggregate_id: event.aggregate_id,
          payload: event.payload,
          actor: event.actor as unknown as Record<string, unknown>,
          occurred_at: event.occurred_at,
        },
        trace_id: event.trace_id,
      }

      this.sendMsg(conn, envelope)
    }
  }

  // -------------------------------------------------------------------------
  // Backfill on reconnect
  // -------------------------------------------------------------------------

  private async backfill(state: HubConnectionState, afterEventId: string): Promise<void> {
    // Query events newer than the cursor via EventStore.query.
    // tenant_id is not a DB column — matchesEvent() handles the isolation check
    // using payload.tenant_id. We fetch up to 500 events and filter client-side.
    const result = await this.eventStore.query({ limit: 500 })

    const patternSet = state.subscriptions.toSet()

    // Filter by (a) event_id > cursor, (b) tenant + pattern via matchesEvent
    const missed = result.items.filter((ev) => {
      if (ev.event_id <= afterEventId) return false
      // If no subscriptions yet, deliver nothing (client must subscribe first)
      if (patternSet.size === 0) return false
      return matchesEvent(ev, state.tenantId, patternSet)
    })

    // Deliver in ascending order (oldest first)
    for (const ev of missed.slice().reverse()) {
      this.sendMsg(state, {
        ws_message_id: uuidv7(),
        ws_type: 'event',
        cursor: ev.event_id,
        payload: {
          event_id: ev.event_id,
          event_type: ev.event_type,
          aggregate_type: ev.aggregate_type,
          aggregate_id: ev.aggregate_id,
          payload: ev.payload,
          actor: ev.actor as unknown as Record<string, unknown>,
          occurred_at: ev.occurred_at,
          backfilled: true,
        },
        trace_id: ev.trace_id,
      })
    }

    logger.debug(
      { connId: state.id, cursor: afterEventId, count: missed.length },
      'HubModeWebSocketHub: backfill delivered',
    )
  }

  // -------------------------------------------------------------------------
  // Outbound helpers
  // -------------------------------------------------------------------------

  private sendMsg(state: HubConnectionState, msg: WSMessage): void {
    if (state.socket.readyState !== state.socket.OPEN) return

    if (state.outbound.length >= this.perConnCap) {
      if (!state.truncated) {
        state.truncated = true
        try {
          state.socket.send(JSON.stringify({
            ws_message_id: uuidv7(),
            ws_type: 'error',
            payload: { code: 'BUFFER_TRUNCATED', message: 'WS outbound buffer overflow; resync' },
            trace_id: uuidv7(),
          }))
        } catch { /* ignore */ }
      }
      return
    }

    try {
      state.socket.send(JSON.stringify(msg))
      if (state.truncated && state.outbound.length === 0) state.truncated = false
    } catch (err) {
      logger.warn({ err, connId: state.id }, 'HubModeWebSocketHub: send failed')
    }
  }

  private sendError(state: HubConnectionState, code: string, message: string, traceId: string): void {
    this.sendMsg(state, {
      ws_message_id: uuidv7(),
      ws_type: 'error',
      payload: { code, message },
      trace_id: traceId,
    })
  }
}
