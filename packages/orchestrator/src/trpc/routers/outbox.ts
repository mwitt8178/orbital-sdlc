/**
 * trpc/routers/outbox.ts — Local outbox management tRPC router.
 *
 * Round 7-06 — Offline Cache + Reconciliation
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * Procedures:
 *   outbox.list()           — list pending + failed outbox entries (UI display)
 *   outbox.dismiss({seq})   — mark a permanently-failed entry as dismissed
 *   outbox.queueDepth()     — count of unflushed rows (for banner count)
 *
 * These are LOCAL-ONLY procedures — they query the local_outbox table, not the
 * hub. The UI calls them while offline to show the pending panel.
 *
 * Auth: no auth required (UI runs on the operator's own machine; the outbox
 * is local-only data, never sent to the hub).
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { isNull, asc } from 'drizzle-orm'

import { router, publicProcedure } from '../init.js'
import { db } from '../../db/client.js'
import { localOutbox } from '../../db/schema/local-outbox.js'
import { logger } from '../../config/logger.js'
import { getHubClient } from '../../hub-client/index.js'
import { createPersistentHubOutbox } from '../../hub-client/outbox.js'
import type { HubConnectionState } from '../../hub-client/client.js'

// ---------------------------------------------------------------------------
// Lazy persistent outbox singleton (only used when hub is configured)
// ---------------------------------------------------------------------------

let _persistentOutbox: ReturnType<typeof createPersistentHubOutbox> | null = null

function getConnectionState(): HubConnectionState {
  const client = getHubClient()
  if (!client) return 'offline'
  return client.connectionState
}

export function getPersistentOutbox(): ReturnType<typeof createPersistentHubOutbox> | null {
  const hub = getHubClient()
  if (!hub) return null
  if (_persistentOutbox === null) {
    _persistentOutbox = createPersistentHubOutbox(db, hub, getConnectionState, {
      autoStart: true,
    })
  }
  return _persistentOutbox
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const outboxRouter = router({
  /**
   * list — return all unflushed outbox entries, ordered by seq.
   * Used by PendingMutationsPanel.
   */
  list: publicProcedure.query(async () => {
    try {
      const rows = await db
        .select()
        .from(localOutbox)
        .where(isNull(localOutbox.flushed_at))
        .orderBy(asc(localOutbox.seq))

      return rows.map((row) => ({
        seq: row.seq.toString(),
        kind: row.kind,
        endpoint: row.endpoint,
        idempotency_key: row.idempotency_key,
        created_at: row.created_at,
        attempts: row.attempts,
        last_error: row.last_error ?? null,
        status: row.attempts >= 5 ? 'failed' : row.attempts > 0 ? 'retrying' : 'pending',
      }))
    } catch (err) {
      logger.error({ err }, 'outbox.list: query failed')
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list outbox entries' })
    }
  }),

  /**
   * dismiss — operator dismisses a permanently-failed entry.
   * Marks flushed_at so it no longer shows in the list.
   */
  dismiss: publicProcedure
    .input(z.object({ seq: z.string() }))
    .mutation(async ({ input }) => {
      const outbox = getPersistentOutbox()
      if (!outbox) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No hub configured — outbox not active' })
      }
      try {
        await outbox.dismiss(BigInt(input.seq))
        return { ok: true }
      } catch (err) {
        logger.error({ err, seq: input.seq }, 'outbox.dismiss: failed')
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to dismiss entry' })
      }
    }),

  /**
   * queueDepth — count of unflushed rows for banner badge.
   */
  queueDepth: publicProcedure.query(async () => {
    try {
      const rows = await db
        .select({ seq: localOutbox.seq })
        .from(localOutbox)
        .where(isNull(localOutbox.flushed_at))
      return { count: rows.length }
    } catch {
      return { count: 0 }
    }
  }),
})

export type OutboxRouter = typeof outboxRouter
