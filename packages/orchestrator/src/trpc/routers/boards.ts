/**
 * trpc/routers/boards.ts — Boards tRPC router for Round 5 Monday discovery.
 *
 * Per Round 5 Monday Board Discovery spec.
 *
 * Procedures:
 *   boards.discover         (mutation) — discover schema + persist; emits BoardDiscovered
 *   boards.proposeMapping   (query)    — propose mapping over the latest schema
 *   boards.confirmMapping   (mutation) — persist confirmed mapping; emits BoardMappingConfirmed
 *   boards.getMapping       (query)    — current confirmed mapping for a project
 *   boards.getSchema        (query)    — most recent persisted schema for a board
 *
 * The router does NOT mount its own MondayClient; we accept it via deps so
 * tests can pass a fetchImpl-injected DefaultMondayClient. The wiring at
 * routers/index.ts uses the module-level lazy singleton.
 */

import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { OrbitalError, type Actor, type EventInput } from '@orbital/types'
import { router, publicProcedure } from '../init.js'
// fix/multi-project-isolation
import { projectProcedure } from '../middleware/project.js'
import type { DB } from '../../db/client.js'
import type { EventStore } from '../../events/store.js'
import { boardSchemas } from '../../db/schema/board-mapping.js'
import { projects } from '../../db/schema/projects.js'
import type { BoardDiscoveryService, BoardSchema } from '../../backlog/board-discovery.js'
import {
  BoardMappingSchema,
  ORBITAL_STATES,
  type BoardMappingService,
  type BoardMapping,
} from '../../backlog/board-mapping.js'
import type { BoardMappingResolver } from '../../backlog/board-mapping-resolver.js'
import { logger } from '../../config/logger.js'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const projectIdInput = z.object({
  project_id: z.string().uuid(),
})

const confirmMappingInput = z.object({
  project_id: z.string().uuid(),
  mapping: BoardMappingSchema,
})

const getSchemaInput = z.object({
  board_id: z.string().min(1),
})

// ---------------------------------------------------------------------------
// Output shapes (kept loose — JSON over the wire). We re-validate via Zod on
// the consumer side where needed.
// ---------------------------------------------------------------------------

export interface BoardDiscoverOutput {
  board_id: string
  schema: BoardSchema
  proposed_mapping: BoardMapping
}

export interface BoardSchemaWithMeta {
  schema: BoardSchema
  discovered_at: string
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapToTRPCError(err: unknown): never {
  if (err instanceof TRPCError) throw err
  if (err instanceof OrbitalError) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message,
      cause: err,
    })
  }
  if (err instanceof Error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message,
      cause: err,
    })
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Unknown error' })
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface BoardsRouterDeps {
  db: DB
  eventStore: EventStore
  discoveryService: BoardDiscoveryService
  mappingService: BoardMappingService
  resolver: BoardMappingResolver
}

