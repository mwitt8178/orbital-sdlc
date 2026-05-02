/**
 * pre-status-transition.ts — Baseline pre-status-transition hook.
 *
 * Per TRD-09 §8.2 and task spec:
 * - Validates justification field (>= 12 characters) per Primitives §14.
 * - Validates allowed state transitions per Primitives §13 for each aggregate type.
 * - Error code: HOOK_REJECTED_STATUS_TRANSITION_NO_JUSTIFICATION
 *
 * Pure function: no network, no file I/O.
 */

import { z } from 'zod'
import { defineHook } from '../types.js'

const PayloadSchema = z.object({
  aggregate_type: z.string(),
  aggregate_id: z.string(),
  from_state: z.string(),
  to_state: z.string(),
  justification: z.string().optional(),
})

// ---------------------------------------------------------------------------
// State machine definitions (Primitives §13)
// ---------------------------------------------------------------------------
// Allowed transitions: from_state → Set<to_state>

const TASK_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(['ready', 'blocked', 'failed']),
  ready: new Set(['in_progress', 'blocked', 'failed']),
  in_progress: new Set(['done', 'in_review', 'blocked', 'failed', 'escalated']),
  in_review: new Set(['done', 'in_progress', 'failed', 'escalated']),
  blocked: new Set(['ready', 'in_progress', 'failed', 'escalated']),
  failed: new Set(['pending', 'escalated']),
  escalated: new Set(['in_progress', 'done', 'failed']),
  done: new Set([]), // terminal — no outbound transitions
}

const SPRINT_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(['active']),
  active: new Set(['paused', 'completed', 'failed']),
  paused: new Set(['active', 'failed']),
  completed: new Set([]),
  failed: new Set([]),
}

const TICKET_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  open: new Set(['in_progress', 'closed', 'blocked']),
  in_progress: new Set(['open', 'blocked', 'closed']),
  blocked: new Set(['open', 'in_progress', 'closed']),
  closed: new Set([]),
}

const VISION_DOCUMENT_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  drafting: new Set(['locked']),
  locked: new Set(['revised']),
  revised: new Set(['locked']),
}

const CEREMONY_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  scheduled: new Set(['started', 'aborted']),
  started: new Set(['closed', 'aborted']),
  closed: new Set([]),
  aborted: new Set([]),
}

const CAPABILITY_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  issued: new Set(['revoked', 'expired']),
  revoked: new Set([]),
  expired: new Set([]),
}

const DISAGREEMENT_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  open: new Set(['assigned', 'resolved']),
  assigned: new Set(['resolved', 'open']),
  resolved: new Set([]),
}

const AGGREGATE_TRANSITIONS: Record<string, Record<string, ReadonlySet<string>>> = {
  task: TASK_TRANSITIONS,
  sprint: SPRINT_TRANSITIONS,
  ticket: TICKET_TRANSITIONS,
  vision_document: VISION_DOCUMENT_TRANSITIONS,
  ceremony: CEREMONY_TRANSITIONS,
  capability: CAPABILITY_TRANSITIONS,
  disagreement: DISAGREEMENT_TRANSITIONS,
}

export default defineHook({
  slug: 'status-transition-requires-justification',
  description:
    'Status transitions require a non-empty justification of at least 12 characters, and the transition must be valid for the aggregate type.',
  appliesTo: ['AgentStatusTransitioned', 'TicketStatusChanged'],
  timing: 'pre',
  declaredOrder: 100,
  errorCode: 'HOOK_REJECTED_STATUS_TRANSITION_NO_JUSTIFICATION',
  payloadSchema: PayloadSchema,
  validator: (payload) => {
    const parsed = PayloadSchema.safeParse(payload)
    if (!parsed.success) {
      return {
        allow: false,
        reason: `invalid transition payload: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      }
    }

    const { aggregate_type, from_state, to_state, justification } = parsed.data

    // Step 1: justification check (Primitives §14).
    if (!justification || justification.trim().length === 0) {
      return {
        allow: false,
        reason: 'status transition requires a justification of at least 12 characters',
      }
    }
    if (justification.trim().length < 12) {
      return {
        allow: false,
        reason: `status transition requires a justification of at least 12 characters (got ${justification.trim().length})`,
      }
    }

    // Step 2: validate transition is allowed for known aggregate types.
    const transitionMap = AGGREGATE_TRANSITIONS[aggregate_type]
    if (!transitionMap) {
      // Unknown aggregate_type: pass through (hook only validates known types).
      return { allow: true }
    }

    const allowedTargets = transitionMap[from_state]
    if (!allowedTargets) {
      return {
        allow: false,
        reason: `invalid state transition: '${from_state}' is not a known state for ${aggregate_type}`,
      }
    }

    if (!allowedTargets.has(to_state)) {
      return {
        allow: false,
        reason: `invalid state transition: ${aggregate_type} cannot go from '${from_state}' to '${to_state}'`,
      }
    }

    return { allow: true }
  },
})
