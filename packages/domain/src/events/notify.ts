/**
 * Postgres LISTEN/NOTIFY client for the events_channel.
 *
 * Per TRD-07 §4.1.4 and §8.4:
 * - NOTIFY is best-effort; subscribers MUST implement cursor-resync on (re)connect.
 * - On connect: backfill any events newer than the given cursor via SELECT.
 * - After backfill: switch to LISTEN for low-latency delivery.
 * - Periodically (every 60s): re-issue cursor query as defensive backfill.
 *
 * Uses postgres.js sql.listen() which creates a dedicated connection for the
 * LISTEN subscription (separate from the main pool).
 *
 * NOTE: This module does NOT import from ../db/client — it accepts the sql
 * instance as a parameter so tests can pass isolated connections.
 */

import type postgres from 'postgres'
import { logger } from '../logger.js'
import type { EventEnvelope } from './types.js'

export type EventHandler = (event: EventEnvelope) => void | Promise<void>

/** Handle returned by registerHandler; call it to remove the handler. */
export type Unsubscribe = () => void

/**
 * Manages all LISTEN subscriptions on a single shared dedicated connection.
 * Multiple consumers call registerHandler; each gets its own Unsubscribe.
 */
export class NotifyClient {
  private readonly handlers = new Set<EventHandler>()
  private unlistenFn: (() => void) | null = null
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  private connected = false

  constructor(
    private readonly sql: postgres.Sql,
    /**
     * Callback for backfill: when a NOTIFY arrives (or on reconnect / periodic
     * poll), the NotifyClient calls this with the event_id to fetch the full
     * event row. Provided by EventStore to break circular dependency.
     */
    private readonly fetchById: (eventId: string) => Promise<EventEnvelope | null>,
    /**
     * Callback for cursor backfill: on (re)connect, fetches all events after
     * the given event_id in event_id ordering so subscribers don't miss events
     * that arrived while disconnected.
     */
    private readonly backfillSince: (afterEventId: string | null) => Promise<EventEnvelope[]>,
  ) {}

  /**
   * Start listening. Safe to call multiple times (idempotent).
   * Performs a backfill from `cursor` before switching to LISTEN mode.
   */
  async start(cursor: string | null): Promise<void> {
    if (this.connected) return
    this.connected = true

    // Backfill: fetch any events newer than cursor before enabling LISTEN.
    // This handles events that arrived while we were disconnected.
    const backfilled = await this.backfillSince(cursor)
    for (const event of backfilled) {
      await this.dispatch(event)
    }

    // postgres.js sql.listen returns a promise that resolves once the
    // LISTEN command is sent. The second argument is the per-notification callback.
    const listenHandle = await this.sql.listen('events_channel', (payload: string) => {
      // payload = event_id (UUID string)
      this.onNotify(payload).catch((err: unknown) => {
        logger.error({ err, eventId: payload }, 'NotifyClient: error handling NOTIFY')
      })
    })

    // Store unlisten so stop() can clean up.
    this.unlistenFn = () => {
      void listenHandle.unlisten()
    }

    // Defensive periodic backfill every 60s in case NOTIFY was dropped.
    // Tracks latest seen event_id across handlers.
    let lastSeenEventId: string | null = cursor
    this.periodicTimer = setInterval(() => {
      void this.backfillSince(lastSeenEventId).then(async (events) => {
        for (const event of events) {
          await this.dispatch(event)
          lastSeenEventId = event.event_id
        }
      })
    }, 60_000)

    logger.info({ cursor }, 'NotifyClient: LISTEN started on events_channel')
  }

  /** Stop listening and release the connection. Returns a promise that resolves when unlisten completes. */
  async stop(): Promise<void> {
    if (this.periodicTimer !== null) {
      clearInterval(this.periodicTimer)
      this.periodicTimer = null
    }
    if (this.unlistenFn !== null) {
      try {
        this.unlistenFn()
      } catch {
        // Ignore errors during unlisten (connection may already be closing).
      }
      this.unlistenFn = null
    }
    this.connected = false
    // Give the unlisten command a moment to flush before the caller closes the pool.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    logger.info('NotifyClient: stopped')
  }

  /** Register a handler. Returns an unsubscribe function. */
  registerHandler(handler: EventHandler): Unsubscribe {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  private async onNotify(eventId: string): Promise<void> {
    const event = await this.fetchById(eventId)
    if (!event) {
      logger.warn({ eventId }, 'NotifyClient: received NOTIFY for unknown event_id')
      return
    }
    await this.dispatch(event)
  }

  private async dispatch(event: EventEnvelope): Promise<void> {
    const tasks: Array<Promise<void>> = []
    for (const handler of this.handlers) {
      const result = handler(event)
      if (result instanceof Promise) tasks.push(result)
    }
    if (tasks.length > 0) await Promise.all(tasks)
  }
}
