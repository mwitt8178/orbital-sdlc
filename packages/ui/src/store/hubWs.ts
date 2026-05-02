/**
 * store/hubWs.ts — Zustand store for hub WS connection + subscriptions.
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * This store manages:
 *   - Hub WS connection lifecycle (connecting/connected/reconnecting/disconnected)
 *   - Subscription registry: pattern → Set<handler>
 *   - Dispatch of incoming WS events to registered handlers
 *   - Connection timestamps for OfflineBanner (downSince when disconnected)
 *
 * The actual WebSocket is held in a module-level singleton (_ws). The store
 * records the observable state; component-level hooks read from the store.
 *
 * Connection is initialized by HubWsProvider (App.tsx) on mount when
 * VITE_HUB_WS_URL is configured. The provider reads window.__ORBITAL_CONFIG__
 * which the orchestrator injects at startup, or falls back to the Vite env var.
 *
 * Reconnect strategy:
 *   - Exponential backoff: 1s → 2s → 4s → max 30s.
 *   - On reconnect: re-subscribe all patterns with last_seen_event_id cursor.
 *   - On connect: clear downSince, set status='connected'.
 *   - After >60s disconnected: status becomes 'down' which triggers OfflineBanner.
 */

import { create } from 'zustand'
import type { HubSubscriptionEvent, HubEventHandler } from '../hooks/useHubSubscription.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HubWsStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export interface HubWsState {
  status: HubWsStatus
  /** ISO timestamp of last successful connect. Null on first boot. */
  lastConnectedAt: string | null
  /** ISO timestamp of when the connection went down. Null when connected. */
  downSince: string | null
  /** Whether we're in a 'down for >60s' state — triggers OfflineBanner. */
  isDown: boolean
  /** Current last_seen_event_id — backfill cursor on reconnect. */
  lastSeenEventId: string | null

  // Actions (not private — Zustand state)
  setStatus: (s: HubWsStatus) => void
  markConnected: () => void
  markDisconnected: () => void
  markReconnecting: () => void
  setLastSeenEventId: (id: string) => void
  setIsDown: (v: boolean) => void

  /**
   * Subscribe a handler to a pattern. Returns an unsubscribe function.
   * The WS subscribe message is sent if already connected.
   */
  subscribe: (pattern: string, handler: HubEventHandler) => void

  /**
   * Unsubscribe a specific handler from a pattern. If no handlers remain,
   * sends an unsubscribe message to the hub.
   */
  unsubscribe: (pattern: string, handler: HubEventHandler) => void

  /**
   * Dispatch an incoming WS event to all matching handlers.
   * Called by the WS message listener.
   */
  dispatch: (event: HubSubscriptionEvent) => void

  /**
   * Get the current subscription patterns (for re-subscribe on reconnect).
   */
  getPatterns: () => string[]
}

// ---------------------------------------------------------------------------
// Module-level subscription registry (not in Zustand — too frequent to
// cause renders on every subscribe/unsubscribe in deeply nested trees)
// ---------------------------------------------------------------------------

const _handlers = new Map<string, Set<HubEventHandler>>()

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useHubWsStore = create<HubWsState>((set, get) => ({
  status: 'idle',
  lastConnectedAt: null,
  downSince: null,
  isDown: false,
  lastSeenEventId: null,

  setStatus: (s) => set({ status: s }),

  markConnected: () =>
    set({
      status: 'connected',
      lastConnectedAt: new Date().toISOString(),
      downSince: null,
      isDown: false,
    }),

  markDisconnected: () =>
    set((prev) => ({
      status: 'disconnected',
      downSince: prev.downSince ?? new Date().toISOString(),
    })),

  markReconnecting: () =>
    set((prev) => ({
      status: 'reconnecting',
      downSince: prev.downSince ?? new Date().toISOString(),
    })),

  setLastSeenEventId: (id) => set({ lastSeenEventId: id }),

  setIsDown: (v) => set({ isDown: v }),

  subscribe: (pattern, handler) => {
    let handlers = _handlers.get(pattern)
    if (!handlers) {
      handlers = new Set()
      _handlers.set(pattern, handlers)
      // Send subscribe message if connected
      if (get().status === 'connected') {
        sendWsSubscribe([pattern], get().lastSeenEventId)
      }
    }
    handlers.add(handler)
  },

  unsubscribe: (pattern, handler) => {
    const handlers = _handlers.get(pattern)
    if (!handlers) return
    handlers.delete(handler)
    if (handlers.size === 0) {
      _handlers.delete(pattern)
      if (get().status === 'connected') {
        sendWsUnsubscribe([pattern])
      }
    }
  },

  dispatch: (event) => {
    for (const [pattern, handlers] of _handlers) {
      if (clientPatternMatchesEvent(pattern, event)) {
        for (const handler of handlers) {
          try { handler(event) } catch { /* ignore handler throws */ }
        }
      }
    }
    // Track last seen event id for backfill cursor
    if (event.event_id) {
      set({ lastSeenEventId: event.event_id })
    }
  },

  getPatterns: () => Array.from(_handlers.keys()),
}))

