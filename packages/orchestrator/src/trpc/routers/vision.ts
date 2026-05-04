/**
 * trpc/routers/vision.ts — tRPC router for vision intake operations.
 *
 * Per TRD-01 §6.1 and Implementation Plan §8 Task 4A.
 *
 * Procedures:
 *   vision.start     (mutation) — start a vision intake session, spawn PM persona
 *   vision.sendMessage (mutation) — user sends a message in the session
 *   vision.draft     (mutation) — PM persona drafts a vision document
 *   vision.reviewDraft (query)  — review the current draft, get confirmation token
 *   vision.lock      (mutation) — lock the current draft (user only)
 *   vision.revise    (mutation) — create a new version of a locked document
 *   vision.get       (query)    — get the current version of a document
 *   vision.history   (query)    — list all versions of a document
 */

import { TRPCError } from '@trpc/server'
import { router, publicProcedure } from '../init.js'
// fix/multi-project-isolation
import { projectProcedure } from '../middleware/project.js'
import { db } from '../../db/client.js'
import { sql as sqlPool } from '../../db/client.js'
import { createEventStore } from '../../events/store.js'
import { DefaultChannelsService } from '../../comms/channels.js'
import { HookEngine } from '../../hooks/engine.js'
import { DefaultPersonaLoader } from '../../personas/loader.js'
import { CapabilityAuthority } from '../../capabilities/authority.js'
import { KeyManager } from '../../capabilities/keys.js'
import { createVisionService } from '../../vision/service.js'
import { suggestEpicsFromVision } from '../../vision/epic-suggester.js'
import type { RoutingEngine } from '../../routing/engine.js'
import { getInstallId } from '../../config/install.js'
import { getRegisteredScheduler } from './scheduler-ref.js'
import { OrbitalError } from '@orbital/types'
import {
  SessionStartInputSchema,
  SendMessageInputSchema,
  LockInputSchema,
  ReviseInputSchema,
  GetInputSchema,
  HistoryInputSchema,
  VisionDocumentContentDraftSchema,
} from '../../vision/types.js'
import { z } from 'zod'
import type {
  VisionDocumentId,
  VisionSessionId,
  VisionVersionId,
} from '../../vision/types.js'

// ---------------------------------------------------------------------------
// Service factory (lazy singleton per process)
// ---------------------------------------------------------------------------

let _visionService: ReturnType<typeof createVisionService> | null = null
let _installId: string | null = null

async function getVisionService() {
  if (_visionService) return _visionService

  if (!_installId) {
    _installId = await getInstallId()
  }

  const eventStore = createEventStore(db, sqlPool)
  const channelsService = new DefaultChannelsService(db, eventStore)
  const hookEngine = new HookEngine(eventStore, db)
  const personaLoader = new DefaultPersonaLoader(db, eventStore)
  const keyManager = new KeyManager(_installId, eventStore)
  const capabilityAuthority = new CapabilityAuthority(eventStore, keyManager)
  // Minimal routing engine stub — VisionService only uses it for PM spawn routing,
  // which is wrapped in a try-catch and degrades gracefully.
  const routingEngine: RoutingEngine = {
    selectModel: async (input): Promise<import('../../routing/types.js').RoutingDecision> => ({
      decision_id: 'stub',
      task_id: input.task_id,
      persona_id: input.persona_id,
      risk_class: input.risk_class,
      retry_depth: input.retry_depth ?? 0,
      model: 'claude-sonnet-4-6',
      token_budget: 8000,
      escalation_policy: { on_failure: 'escalate_one_tier', max_retries: 2, escalate_after: 2 },
      reason: {
        base_from_persona: 'claude-sonnet-4-6',
        rules_applied: [],
      },
      policy_version: 1,
    }),
    routeModel: async (input) => ({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      reason: 'stub routing engine',
      sodApplied: false,
    }),
  }

  // Pull the live Scheduler if boot has registered one. When absent (e.g. tRPC
  // tests that bypass the daemon boot), VisionService.start() will log a
  // warning and skip the spawn but still create the session and channel.
  const scheduler = getRegisteredScheduler() ?? undefined

  _visionService = createVisionService(
    db,
    eventStore,
    channelsService,
    hookEngine,
    personaLoader,
    capabilityAuthority,
    routingEngine,
    _installId,
    scheduler,
  )

  return _visionService
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapOrbitalError(err: unknown): TRPCError {
  if (err instanceof OrbitalError) {
    const code = err.code
    const trpcCode: TRPCError['code'] =
      code.startsWith('NOT_FOUND_') ? 'NOT_FOUND'
      : code.startsWith('AUTH_') ? 'UNAUTHORIZED'
      : code.startsWith('CONFLICT_') ? 'CONFLICT'
      : code.startsWith('VALIDATION_') || code.startsWith('HOOK_') ? 'BAD_REQUEST'
      : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code: trpcCode, message: err.message, cause: err })
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: String(err) })
}

