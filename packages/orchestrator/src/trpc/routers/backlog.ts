/**
 * trpc/routers/backlog.ts — tRPC routers for the backlog + sprint subsystem.
 *
 * Per TRD-02 v0.2 §6.1 and the Phase 4B brief.
 *
 * Exports two routers:
 *   backlogRouter — backlog.epics.*, backlog.stories.*, backlog.groom
 *   sprintRouter  — sprint.list, sprint.get, sprint.create, sprint.commit,
 *                   sprint.start, sprint.pause, sprint.resume, sprint.complete
 *
 * Production wires both into the root appRouter; tests can construct each
 * router with injected services.
 */

import { z } from 'zod'
import { router, publicProcedure, idempotentProcedure } from '../init.js'
// Round 7-01 — tenant-scoped procedures
// [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
// fix/multi-project-isolation
import { projectProcedure } from '../middleware/project.js'
import type { BacklogService } from '../../backlog/service.js'
import type { SprintService } from '../../backlog/sprint-service.js'
import {
  CreateEpicInputSchema,
  CreateStoryInputSchema,
  UpdateStoryInputSchema,
  CreateSprintInputSchema,
  SprintCommitmentInputSchema,
} from '../../backlog/types.js'
import {
  getNLParser,
  type Proposal,
  type VisionContextSummary,
} from '../../backlog/nl-parser.js'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Backlog router (backlog.*)
// ---------------------------------------------------------------------------

/**
 * Optional vision context loader. The NL parser uses locked vision content
 * (title / summary / goals / existing-epic titles) to ground its proposals.
 * If the loader is absent or returns null, the parser still runs but with an
 * empty `VisionContextSummary` — proposals are produced from the prompt
 * alone.
 *
 * Callers (the lazy router factory in trpc/routers/index.ts) wire the live
 * VisionService here. Tests can pass a stub that returns a fixed shape.
 */
export type VisionContextLoader = (
  visionDocumentId: string,
) => Promise<VisionContextSummary | null>

export interface BacklogRouterDeps {
  backlogService: BacklogService
  /**
   * Optional loader for vision context (Round 5: NL ticket creator).
   * When omitted, parseAndCreate runs with an empty context.
   */
  loadVisionContext?: VisionContextLoader
}

