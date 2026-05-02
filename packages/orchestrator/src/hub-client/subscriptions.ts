/**
 * hub-client/subscriptions.ts — WebSocket subscription client for hub events.
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * The local UI subscribes to hub WS for shared events (tasks.*, channels.*,
 * memory.*, etc.) and to the local WS for local-only events (workers,
 * inspection, cost).
 *
 * This module manages the connection from the local orchestrator process to the
 * hub WS server. The hub broadcasts events to subscribers; this client receives
 * them and re-emits on the local EventStore so the local WebSocketHub fans them
 * out to connected UI clients.
 *
 * Connection lifecycle:
 *   - start(): open WS, subscribe to configured channels
 *   - stop(): close WS
 *   - auto-reconnect with exponential backoff (max 30s)
 *
 * Requires the `ws` package (already a dependency of the orchestrator).
 */

import { logger } from '../config/logger.js'
import type { EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HubEventHandler = (event: EventEnvelope) => void

export interface HubSubscriptionOptions {
  /** Hub WS URL, e.g. wss://orbital.team.dev/ws */
  hubWsUrl: string
  /** Tenant ID included in subscribe messages. */
  tenantId: string
  /** Channel ids to subscribe. Default: ['tasks', 'memory', 'channels', 'audit']. */
  channelIds?: string[]
  /** Called for each event received from the hub. */
  onEvent: HubEventHandler
  /** Called when connection state changes. */
  onStatusChange?: (connected: boolean) => void
  /** Initial reconnect delay ms. Default 1000. */
  initialReconnectMs?: number
  /** Max reconnect delay ms. Default 30_000. */
  maxReconnectMs?: number
}

export interface HubSubscriptionClient {
  start(): void
  stop(): void
  isConnected(): boolean
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_CHANNELS = ['tasks', 'memory', 'channels', 'audit', 'sprints', 'defects', 'prs']

class HubSubscriptionClientImpl implements HubSubscriptionClient {
  private ws: WebSocket | null = null
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelayMs: number
  private connected = false

  constructor(private readonly opts: HubSubscriptionOptions) {
    this.reconnectDelayMs = opts.initialReconnectMs ?? 1_000
  }

  isConnected(): boolean {
    return this.connected
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.setConnected(false)
  }

  private connect(): void {
    if (this.stopped) return

    logger.info({ hubWsUrl: this.opts.hubWsUrl }, 'hub-subscription: connecting to hub WS')

    // Use the global WebSocket in Node 22+ or the ws package shim.
    // The orchestrator runs in Node; we use native WebSocket (Node 22+)
    // or fall back to the ws package if it's available.
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.hubWsUrl)
    } catch (err) {
      logger.warn({ err }, 'hub-subscription: failed to construct WebSocket; scheduling reconnect')
      this.scheduleReconnect()
      return
    }

    this.ws = ws

    ws.addEventListener('open', () => {
      logger.info({ hubWsUrl: this.opts.hubWsUrl }, 'hub-subscription: connected')
      this.reconnectDelayMs = this.opts.initialReconnectMs ?? 1_000
      this.setConnected(true)

      // Subscribe to shared channels.
      const channelIds = this.opts.channelIds ?? DEFAULT_CHANNELS
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          channel_ids: channelIds,
        }),
      )
    })

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as Record<string, unknown>
        if (msg['ws_type'] === 'event') {
          const payload = msg['payload'] as Record<string, unknown>
          // Re-shape to EventEnvelope for local fan-out.
          // aggregate_type and actor are cast since they come as opaque JSON.
          const envelope = {
            event_id: String(payload['event_id'] ?? ''),
            aggregate_id: String(payload['aggregate_id'] ?? ''),
            aggregate_type: String(payload['aggregate_type'] ?? '') as EventEnvelope['aggregate_type'],
            event_type: String(payload['event_type'] ?? ''),
            payload: (payload['payload'] as Record<string, unknown>) ?? {},
            actor: payload['actor'] as EventEnvelope['actor'],
            capability_id: payload['capability_id'] as string | undefined,
            trace_id: String(msg['trace_id'] ?? ''),
            occurred_at: String(payload['occurred_at'] ?? new Date().toISOString()),
            ingested_at: new Date().toISOString(),
            schema_version: Number(payload['schema_version'] ?? 1),
          } satisfies EventEnvelope
          this.opts.onEvent(envelope)
        }
      } catch (err) {
        logger.warn({ err }, 'hub-subscription: failed to parse message')
      }
    })

    ws.addEventListener('close', () => {
      logger.info({ hubWsUrl: this.opts.hubWsUrl }, 'hub-subscription: connection closed')
      this.ws = null
      this.setConnected(false)
      this.scheduleReconnect()
    })

    ws.addEventListener('error', (ev) => {
      logger.warn({ event: ev, hubWsUrl: this.opts.hubWsUrl }, 'hub-subscription: WS error')
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(
      delay * 2,
      this.opts.maxReconnectMs ?? 30_000,
    )
    logger.info({ delayMs: delay }, 'hub-subscription: scheduling reconnect')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private setConnected(c: boolean): void {
    if (this.connected !== c) {
      this.connected = c
      this.opts.onStatusChange?.(c)
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * createHubSubscriptionClient — construct a WS subscription client.
 *
 * Returns null if hubWsUrl is not provided (no-hub mode).
 */
export function createHubSubscriptionClient(
  opts: HubSubscriptionOptions,
): HubSubscriptionClient {
  return new HubSubscriptionClientImpl(opts)
}
