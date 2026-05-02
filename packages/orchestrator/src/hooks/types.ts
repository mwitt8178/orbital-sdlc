/**
 * hooks/types.ts — Zod schemas and TypeScript types for the Hook Engine.
 *
 * Per TRD-09 §6.2.1 (HookEngine.validate), §12.1 (HookSpec format), §5 (events).
 *
 * All hooks are pure functions: no network, no file I/O, no non-deterministic reads.
 * The HookEngine calls them synchronously (they may return a microtask, but no
 * real async I/O is permitted per §12.4).
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Actor type for hook context (matches Primitives §5)
// ---------------------------------------------------------------------------

const ActorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('persona'),
    persona_id: z.string(),
    session_id: z.string(),
    task_id: z.string().optional(),
  }),
  z.object({
    type: z.literal('user'),
    user_id: z.string(),
    install_id: z.string(),
  }),
  z.object({
    type: z.literal('system'),
    component: z.enum([
      'orchestrator',
      'scheduler',
      'mcp_gateway',
      'capability_authority',
      'audit_service',
      'retro_service',
      'reconciler',
      'hook_engine',
      // Mirrors the canonical Actor enum addition for the agent-native
      // CeremonyScheduler. Keep in sync with packages/types/src/actor.ts.
      'ceremony_scheduler',
    ]),
  }),
  z.object({
    type: z.literal('hook'),
    hook_id: z.string(),
    hook_version: z.string(),
  }),
])

export type HookActor = z.infer<typeof ActorSchema>

// ---------------------------------------------------------------------------
// HookContext — passed to every hook validator
// ---------------------------------------------------------------------------

export const HookContextSchema = z.object({
  trace_id: z.string(),
  parent_event_id: z.string().optional(),
  capability_id: z.string().optional(),
  actor: ActorSchema,
})

export type HookContext = z.infer<typeof HookContextSchema>

// ---------------------------------------------------------------------------
// HookDecision — what a validator returns
// ---------------------------------------------------------------------------

export const HookDecisionSchema = z.discriminatedUnion('allow', [
  z.object({ allow: z.literal(true) }),
  z.object({
    allow: z.literal(false),
    reason: z.string().min(1),
  }),
])

export type HookDecision = z.infer<typeof HookDecisionSchema>

// ---------------------------------------------------------------------------
// HookDefinition — the runtime-registered form (loaded from HookSpec)
// ---------------------------------------------------------------------------

export interface HookDefinition {
  hook_id: string
  hook_version_id: string
  slug: string
  description: string
  applies_to: readonly string[]
  timing: 'pre' | 'post'
  declared_order: number
  error_code: string
  enabled: boolean
  /** Pure synchronous validator. May return a microtask but no real I/O. */
  validator: (payload: unknown, context: HookContext) => HookDecision | Promise<HookDecision>
}

// ---------------------------------------------------------------------------
// HookSpec — the static definition exported from config/hooks/*.ts
// ---------------------------------------------------------------------------

export interface HookSpec<TPayloadSchema extends z.ZodTypeAny> {
  slug: string
  description: string
  appliesTo: readonly string[]
  timing: 'pre' | 'post'
  declaredOrder: number
  errorCode: string
  payloadSchema: TPayloadSchema
  validator: (
    payload: z.infer<TPayloadSchema>,
    context: HookContext,
  ) => HookDecision | Promise<HookDecision>
  testFixturesPath?: string
}

/**
 * defineHook — type helper for hook spec definition.
 * Validates the spec shape at definition time.
 */
export function defineHook<T extends z.ZodTypeAny>(spec: HookSpec<T>): HookSpec<T> {
  if (!spec.slug || typeof spec.slug !== 'string') {
    throw new Error('defineHook: slug is required')
  }
  if (!spec.appliesTo || spec.appliesTo.length === 0) {
    throw new Error('defineHook: appliesTo must be a non-empty array')
  }
  if (!spec.errorCode.startsWith('HOOK_REJECTED_')) {
    throw new Error(`defineHook: errorCode must start with HOOK_REJECTED_, got: ${spec.errorCode}`)
  }
  return spec
}

// ---------------------------------------------------------------------------
// HookEngineDecision — what HookEngine.fire() returns
// ---------------------------------------------------------------------------