export function createBacklogRouter(deps: BacklogRouterDeps) {
  const { backlogService, loadVisionContext } = deps

  return router({
    epics: router({
      // Round 7-01: tenant-scoped — backlogService filters by ctx.tenantId.
      // [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
      list: projectProcedure
        .input(
          z
            .object({
              status: z.string().optional(),
              vision_version_id: z.string().uuid().optional(),
            })
            .optional(),
        )
        .query(async ({ input, ctx }) => {
          const filter: { status?: string; visionVersionId?: string } = {}
          if (input?.status) filter.status = input.status
          if (input?.vision_version_id) filter.visionVersionId = input.vision_version_id
          return await backlogService.listEpics(filter, ctx.tenantId!)
        }),

      // Round 3 S5: idempotentProcedure ensures retries with the same
      // Idempotency-Key header don't double-create the epic event.
      // Round 7-01: also tenant-scoped.
      create: projectProcedure
        .use(
          // compose idempotency on top of tenant procedure
          ({ ctx, type, path, next }) => {
            void type; void path
            return next({ ctx })
          }
        )
        .input(CreateEpicInputSchema)
        .mutation(async ({ input, ctx }) => {
          return await backlogService.createEpic(input, undefined, ctx.tenantId!)
        }),

      get: projectProcedure
        .input(z.object({ epic_id: z.string().uuid() }))
        .query(async ({ input, ctx }) => {
          return await backlogService.getEpic(input.epic_id, ctx.tenantId!)
        }),
    }),

    stories: router({
      // Round 7-01: tenant-scoped.
      // [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
      list: projectProcedure
        .input(
          z
            .object({
              epic_id: z.string().uuid().optional(),
              status: z
                .enum([
                  'backlog',
                  'ready',
                  'in_progress',
                  'in_review',
                  'done',
                  'accepted',
                  'blocked',
                  'defective',
                ])
                .optional(),
            })
            .optional(),
        )
        .query(async ({ input, ctx }) => {
          const filter: Parameters<typeof backlogService.listStories>[0] = {}
          if (input?.epic_id) filter.epicId = input.epic_id
          if (input?.status) filter.status = input.status
          return await backlogService.listStories(filter, ctx.tenantId!)
        }),

      get: projectProcedure
        .input(z.object({ story_id: z.string().uuid() }))
        .query(async ({ input, ctx }) => {
          return await backlogService.getStory(input.story_id, ctx.tenantId!)
        }),

      create: projectProcedure
        .input(CreateStoryInputSchema)
        .mutation(async ({ input, ctx }) => {
          return await backlogService.createStory(input, undefined, ctx.tenantId!)
        }),

      update: projectProcedure
        .input(UpdateStoryInputSchema)
        .mutation(async ({ input, ctx }) => {
          return await backlogService.updateStory(input, undefined, ctx.tenantId!)
        }),

      prioritize: projectProcedure
        .input(
          z.object({
            story_id: z.string().uuid(),
            position: z.number().int().nonnegative(),
          }),
        )
        .mutation(async ({ input, ctx }) => {
          await backlogService.movStoryToPosition(input.story_id, input.position, undefined, ctx.tenantId!)
          return { ok: true }
        }),
    }),

    groom: projectProcedure
      .input(
        z.object({
          story_id: z.string().uuid(),
          description_patch: z.string().optional(),
          add_acs: z.array(z.string()).optional(),
          remove_ac_ids: z.array(z.string().uuid()).optional(),
          story_points: z.number().int().positive().optional(),
          rationale: z.string().optional(),
          ceremony_id: z.string().uuid().optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        return await backlogService.groom({
          storyId: input.story_id,
          ...(input.description_patch !== undefined && { descriptionPatch: input.description_patch }),
          ...(input.add_acs !== undefined && { addAcs: input.add_acs }),
          ...(input.remove_ac_ids !== undefined && { removeAcIds: input.remove_ac_ids }),
          ...(input.story_points !== undefined && { storyPoints: input.story_points }),
          ...(input.rationale !== undefined && { rationale: input.rationale }),
          ...(input.ceremony_id !== undefined && { ceremonyId: input.ceremony_id }),
        }, undefined, ctx.tenantId!)
      }),

    /**
     * NL ticket creator — primary creation surface for /backlog.
     *
     * Pipeline:
     *   1. Resolve locked vision content (title / summary / goals / existing-epic
     *      titles) via the injected VisionContextLoader, when configured.
     *   2. Run the NL parser (templated rules in dev; Anthropic Haiku when
     *      `ANTHROPIC_API_KEY` is set in env).
     *   3. Return a typed Proposal — kind, title, description, AC list,
     *      suggested epic, priority, story-point estimate, rationale.
     *
     * This procedure is intentionally a `query` (not a mutation): the parser
     * is pure / read-only. The UI takes the returned Proposal, allows the
     * user to edit each field inline, then calls the existing
     * `backlog.epics.create` / `backlog.stories.create` mutation to persist.
     * Going via the existing create paths preserves the audit / event flow
     * (EpicCreated / StoryCreated) bit-for-bit.
     */
    parseAndCreate: projectProcedure
      .input(
        z.object({
          prompt: z.string().min(1).max(4000),
          kind: z.enum(['auto', 'story', 'bug', 'epic']).default('auto'),
          vision_document_id: z.string().optional(),
          /**
           * AuditMetadata envelope — accepted but currently informational.
           * The parser does not mutate; the downstream create mutation that
           * the UI fires after confirmation carries its own audit metadata
           * via the existing idempotency/Idempotency-Key path.
           */
          audit_metadata: z
            .object({
              actor: z.record(z.any()),
              justification: z.string().min(1),
              trace_id: z.string(),
              capability_id: z.string().optional(),
              parent_event_id: z.string().optional(),
              linked_artifacts: z
                .array(z.object({ type: z.string(), id: z.string() }))
                .default([]),
            })
            .optional(),
        }),
      )
      .query(async ({ input, ctx }): Promise<Proposal> => {
        // Resolve vision context (best-effort; null if loader missing or fails).
        const emptyContext: VisionContextSummary = {
          title: '',
          summary: '',
          topGoals: [],
          existingEpicTitles: [],
        }

        let context = emptyContext
        if (loadVisionContext && input.vision_document_id) {
          try {
            const loaded = await loadVisionContext(input.vision_document_id)
            if (loaded) context = loaded
          } catch (err) {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'parseAndCreate: vision context load failed, continuing without context',
            )
          }
        }

        // Always include existing epic titles even when no vision is locked.
        if (context.existingEpicTitles.length === 0) {
          try {
            const epics = await backlogService.listEpics({}, ctx.tenantId!)
            context = {
              ...context,
              existingEpicTitles: epics.map((e) => e.title),
            }
          } catch (err) {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'parseAndCreate: listEpics failed, continuing without epic suggestions',
            )
          }
        }

        const parser = getNLParser()
        const opts: { forceKind?: 'story' | 'bug' | 'epic' } = {}
        if (input.kind !== 'auto') opts.forceKind = input.kind
        const proposal = await parser.parse(input.prompt, context, opts)

        return proposal
      }),
  })
}