// ---------------------------------------------------------------------------
// WebSocket singleton
// ---------------------------------------------------------------------------

let _ws: WebSocket | null = null
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null
let _reconnectDelayMs = 1_000
let _stopped = false
let _downTimer: ReturnType<typeof setTimeout> | null = null
const MAX_RECONNECT_MS = 30_000
const DOWN_THRESHOLD_MS = 60_000

/**
 * Initialize the hub WS connection. Called once by HubWsProvider.
 * @param hubWsUrl  Hub WS base URL (wss://... or ws://...)
 */
export function initHubWs(hubWsUrl: string): void {
  _stopped = false
  _reconnectDelayMs = 1_000
  connectHubWs(hubWsUrl)
}

/**
 * Stop the hub WS connection (called on unmount or hub config cleared).
 */
export function stopHubWs(): void {
  _stopped = true
  if (_reconnectTimer !== null) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
  if (_downTimer !== null) { clearTimeout(_downTimer); _downTimer = null }
  if (_ws) { try { _ws.close() } catch { /* ignore */ } _ws = null }
  useHubWsStore.getState().setStatus('idle')
}

function connectHubWs(hubWsUrl: string): void {
  if (_stopped) return

  const { markConnected, markDisconnected, markReconnecting, dispatch, getPatterns, lastSeenEventId } =
    useHubWsStore.getState()

  markReconnecting()

  // Build URL with signed envelope params
  buildAuthenticatedWsUrl(hubWsUrl).then((url) => {
    if (_stopped) return

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect(hubWsUrl)
      return
    }
    _ws = ws

    ws.addEventListener('open', () => {
      _reconnectDelayMs = 1_000
      markConnected()
      clearDownTimer()

      // Re-subscribe all patterns with backfill cursor
      const patterns = getPatterns()
      if (patterns.length > 0) {
        const cursor = useHubWsStore.getState().lastSeenEventId
        sendWsSubscribe(patterns, cursor)
      }
    })

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as Record<string, unknown>
        if (msg['ws_type'] === 'event') {
          const payload = msg['payload'] as Record<string, unknown>
          const cursor = msg['cursor']
          const event: HubSubscriptionEvent = {
            event_id: String(payload['event_id'] ?? ''),
            event_type: String(payload['event_type'] ?? ''),
            aggregate_type: String(payload['aggregate_type'] ?? ''),
            aggregate_id: String(payload['aggregate_id'] ?? ''),
            payload: (payload['payload'] as Record<string, unknown>) ?? {},
            occurred_at: String(payload['occurred_at'] ?? new Date().toISOString()),
            tenant_id: payload['tenant_id'] as string | undefined,
          }
          if (typeof cursor === 'string') {
            useHubWsStore.getState().setLastSeenEventId(cursor)
          }
          dispatch(event)
        }
      } catch {
        // ignore parse errors
      }
    })

    ws.addEventListener('close', () => {
      _ws = null
      if (!_stopped) {
        markDisconnected()
        startDownTimer()
        scheduleReconnect(hubWsUrl)
      }
    })

    ws.addEventListener('error', () => {
      // handled by close
    })
  }).catch(() => {
    scheduleReconnect(hubWsUrl)
  })
}

function scheduleReconnect(hubWsUrl: string): void {
  if (_stopped) return
  const delay = _reconnectDelayMs
  _reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_MS)
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null
    connectHubWs(hubWsUrl)
  }, delay)
}

function startDownTimer(): void {
  clearDownTimer()
  _downTimer = setTimeout(() => {
    useHubWsStore.getState().setIsDown(true)
  }, DOWN_THRESHOLD_MS)
}