export type HookEngineDecision =
  | { allow: true }
  | {
      allow: false
      reason: string
      error_code: string
      hook_id: string
      hook_slug: string
      invocation_id: string
    }

// ---------------------------------------------------------------------------
// Event payload schemas (TRD-09 §5.1)
// ---------------------------------------------------------------------------

export const HookFiredPayloadV1 = z.object({
  schema_version: z.literal(1),
  hook_id: z.string(),
  hook_version_id: z.string(),
  hook_slug: z.string(),
  event_type_intercepted: z.string(),
  timing: z.enum(['pre', 'post']),
  decision: z.enum(['allow', 'reject']),
  duration_ms: z.number().int().nonnegative(),
  invocation_id: z.string(),
  payload_digest: z.string(),
  parent_event_id: z.string().optional(),
})

export const HookPassedPayloadV1 = z.object({
  schema_version: z.literal(1),
  invocation_id: z.string(),
  hook_id: z.string(),
  hook_slug: z.string(),
  event_type_intercepted: z.string(),
  timing: z.enum(['pre', 'post']),
})

export const HookRejectedPayloadV1 = z.object({
  schema_version: z.literal(1),
  invocation_id: z.string(),
  hook_id: z.string(),
  hook_slug: z.string(),
  event_type_intercepted: z.string(),
  timing: z.enum(['pre', 'post']),
  reason: z.string().min(1),
  error_code: z.string(),
  rejected_actor: z.any(),
})

export const VerifierStartedPayloadV1 = z.object({
  schema_version: z.literal(1),
  verification_id: z.string(),
  task_id: z.string(),
  ticket_id: z.string(),
  verifier_session_id: z.string(),
  ac_count: z.number().int().positive(),
})

export const VerifierPassedPayloadV1 = z.object({
  schema_version: z.literal(1),
  verification_id: z.string(),
  task_id: z.string(),
  ticket_id: z.string(),
  ac_pass_count: z.number().int().positive(),
  duration_ms: z.number().int().nonnegative(),
})

export const VerifierFailedPayloadV1 = z.object({
  schema_version: z.literal(1),
  verification_id: z.string(),
  task_id: z.string(),
  ticket_id: z.string(),
  failed_ac_indices: z.array(z.number().int().positive()).min(1),
  feedback_summary: z.string(),
  duration_ms: z.number().int().nonnegative(),
})

export const VerifierAmbiguousPayloadV1 = z.object({
  schema_version: z.literal(1),
  verification_id: z.string(),
  task_id: z.string(),
  ticket_id: z.string(),
  ambiguous_ac_indices: z.array(z.number().int().positive()).min(1),
  resolution_path: z.enum(['escalated_to_persona', 'escalated_to_user']),
  escalation_target: z.string(),
})

export type HookFiredPayload = z.infer<typeof HookFiredPayloadV1>
export type HookPassedPayload = z.infer<typeof HookPassedPayloadV1>
export type HookRejectedPayload = z.infer<typeof HookRejectedPayloadV1>
export type VerifierStartedPayload = z.infer<typeof VerifierStartedPayloadV1>
export type VerifierPassedPayload = z.infer<typeof VerifierPassedPayloadV1>
export type VerifierFailedPayload = z.infer<typeof VerifierFailedPayloadV1>
export type VerifierAmbiguousPayload = z.infer<typeof VerifierAmbiguousPayloadV1>

// ---------------------------------------------------------------------------
// Verification result schemas (TRD-09 §10.4)
// ---------------------------------------------------------------------------

export const VerificationResultEnvelopeSchema = z.object({
  ac_index: z.number().int().positive(),
  ac_text: z.string().min(1),
  verdict: z.enum(['pass', 'fail', 'ambiguous']),
  reason: z.string().min(1),
  evidence_refs: z.array(
    z.object({
      type: z.enum(['file', 'test_result', 'log_line', 'channel_post']),
      ref: z.string(),
      excerpt: z.string().optional(),
    }),
  ),
})

export const VerificationSubmissionSchema = z.object({
  verification_id: z.string(),
  results: z.array(VerificationResultEnvelopeSchema).min(1),
  summary: z.string().min(1),
})

export type VerificationResultEnvelope = z.infer<typeof VerificationResultEnvelopeSchema>
export type VerificationSubmission = z.infer<typeof VerificationSubmissionSchema>