export function createBoardsRouter(deps: BoardsRouterDeps) {
  const { db, eventStore, discoveryService, mappingService, resolver } = deps

  return router({
    // -----------------------------------------------------------------------
    // discover — read schema, persist, emit event
    // -----------------------------------------------------------------------
    discover: projectProcedure
      .input(projectIdInput)
      .mutation(async ({ input, ctx }): Promise<BoardDiscoverOutput> => {
        // fix/multi-project-isolation
        if (input.project_id !== ctx.projectId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'project_id mismatch between input and active project header',
          })
        }
        try {
          const project = await db
            .select()
            .from(projects)
            .where(eq(projects.projectId, input.project_id))
            .limit(1)
          const proj = project[0]
          if (!proj) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `project ${input.project_id} not found`,
            })
          }
          if (!proj.mondayBoardId) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `project ${input.project_id} has no Monday board connected`,
            })
          }

          const schema = await discoveryService.discover(proj.mondayBoardId)

          // Persist (upsert by board_id).
          await db
            .insert(boardSchemas)
            .values({
              boardId: schema.board_id,
              schemaJson: schema,
              mondayApiVersion: '2024-01',
              discoveredAt: new Date(),
              schemaVersion: 1,
            })
            .onConflictDoUpdate({
              target: [boardSchemas.boardId],
              set: {
                schemaJson: schema,
                mondayApiVersion: '2024-01',
                discoveredAt: new Date(),
              },
            })

          // Generate the heuristic + (optionally) LLM proposal in the same
          // call so the UI can show both the schema and a suggested mapping
          // without a second roundtrip.
          const proposed = await mappingService.propose(schema, {
            projectId: input.project_id,
          })

          // Emit BoardDiscovered.
          const ev: EventInput = {
            aggregate_id: input.project_id,
            aggregate_type: 'install',
            event_type: 'BoardDiscovered',
            payload: {
              project_id: input.project_id,
              board_id: schema.board_id,
              board_name: schema.board_name,
              columns_count: schema.columns.length,
              has_subitems: schema.has_subitems,
              status_columns_count: schema.status_columns.length,
            },
            actor: SYSTEM_ACTOR,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
          }
          await eventStore.append(ev)

          return {
            board_id: schema.board_id,
            schema,
            proposed_mapping: proposed,
          }
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    // -----------------------------------------------------------------------
    // proposeMapping — read latest schema, propose mapping (no persist)
    // -----------------------------------------------------------------------
    proposeMapping: projectProcedure
      .input(projectIdInput)
      .query(async ({ input, ctx }): Promise<BoardMapping> => {
        // fix/multi-project-isolation
        if (input.project_id !== ctx.projectId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'project_id mismatch between input and active project header',
          })
        }
        try {
          const project = await db
            .select()
            .from(projects)
            .where(eq(projects.projectId, input.project_id))
            .limit(1)
          const proj = project[0]
          if (!proj) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `project ${input.project_id} not found`,
            })
          }
          if (!proj.mondayBoardId) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `project ${input.project_id} has no Monday board connected`,
            })
          }
          const rows = await db
            .select()
            .from(boardSchemas)
            .where(eq(boardSchemas.boardId, proj.mondayBoardId))
            .limit(1)
          const row = rows[0]
          if (!row) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message:
                'no board_schema persisted yet — call boards.discover first',
            })
          }
          const schema = row.schemaJson as BoardSchema
          return await mappingService.propose(schema, {
            projectId: input.project_id,
          })
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    // -----------------------------------------------------------------------
    // confirmMapping — persist mapping with confirmed_at = now()
    // -----------------------------------------------------------------------
    confirmMapping: projectProcedure
      .input(confirmMappingInput)
      .mutation(async ({ input, ctx }): Promise<{ ok: true }> => {
        // fix/multi-project-isolation
        if (input.project_id !== ctx.projectId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'project_id mismatch between input and active project header',
          })
        }
        try {
          // Defensive: the mapping's project_id must match the input project_id.
          if (input.mapping.project_id !== input.project_id) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                'mapping.project_id does not match input.project_id',
            })
          }
          await mappingService.confirm(input.mapping, SYSTEM_ACTOR)
          // Invalidate any cached resolver entry so the next resolve picks up
          // the new mapping immediately (otherwise the 60s TTL would delay it).
          resolver.invalidate(input.project_id)
          return { ok: true }
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    // -----------------------------------------------------------------------
    // getMapping — current confirmed mapping for a project
    // -----------------------------------------------------------------------
    getMapping: projectProcedure
      .input(projectIdInput)
      .query(async ({ input, ctx }): Promise<BoardMapping | null> => {
        // fix/multi-project-isolation
        if (input.project_id !== ctx.projectId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'project_id mismatch between input and active project header',
          })
        }
        try {
          return await mappingService.get(input.project_id)
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    // -----------------------------------------------------------------------
    // getSchema — most recent persisted schema for a board
    // -----------------------------------------------------------------------
    getSchema: projectProcedure
      .input(getSchemaInput)
      .query(async ({ input }): Promise<BoardSchemaWithMeta | null> => {
        try {
          const rows = await db
            .select()
            .from(boardSchemas)
            .where(eq(boardSchemas.boardId, input.board_id))
            .limit(1)
          const row = rows[0]
          if (!row) return null
          return {
            schema: row.schemaJson as BoardSchema,
            discovered_at: row.discoveredAt.toISOString(),
          }
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    // -----------------------------------------------------------------------
    // states — enumerate Orbital lifecycle states for the mapping UI
    // -----------------------------------------------------------------------
    states: projectProcedure.query(() => {
      return [...ORBITAL_STATES]
    }),
  })
}

export type BoardsRouter = ReturnType<typeof createBoardsRouter>

// Avoid unused-import warning for logger; reserved for future telemetry.
void logger