function clearDownTimer(): void {
  if (_downTimer !== null) { clearTimeout(_downTimer); _downTimer = null }
  useHubWsStore.getState().setIsDown(false)
}

// ---------------------------------------------------------------------------
// WS message senders
// ---------------------------------------------------------------------------

function sendWsSubscribe(patterns: string[], cursor: string | null): void {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return
  const msg: Record<string, unknown> = { type: 'subscribe', patterns }
  if (cursor) msg['cursor'] = cursor
  try { _ws.send(JSON.stringify(msg)) } catch { /* ignore */ }
}

function sendWsUnsubscribe(patterns: string[]): void {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return
  try { _ws.send(JSON.stringify({ type: 'unsubscribe', patterns })) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Auth URL builder (browser-side)
// ---------------------------------------------------------------------------

/**
 * Build an authenticated WS URL for the browser client.
 *
 * In the browser, we can't sign with the server-side install key.
 * The browser session uses a short-lived token issued by the hub at login
 * (stored in the hub store). We pass it as a Bearer token in the sig_body
 * field so the hub can identify the session.
 *
 * For operator UI clients (the full Orbital UI running on the operator's
 * machine where the local orchestrator is available), we can fetch a
 * pre-signed WS token from the local orchestrator.
 *
 * This function tries:
 *   1. window.__ORBITAL_HUB_WS_TOKEN__ — injected by the local orchestrator.
 *   2. Falls back to connecting without auth params (development mode).
 *
 * Production note: the local orchestrator (running on the operator's laptop)
 * generates a short-lived WS token signed with the install key and injects
 * it into the page via window.__ORBITAL_CONFIG__. This is the canonical auth
 * path for hub-mode UI clients.
 */
async function buildAuthenticatedWsUrl(hubWsUrl: string): Promise<string> {
  const base = hubWsUrl.replace(/\/$/, '')
  const params = new URLSearchParams()

  // Attempt to pick up pre-signed params from the orchestrator-injected config
  const config = (
    typeof window !== 'undefined'
      ? (window as unknown as Record<string, unknown>)['__ORBITAL_HUB_WS_TOKEN__']
      : null
  ) as Record<string, string> | null | undefined

  if (config?.['install_id'] && config?.['sig'] && config?.['sig_body']) {
    params.set('install_id', config['install_id'])
    params.set('sig', config['sig'])
    params.set('sig_body', config['sig_body'])
  }

  const cursor = useHubWsStore.getState().lastSeenEventId
  if (cursor) params.set('cursor', cursor)

  const qs = params.toString()
  return qs ? `${base}/ws?${qs}` : `${base}/ws`
}

// ---------------------------------------------------------------------------
// Client-side pattern matcher
// ---------------------------------------------------------------------------

function clientPatternMatchesEvent(
  pattern: string,
  event: HubSubscriptionEvent,
): boolean {
  const payload = event.payload

  if (pattern.startsWith('task:')) {
    const id = pattern.slice('task:'.length)
    return event.aggregate_id === id || payload['task_id'] === id
  }
  if (pattern.startsWith('channel:')) {
    const name = pattern.slice('channel:'.length)
    return (
      (event.aggregate_type === 'channel' || event.aggregate_type === 'channel_post') &&
      (payload['channel_name'] === name ||
        payload['channel_id'] === name ||
        event.aggregate_id === name)
    )
  }
  if (pattern.startsWith('project:') && pattern.endsWith(':events')) {
    const id = pattern.slice('project:'.length, -':events'.length)
    return event.aggregate_id === id || payload['project_id'] === id
  }
  if (pattern === 'worker:*') {
    return event.aggregate_type === 'orchestration'
  }
  if (pattern.startsWith('worker:') && pattern.endsWith(':*')) {
    const installId = pattern.slice('worker:'.length, -':*'.length)
    if (!installId) return false
    return (
      event.aggregate_type === 'orchestration' &&
      (payload['install_id'] === installId ||
        (event.payload as unknown as Record<string, unknown>)['actor_install_id'] === installId)
    )
  }
  if (pattern === 'team:presence') {
    return event.aggregate_type === 'presence' || event.event_type === 'PresenceUpdated'
  }
  return event.aggregate_id === pattern
}