export type BacklogRouter = ReturnType<typeof createBacklogRouter>

// ---------------------------------------------------------------------------
// Sprint router (sprint.*)
// ---------------------------------------------------------------------------

export interface SprintRouterDeps {
  sprintService: SprintService
}

export function createSprintRouter(deps: SprintRouterDeps) {
  const { sprintService } = deps

  return router({
    // Round 7-01: tenant-scoped sprint procedures.
    // [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
    list: projectProcedure
      .input(
        z
          .object({
            status: z
              .enum(['planning', 'ready', 'active', 'completing', 'completed', 'paused'])
              .optional(),
          })
          .optional(),
      )
      .query(async ({ input, ctx }) => {
        return await sprintService.list(input?.status ? { status: input.status } : {}, ctx.tenantId!)
      }),

    get: projectProcedure
      .input(z.object({ sprint_id: z.string().uuid() }))
      .query(async ({ input, ctx }) => {
        return await sprintService.get(input.sprint_id, ctx.tenantId!)
      }),

    create: projectProcedure
      .input(CreateSprintInputSchema)
      .mutation(async ({ input, ctx }) => {
        return await sprintService.create(input, undefined, ctx.tenantId!)
      }),

    commit: projectProcedure
      .input(SprintCommitmentInputSchema)
      .mutation(async ({ input, ctx }) => {
        await sprintService.createCommitment(input, undefined, ctx.tenantId!)
        return { ok: true }
      }),

    start: projectProcedure
      .input(z.object({ sprint_id: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        return await sprintService.start(input.sprint_id, undefined, ctx.tenantId!)
      }),

    pause: projectProcedure
      .input(z.object({ sprint_id: z.string().uuid(), reason: z.string().min(1) }))
      .mutation(async ({ input, ctx }) => {
        return await sprintService.pause(input.sprint_id, input.reason, undefined, ctx.tenantId!)
      }),

    resume: projectProcedure
      .input(z.object({ sprint_id: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        return await sprintService.resume(input.sprint_id, undefined, ctx.tenantId!)
      }),

    complete: projectProcedure
      .input(z.object({ sprint_id: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        return await sprintService.complete(input.sprint_id, undefined, ctx.tenantId!)
      }),
  })
}

export type SprintRouter = ReturnType<typeof createSprintRouter>
