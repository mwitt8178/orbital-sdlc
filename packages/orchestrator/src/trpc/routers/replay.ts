/**
 * trpc/routers/replay.ts — tRPC router for the replay subsystem.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Procedures:
 *   - replay.list({worker_id?, task_id?, event_id?})  → metadata for matching captures
 *   - replay.get({capture_id})                        → metadata for a single capture
 *   - replay.replay({capture_id, mode})               → execute a replay
 *
 * Capability check: the procedures are publicProcedure for now. Capability
 * gating sits at the MCP gateway layer for agent traffic; UI calls (operator
 * action) authenticate at the Fastify middleware layer.
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, publicProcedure } from '../init.js'
import { getReplayService } from '../../replay/service.js'

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const ListInput = z.object({
  worker_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  event_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(500).default(50),
})

const GetInput = z.object({
  capture_id: z.string().uuid(),
})

const ReplayInput = z.object({
  capture_id: z.string().uuid(),
  mode: z.enum(['inspect', 'replay-substituted', 'replay-live']),
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const replayRouter = router({
  /**
   * List captures matching the optional filter. Newest first; capped at
   * `limit` (default 50, max 500).
   */
  list: publicProcedure.input(ListInput).query(async ({ input }) => {
    const svc = getReplayService()
    const filter: Parameters<typeof svc.list>[0] = { limit: input.limit }
    if (input.worker_id !== undefined) filter.workerId = input.worker_id
    if (input.task_id !== undefined) filter.taskId = input.task_id
    if (input.event_id !== undefined) filter.eventId = input.event_id
    const items = await svc.list(filter)
    return { items }
  }),

  /** Get a single capture's metadata. */
  get: publicProcedure.input(GetInput).query(async ({ input }) => {
    const svc = getReplayService()
    const record = await svc.getCapture(input.capture_id)
    if (!record) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `replay capture not found: ${input.capture_id}`,
      })
    }
    return record
  }),

  /**
   * Execute a replay. Returns recorded request/response, the replay-time
   * response (or null for inspect), and matched_hash flag.
   */
  replay: publicProcedure.input(ReplayInput).mutation(async ({ input }) => {
    const svc = getReplayService()
    try {
      return await svc.replay(input.capture_id, input.mode)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('REPLAY_NOT_FOUND')) {
        throw new TRPCError({ code: 'NOT_FOUND', message })
      }
      if (message.startsWith('REPLAY_CORRUPT')) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message })
      }
      throw err
    }
  }),

  /**
   * Convenience: returns the count of captures attached to a given event_id.
   * Used by the UI to gate the 🔁 icon on each event row.
   */
  countForEvent: publicProcedure
    .input(z.object({ event_id: z.string().uuid() }))
    .query(async ({ input }) => {
      const svc = getReplayService()
      const items = await svc.list({ eventId: input.event_id, limit: 1 })
      return { count: items.length, hasCapture: items.length > 0 }
    }),
})

export type ReplayRouter = typeof replayRouter
