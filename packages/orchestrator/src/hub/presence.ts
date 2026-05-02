/**
 * hub/presence.ts — Presence heartbeat service.
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * Every connected install sends a heartbeat every 30s. This module:
 *   1. Updates `known_installs.last_seen_at` in the DB on each heartbeat.
 *   2. Detects online/offline transitions and broadcasts them via the WS hub
 *      as `team:presence` events.
 *
 * "Online" threshold: last_seen_at within 90 seconds of now (matching the
 * UI's ONLINE_THRESHOLD_MS = 90_000).
 *
 * Design notes:
 *   - PresenceService.heartbeat(installId, tenantId) is called from:
 *       a) The WS hub on receipt of a 'heartbeat' WS message.
 *       b) Periodically by the local orchestrator for its own install_id.
 *   - Transition detection: a simple in-memory map tracks who was online at
 *     the last check. Transitions are broadcast as a synthetic event via
 *     EventStore.append with event_type='PresenceChanged'.
 *   - The in-memory map is process-local. In multi-replica hub deployments,
 *     each replica tracks only its own connected clients; the event store
 *     is the single source of truth for last_seen_at.
 */

import { sql } from '../db/client.js'
import { logger } from '../config/logger.js'
import type { EventStore } from '../events/store.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PresenceChangedPayload {
  install_id: string
  tenant_id: string
  online: boolean
  last_seen_at: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ONLINE_THRESHOLD_MS = 90_000
export const HEARTBEAT_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// PresenceService
// ---------------------------------------------------------------------------

export class PresenceService {
  /** In-memory online state map: installId → boolean. */
  private readonly _onlineState = new Map<string, boolean>()
  private readonly _eventStore: EventStore | null

  constructor(eventStore?: EventStore) {
    this._eventStore = eventStore ?? null
  }

  /**
   * Record a heartbeat for the given install.
   *
   * Updates last_seen_at in the database. If the transition from offline→online
   * or online→offline is detected, emits a PresenceChanged event.
   *
   * @param installId  UUID of the install.
   * @param tenantId   Tenant scoping (for event emission and fanout filtering).
   */
  async heartbeat(installId: string, tenantId: string): Promise<void> {
    const now = new Date()

    // 1. Update last_seen_at in DB (best-effort; failure must not crash caller)
    //    Pass the timestamp as an ISO string with explicit ::timestamptz cast.
    //    postgres-js (with prepare: false) cannot serialize a JS Date object
    //    directly — it throws ERR_INVALID_ARG_TYPE at the Buffer.byteLength call.
    //    The ::uuid cast on installId ensures correct type matching against the
    //    uuid-typed PK column (postgres-js sends string params as 'text').
    try {
      const nowIso = now.toISOString()
      await sql`
        UPDATE known_installs
        SET last_seen_at = ${nowIso}::timestamptz
        WHERE install_id = ${installId}::uuid
      `
    } catch (err) {
      logger.warn({ err, installId }, 'PresenceService.heartbeat: DB update failed')
    }

    // 2. Detect transition
    const wasOnline = this._onlineState.get(installId) ?? false
    const isNowOnline = true // just sent a heartbeat
    this._onlineState.set(installId, isNowOnline)

    if (wasOnline !== isNowOnline) {
      await this._emitPresenceChanged(installId, tenantId, isNowOnline, now)
    }
  }

  /**
   * Mark an install as offline (called when its WS connection closes).
   *
   * Updates the in-memory state and emits a PresenceChanged(online=false) event.
   * Does NOT update last_seen_at — the last heartbeat timestamp is the definitive
   * record.
   */
  async markOffline(installId: string, tenantId: string): Promise<void> {
    const wasOnline = this._onlineState.get(installId) ?? false
    this._onlineState.set(installId, false)

    if (wasOnline) {
      await this._emitPresenceChanged(installId, tenantId, false, new Date())
    }
  }

  /**
   * Emit a PresenceChanged event into the hub EventStore.
   * This broadcasts to all subscribed WS clients via the hub fanout.
   */
  private async _emitPresenceChanged(
    installId: string,
    tenantId: string,
    online: boolean,
    at: Date,
  ): Promise<void> {
    if (!this._eventStore) return

    const payload: PresenceChangedPayload = {
      install_id: installId,
      tenant_id: tenantId,
      online,
      last_seen_at: at.toISOString(),
    }

    try {
      await this._eventStore.append({
        aggregate_id: installId,
        aggregate_type: 'install',
        event_type: 'PresenceChanged',
        payload: payload as unknown as Record<string, unknown>,
        actor: { type: 'system', component: 'orchestrator' },
        trace_id: installId, // stable per install for correlation
        occurred_at: at.toISOString(),
        schema_version: 1,
      })

      logger.info(
        { installId, tenantId, online },
        `PresenceService: ${online ? 'online' : 'offline'} transition for install`,
      )
    } catch (err) {
      logger.warn({ err, installId }, 'PresenceService: failed to emit PresenceChanged')
    }
  }

  /**
   * Sweep for installs that have gone stale (last_seen_at > ONLINE_THRESHOLD_MS
   * ago) and mark them offline in the in-memory map.
   *
   * Call this periodically (e.g. every 30s) to clean up stale state if a WS
   * connection was dropped without a clean close event.
   *
   * Returns a list of install_ids that transitioned offline.
   */
  async sweepStale(members: Array<{ install_id: string; tenant_id: string; last_seen_at: string | null }>): Promise<string[]> {
    const now = Date.now()
    const staleInstalls: string[] = []

    for (const member of members) {
      const lastSeen = member.last_seen_at ? new Date(member.last_seen_at).getTime() : 0
      const stale = now - lastSeen > ONLINE_THRESHOLD_MS
      const wasOnline = this._onlineState.get(member.install_id) ?? false

      if (wasOnline && stale) {
        this._onlineState.set(member.install_id, false)
        staleInstalls.push(member.install_id)
        await this._emitPresenceChanged(
          member.install_id,
          member.tenant_id,
          false,
          new Date(),
        )
      }
    }

    return staleInstalls
  }

  /**
   * Check whether an install is considered online in the in-memory cache.
   * Note: may lag behind DB truth if the server just restarted.
   */
  isOnline(installId: string): boolean {
    return this._onlineState.get(installId) ?? false
  }
}

// ---------------------------------------------------------------------------
// Process singleton (for local orchestrator self-heartbeat)
// ---------------------------------------------------------------------------

let _instance: PresenceService | null = null

export function getPresenceService(eventStore?: EventStore): PresenceService {
  if (_instance === null) {
    _instance = new PresenceService(eventStore)
  }
  return _instance
}

/** Reset singleton for tests. */
export function resetPresenceService(): void {
  _instance = null
}