// ---------------------------------------------------------------------------
// Draft content input schema (for vision.draft procedure)
// ---------------------------------------------------------------------------

const DraftInputSchema = z.object({
  vision_session_id: z.string(),
  content: VisionDocumentContentDraftSchema,
  draft_summary: z.string().min(1).max(2000),
  audit_metadata: z.object({
    actor: z.record(z.any()),
    justification: z.string().min(1),
    trace_id: z.string(),
    capability_id: z.string().optional(),
    parent_event_id: z.string().optional(),
    linked_artifacts: z.array(z.object({ type: z.string(), id: z.string() })).default([]),
  }),
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const visionRouter = router({
  /** Start a vision intake session. Spawns PM persona. */
  start: projectProcedure
    .input(SessionStartInputSchema)
    .mutation(async ({ input }) => {
      try {
        const svc = await getVisionService()
        const result = await svc.start({
          title: input.title,
          initial_prompt: input.initial_prompt,
          install_id: _installId ?? '',
          actor: input.audit_metadata.actor as import('@orbital/types').Actor,
          trace_id: input.audit_metadata.trace_id,
          justification: input.audit_metadata.justification,
        })
        return {
          vision_document_id: result.vision_document_id,
          vision_session_id: result.vision_session_id,
          pm_persona_request_id: result.pm_persona_request_id,
          state: 'open' as const,
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

  /** Send a message in an open vision session. */
  sendMessage: projectProcedure
    .input(SendMessageInputSchema)
    .mutation(async ({ input }) => {
      try {
        const svc = await getVisionService()
        const msg = await svc.sendMessage(
          input.vision_session_id as VisionSessionId,
          input.body,
          input.audit_metadata.actor as import('@orbital/types').Actor,
          input.audit_metadata.trace_id,
        )
        return {
          vision_message_id: msg.vision_message_id,
          posted_at: msg.posted_at,
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

  /** PM persona produces a draft snapshot. */
  draft: projectProcedure
    .input(DraftInputSchema)
    .mutation(async ({ input }) => {
      try {
        const svc = await getVisionService()
        const version = await svc.draft(
          input.vision_session_id as VisionSessionId,
          input.content,
          input.draft_summary,
          input.audit_metadata.actor as import('@orbital/types').Actor,
          input.audit_metadata.trace_id,
        )
        return version
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

  /** Review the current draft and receive a confirmation token for locking. */
  reviewDraft: projectProcedure
    .input(z.object({ vision_document_id: z.string() }))
    .query(async ({ input }) => {
      try {
        const svc = await getVisionService()
        return svc.reviewDraft(input.vision_document_id as VisionDocumentId)
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

  /** Lock the current draft (user must supply confirmation_token from reviewDraft). */
  lock: projectProcedure
    .input(LockInputSchema)
    .mutation(async ({ input }) => {
      try {
        const svc = await getVisionService()
        const version = await svc.lock({
          documentId: input.vision_document_id as VisionDocumentId,
          confirmationToken: input.confirmation_token,
          changelog: input.changelog,
          attestation: input.attestation,
          actor: input.audit_metadata.actor as import('@orbital/types').Actor,
          traceId: input.audit_metadata.trace_id,
          justification: input.audit_metadata.justification,
        })
        return {
          vision_version_id: version.vision_version_id,
          version_number: version.version_number,
          content_hash: version.content_hash,
          locked_at: version.locked_at,
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

  /** Create a new revision of a locked document. */
  revise: projectProcedure
    .input(ReviseInputSchema)
    .mutation(async ({ input }) => {
      try {
        const svc = await getVisionService()
        const version = await svc.revise({
          documentId: input.vision_document_id as VisionDocumentId,
          baseVersionId: input.base_version_id as VisionVersionId,
          delta: input.delta,
          changelog: input.changelog,
          reason: input.reason,
          actor: input.audit_metadata.actor as import('@orbital/types').Actor,
          traceId: input.audit_metadata.trace_id,
          justification: input.audit_metadata.justification,
        })
        return {
          vision_version_id: version.vision_version_id,
          version_number: version.version_number,
          content_hash: version.content_hash,
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

  /** Get the current (or a specific) version of a vision document. */
  get: projectProcedure
    .input(GetInputSchema)
    .query(async ({ input }) => {
      try {
        const svc = await getVisionService()
        const doc = await svc.getDocument(input.vision_document_id as VisionDocumentId)
        const version = await svc.getVersion(
          input.vision_document_id as VisionDocumentId,
          input.version_number,
        )
        return {
          vision_document_id: doc.vision_document_id,
          lifecycle_state: doc.lifecycle_state,
          current_version_number: doc.current_version_number,
          version: version
            ? {
                vision_version_id: version.vision_version_id,
                version_number: version.version_number,
                content: version.content,
                is_locked: version.is_locked,
                locked_at: version.locked_at,
              }
            : null,
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

  /** List all versions of a document. */
  history: projectProcedure
    .input(HistoryInputSchema)
    .query(async ({ input }) => {
      try {
        const svc = await getVisionService()
        const versions = await svc.listVersions(
          input.vision_document_id as VisionDocumentId,
          input.after,
          input.limit,
        )
        return { items: versions, has_more: false }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

  /**
   * Suggest 3-5 initial epics from a locked or draft vision document.
   *
   * Read-only — does NOT mutate any aggregate. The procedure inspects the
   * document content (title, summary, goals, etc.) and returns a deterministic
   * list of epic templates derived from a curated keyword catalog.
   *
   * v1: templated heuristic (no LLM). v2 will swap in a real Anthropic
   * completion without changing the public API.
   */
  suggestEpics: projectProcedure
    .input(
      z.object({
        vision_document_id: z.string(),
        audit_metadata: z.object({
          actor: z.record(z.any()),
          justification: z.string().min(1),
          trace_id: z.string(),
          capability_id: z.string().optional(),
          parent_event_id: z.string().optional(),
          linked_artifacts: z
            .array(z.object({ type: z.string(), id: z.string() }))
            .default([]),
        }),
      }),
    )
    .query(async ({ input }) => {
      try {
        const svc = await getVisionService()
        const doc = await svc.getDocument(input.vision_document_id as VisionDocumentId)
        const version = await svc.getVersion(input.vision_document_id as VisionDocumentId)
        if (!version || !version.content) {
          return { epics: [] }
        }
        const content = version.content as Record<string, unknown>
        const result = suggestEpicsFromVision(content)
        return {
          epics: result.epics,
          vision_document_id: doc.vision_document_id,
          version_number: version.version_number,
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

  /** List messages for an active vision session (polling fallback + initial load). */
  listMessages: publicProcedure
    .input(z.object({
      vision_session_id: z.string(),
      limit: z.number().int().min(1).max(500).optional().default(200),
    }))
    .query(async ({ input }) => {
      try {
        const svc = await getVisionService()
        const messages = await svc.listMessages(
          input.vision_session_id as VisionSessionId,
          input.limit,
        )
        return { items: messages }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),
})
